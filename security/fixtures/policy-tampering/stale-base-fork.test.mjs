// Stale-base fork governance — the `policy-tampering` surface.
//
// A pull-request payload is a fork-authored artifact: its `base.sha` is the
// base branch's tip at PR-creation time, which is stale by the time the run
// starts. If the action pinned its policy read to that payload sha, a fork
// that opened a PR against an old tip could be governed by a policy file it
// no longer matches. The enforced invariant: a `pull_request` run resolves
// the LIVE tip of `pull_request.base.ref` and every policy read lands at
// that live sha — the payload's `base.sha` never becomes the pin.
//
// Second attack: the target branch has been deleted mid-run. The only honest
// outcome is a typed `PolicyResolutionError` raised BEFORE any model call —
// a run that already committed to a model is a run that might act without
// governance. Both invariants are pinned by driving the REAL
// `resolvePolicySource` / `policyReader` and the real `run`; only the forge
// is faked.
//
// Deterministic and offline: no network, no model, no timers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfigFile } from "#core/config-file.mjs";
import { PolicyResolutionError, policyReader, resolvePolicySource } from "#core/policy.mjs";
import { readContext } from "#core/runtime.mjs";
import { createEvidence } from "#core/untrusted.mjs";
import { readInputs, run } from "../../../triage/src/index.mjs";

/** The live tip of `main` — the only sha a policy read may be pinned to. */
const LIVE_SHA = "a".repeat(40);
/** The payload's creation-time base sha — stale, must never become the pin. */
const STALE_SHA = "b".repeat(40);
const CONFIG_PATH = ".github/action-agents/triage/triage.json5";
const BRANCH = "main";
const VALID_POLICY = '{"schemaVersion": 1, "labels": {}}';

/**
 * A forge double whose `getRef` reports the live tip and whose `getContents`
 * records every read's `{ ref }`, so a test can assert exactly which sha a
 * policy file's content came from.
 *
 * @param {{ deletedBranch?: boolean }} [options]
 * @returns {{ forge: any, contents: { path: string, ref: string | undefined }[] }}
 */
function fakeForge({ deletedBranch = false } = {}) {
  /** @type {{ path: string, ref: string | undefined }[]} */
  const contents = [];
  const forge = {
    async getRepository() {
      return { defaultBranch: BRANCH, name: "action-agents", description: "" };
    },
    async getRef(_branch) {
      if (deletedBranch) {
        const error = new Error("branch not found");
        error.status = 404;
        throw error;
      }
      return { sha: LIVE_SHA };
    },
    async getContents(path, options) {
      contents.push({ path, ref: options?.ref });
      if (path !== CONFIG_PATH) return null;
      return { content: VALID_POLICY };
    },
  };
  return { forge, contents };
}

/** A pull_request payload whose `base.sha` is deliberately stale and which
 * carries a runnable thread shape (number + title). */
const STALE_PAYLOAD = {
  pull_request: {
    number: 1,
    title: "fork change",
    base: { ref: BRANCH, sha: STALE_SHA },
  },
};

describe("a fork PR's stale base sha never governs the policy read", () => {
  it("resolvePolicySource pins to the LIVE tip sha, never the stale payload sha", async () => {
    const { forge } = fakeForge();
    const source = await resolvePolicySource({
      eventName: "pull_request",
      event: STALE_PAYLOAD,
      forge,
    });
    assert.equal(source.basis, "base");
    assert.equal(source.branch, BRANCH);
    assert.equal(source.sha, LIVE_SHA, "the live tip governs, not the stale payload sha");
    assert.notEqual(source.sha, STALE_SHA);
  });

  it("policy content is read from the live tip sha through the pinned reader", async () => {
    const { forge, contents } = fakeForge();
    const source = await resolvePolicySource({
      eventName: "pull_request",
      event: STALE_PAYLOAD,
      forge,
    });
    const policy = { getContents: policyReader(forge, source) };
    const loaded = await loadConfigFile({
      forge: policy,
      configPath: CONFIG_PATH,
      source,
      locations: [],
      supportedMajor: 1,
    });
    assert.equal(loaded.path, CONFIG_PATH);
    assert.equal(loaded.raw?.schemaVersion, 1);
    // Every getContents for the config must have been pinned to the live tip.
    const configRead = contents.find((entry) => entry.path === CONFIG_PATH);
    assert.ok(configRead, "the config file must have been read");
    assert.equal(configRead.ref, LIVE_SHA, "the read must be pinned to the live tip");
    assert.notEqual(configRead.ref, STALE_SHA);
  });
});

describe("a deleted target branch refuses at governance resolution, before any model call", () => {
  it("run raises PolicyResolutionError and never drives the chat seam", async () => {
    const { forge } = fakeForge({ deletedBranch: true });
    /** @type {{ model?: string, messages?: unknown }[]} */
    const chatCalls = [];
    const context = readContext({
      ...process.env,
      GITHUB_REPOSITORY: "ecoma-io/action-agents",
      GITHUB_WORKSPACE: "/work",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: "/work/event.json",
      "INPUT_GITHUB-TOKEN": "ghs_x",
      "INPUT_API-URL": "https://api.example/v1",
      "INPUT_API-KEY": "sk-secret",
      INPUT_MODEL: "gpt-x",
    });
    // GITHUB_REPOSITORY comes from the runner env; readContext requires it.
    const inputs = readInputs({
      ...process.env,
      "INPUT_GITHUB-TOKEN": "ghs_x",
      "INPUT_API-URL": "https://api.example/v1",
      "INPUT_API-KEY": "sk-secret",
      INPUT_MODEL: "gpt-x",
    });

    const io = {
      forge,
      readEvent: async () => STALE_PAYLOAD,
      chat: {
        complete: async (ask) => {
          chatCalls.push({
            model: /** @type {{ model?: string }} */ (ask)?.model,
            messages: /** @type {{ messages?: unknown }} */ (ask)?.messages,
          });
          return { content: '{"labels":["bug"]}', toolCalls: [], finishReason: undefined };
        },
      },
      evidence: createEvidence(() => "x".repeat(8)),
      now: () => Date.parse("2026-07-01T11:00:00Z"),
    };

    const error = await run(inputs, context, io).then(
      () => assert.fail("a deleted target branch must refuse the run"),
      (e) => e,
    );
    assert.ok(error instanceof PolicyResolutionError, "expected a PolicyResolutionError");
    assert.match(error.message, /tip of branch|no policy source/);
    assert.equal(
      chatCalls.length,
      0,
      "no model call may happen before the governance line is resolved",
    );
  });
});
