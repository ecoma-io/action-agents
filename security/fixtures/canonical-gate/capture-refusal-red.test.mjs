// Capture refusal — the evidence boundary refuses, and the run goes red.
//
// Attack: a compromised or hallucinating model anchors a finding on a line
// that the checked-out tree does not spell. Between anchor validation and
// the capture boundary the reviewed bytes are the only witness that can
// confirm the finding's evidence — so a divergence between what the answer
// named and what the tree carries must refuse the run, never skip the
// capture and publish a finding whose digest confirms nothing. The window
// is real: the checkout can shrink under a run (a rebase, a forced push
// re-checkout, a concurrent `git clean`), and validation saw the old bytes.
// This fixture manufactures exactly that divergence — the scripted verdict
// turn deletes the anchored file's lines synchronously, the one honest way
// to move the tree between validation and capture — and pins the bounded
// outcome end to end: `reviewPullRequest` throws the typed deterministic
// refusal naming file and line, and nothing is written — the comment that
// would have carried the unconfirmed finding never lands. The run ends
// refused per the failure taxonomy; a refused capture refuses the finding's
// evidence, and a finding without a digest is not confirmed by anything.
//
// Deterministic and offline: a temp workspace, a scripted model, a
// recording forge.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { reviewPullRequest } from "../../../review/src/run.mjs";
import { DeterministicRefusalError } from "../../../review/src/refusal.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const INPUTS = {
  model: "review",
  maxTurns: 5,
  contextWindow: 128_000,
  dryRun: false,
  configPath: "",
};

const CONTEXT = { owner: "acme", repo: "widgets", workspace: "" }; // set per world

const EVENT = {
  action: "synchronize",
  pull_request: { number: 7, base: { ref: "main", sha: "8".repeat(40) } },
};

/** One temp root per world; every run's workspace has somewhere to land. */
const roots = [];

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A workspace whose reviewed file spells three lines — as validation saw it. */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "capture-refusal-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.mjs"), "line1\nline2\nline3\n");
  CONTEXT.workspace = root;
  return root;
}

/** A forge stub covering the reads a full happy-path run makes. */
function forgeStub() {
  const calls = {
    /** @type {Array<{ id?: number, body?: string }>} */
    upserts: [],
  };
  return {
    calls,
    async getPullRequest() {
      return {
        number: 7,
        state: "open",
        draft: false,
        merged: false,
        title: "the change",
        body: "",
        mergeable: true,
        mergeableState: "clean",
        labels: [],
        head: { ref: "feature", sha: HEAD },
        base: { ref: "main", sha: BASE },
      };
    },
    async getRepository() {
      return { defaultBranch: "main", name: "widgets", description: "" };
    },
    async getRef(branch) {
      assert.equal(branch, "main");
      return { sha: "7".repeat(40) };
    },
    async getContents(path) {
      if (path.endsWith("review.json5") || path.endsWith("review.json")) return null;
      return null;
    },
    async listPullRequestFiles() {
      return [
        {
          filename: "src/a.mjs",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1 +1,2 @@\n+x",
        },
      ];
    },
    async listComments() {
      return [];
    },
    async whoami() {
      return { login: "github-actions[bot]" };
    },
    async createComment(_number, body) {
      calls.upserts.push({ body });
      return { id: 101 };
    },
    async updateComment() {},
    async deleteComment() {},
    async createCheckRun() {
      return { id: 501 };
    },
  };
}

describe("the capture boundary refuses a finding the tree does not spell", () => {
  it("a checkout that shrinks under the run refuses it red — naming file and line, writing nothing", async () => {
    const workspace = makeWorkspace();
    const forge = forgeStub();
    /** @type {string[][]} */
    const turns = [];
    let turn = 0;
    const chat = {
      async complete() {
        turn++;
        if (turn === 1) {
          return {
            content: "",
            toolCalls: [{ id: "r1", name: "read_file", arguments: '{"path":"src/a.mjs"}' }],
            finishReason: "tool_calls",
          };
        }
        if (turn === 2) {
          return {
            content:
              '{"findings":[{"severity":"concern","kind":"correctness","file":"src/a.mjs","line":2,"message":"off-by-one"}],"summary":"one concern"}',
            toolCalls: [],
            finishReason: "stop",
          };
        }
        // The verdict turn moves the tree: by the time the run reaches the
        // capture boundary, the anchor the answer named no longer exists.
        writeFileSync(join(workspace, "src", "a.mjs"), "line1\n");
        turns.push([]);
        return {
          content: '{"verdict":"confirmed","kind":"correctness","reason":"the guard is real"}',
          toolCalls: [],
          finishReason: "stop",
        };
      },
    };
    await assert.rejects(
      reviewPullRequest({
        inputs: INPUTS,
        context: CONTEXT,
        pullRequestNumber: 7,
        eventName: "pull_request",
        event: EVENT,
        io: { forge, chat, now: () => 0, info: () => undefined },
      }),
      (error) => {
        assert.ok(error instanceof DeterministicRefusalError);
        // The refusal names the anchor — file and line — never a paraphrase.
        assert.match(
          /** @type {Error} */ (error).message,
          /capture refused for src\/a\.mjs:2 — the reviewed file carries 1 line/,
        );
        return true;
      },
    );
    // The unconfirmed finding never reached a surface: no comment stands.
    assert.deepEqual(forge.calls.upserts, []);
  });
});
