// Answer byte caps — a hostile model's answer sized to defeat resource
// ceilings, attacked at the two independent bounds a run must hold.
//
// Attack: the model answers a translation request with a huge document (here
// 2 MiB), hoping the action either buffers it whole or truncates it silently;
// at the transport, a chat-completions response body over the byte cap tests
// whether the seam buffers a giant body before judging it.
//   -> capability must remain bounded: `judgeAnswer`
//      (`harmonise/src/plan.mjs`) refuses an answer past
//      `MAX_SOURCE_BYTES` (32 KiB) fail-closed — the pair exits red, the
//      answer is never written to the forge, and a refusal is never retried
//      (`harmonise/src/recovery.mjs`). Below that, the transport refuses a
//      response past `DEFAULT_MAX_BODY_BYTES` (1 MiB,
//      `core/transport/http.mjs`) while the body streams — before it is ever
//      assembled — with the typed `BodyTooLargeError`, and the run's own
//      recovery policy spends exactly its declared retries on it.
//
// Pinned at both depths: the harmonise answer cap through one real `run()`
// on a scripted chat, and the transport cap both directly (real `createChat`
// over a scripted fetch) and end-to-end through a real `run()` whose chat
// client is built over the scripted fetch. Deterministic and offline.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createChat } from "#core/chat.mjs";
import { BranchMovedError, isRefAbsentError } from "#core/forge.mjs";
import { BodyTooLargeError } from "#core/transport-errors.mjs";

import { readInputs, run } from "../../../harmonise/src/index.mjs";
import { MAX_SOURCE_BYTES } from "../../../harmonise/src/plan.mjs";
import { DEFAULT_POLICY } from "../../../harmonise/src/recovery.mjs";

/**
 * A real event payload file on disk: the default `readEvent` in the entry
 * point parses this exact file, as it would in a runner.
 */
const EVENT_PATH = (() => {
  const dir = mkdtempSync(join(tmpdir(), "harmonise-adversarial-event-"));
  const path = join(dir, "event.json");
  writeFileSync(path, JSON.stringify({ ref: "refs/heads/main" }));
  return path;
})();

/** The runner environment the fixtures execute under: en, one target (vi). */
const runner = {
  "INPUT_GITHUB-TOKEN": "ghs_x",
  "INPUT_API-URL": "https://api.example/v1",
  "INPUT_API-KEY": "sk-secret",
  INPUT_MODEL: "gpt-x",
  GITHUB_REPOSITORY: "ecoma-io/action-agents",
  GITHUB_WORKSPACE: "/work",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_EVENT_PATH: EVENT_PATH,
  "INPUT_SOURCE-LANGUAGE": "en",
};

const CONFIG_PATH = ".github/action-agents/harmonise/harmonise.json5";

/**
 * The harmonise config document the fixture works against: one source
 * language, one target language, a plain manual/ map.
 *
 * @returns {string}
 */
function makeConfig() {
  return JSON.stringify(
    {
      sourceLanguage: "en",
      languages: { en: "manual/{document}.md", vi: "manual/vi/{document}.md" },
    },
    null,
    2,
  );
}

/**
 * The repository content a forge double serves: the config at its one real
 * path plus the source document.
 *
 * @returns {Record<string, string>} path -> bytes
 */
function makeRepo() {
  return {
    [CONFIG_PATH]: makeConfig(),
    "manual/dev.md": "# Dev\n\nProse.\n",
  };
}

/**
 * The branch tree a forge double reports: every named path as a blob.
 *
 * @param {string[]} paths
 * @returns {{ path: string, type: string }[]}
 */
function makeInventory(paths) {
  return paths.map((path) => ({ path, type: "blob" }));
}

/**
 * A forge double whose whole write surface records into `writes` and whose
 * reads answer from `files` — the real Git integration is never exercised.
 *
 * @param {Record<string, string>} files
 * @param {{ path: string, type: string }[]} [tree]
 * @returns {{ writes: { op: string, args: unknown[] }[], baseSha: string } & Record<string, (...args: unknown[]) => Promise<unknown>>}
 */
function forge(
  files,
  tree = makeInventory(["manual/dev.md", "manual/vi/dev.md"]),
  /** @type {{ branches?: Record<string, { sha: string, files: Record<string, string> }> }} */ options = {},
) {
  const branches = /** @type {Record<string, { sha: string, files: Record<string, string> }>} */ (
    options.branches ?? {}
  );
  const baseSha = "a".repeat(40);
  /** @type {{ op: string, args: unknown[] }[]} */
  const writes = [];
  let blobSeq = 0;
  return /** @type {any} */ ({
    writes,
    baseSha,
    /** @param {string} path @param {{ ref?: string }} [opts] */
    async getContents(path, opts = {}) {
      const ref = opts.ref;
      const branch =
        ref !== undefined
          ? Object.values(branches).find((candidate) => candidate.sha === ref)
          : undefined;
      const source = branch !== undefined ? branch.files : files;
      const content = source[path];
      return content === undefined ? null : { content };
    },
    async getRepository() {
      return { defaultBranch: "main", name: "action-agents", description: "AI GitHub Actions" };
    },
    /** @param {string} name */
    async getRef(name) {
      const branch = branches[name];
      return branch !== undefined ? { sha: branch.sha } : { sha: baseSha };
    },
    /** @param {string} name */
    async readRef(name) {
      try {
        return await this.getRef(name);
      } catch (cause) {
        if (isRefAbsentError(cause)) return null;
        throw cause;
      }
    },
    /** @param {string} _sha */
    async listTree(_sha) {
      return tree;
    },
    /** @param {string} content */
    async createBlob(content) {
      writes.push({ op: "createBlob", args: [content] });
      blobSeq++;
      return { sha: `blob${String(blobSeq).padStart(38, "0")}` };
    },
    /** @param {string} base @param {{ path: string, blobSha: string }[]} changes */
    async createTree(base, changes) {
      writes.push({ op: "createTree", args: [base, changes] });
      return { sha: `tree-${base.slice(0, 4)}` };
    },
    /** @param {string} message @param {string} treeSha @param {string} parent */
    async createCommit(message, treeSha, parent) {
      writes.push({ op: "createCommit", args: [message, treeSha, parent] });
      return { sha: "c".repeat(40) };
    },
    /** @param {string} branch @param {string} commitSha @param {string | null} expectedCurrentSha */
    async upsertBranch(branch, commitSha, expectedCurrentSha) {
      const found = branches[branch]?.sha ?? baseSha;
      if (expectedCurrentSha !== null && expectedCurrentSha !== found) {
        throw new BranchMovedError(branch, expectedCurrentSha, found);
      }
      writes.push({ op: "upsertBranch", args: [branch, commitSha, expectedCurrentSha] });
      branches[branch] = { sha: commitSha, files: {} };
    },
    /** @param {{ base: string, head: string, title: string, body: string }} input */
    async upsertPullRequest(input) {
      writes.push({ op: "upsertPullRequest", args: [input] });
      return { number: 42, created: true };
    },
  });
}

/**
 * A chat double answering from a script of model contents, one per request;
 * the last answer repeats, which is what a retry loop meets.
 *
 * @param {(string | Error)[]} answers
 * @returns {{ calls: () => number, complete: (request: unknown) => Promise<{ content: string }> }}
 */
function chat(answers) {
  let cursor = 0;
  let calls = 0;
  return {
    calls: () => calls,
    /** @param {unknown} _request */
    async complete(_request) {
      const answer = answers[Math.min(cursor, answers.length - 1)];
      cursor++;
      calls++;
      if (answer instanceof Error) throw answer;
      return { content: /** @type {string} */ (answer) };
    },
  };
}

/**
 * A model answer proposing a translation, in the answer contract's JSON
 * shape.
 *
 * @param {string} content the proposed translation text
 * @returns {string}
 */
function proposes(content) {
  return JSON.stringify({ drift: true, summary: "kept in step", content });
}

/** The evidence wrapper, shaped exactly as the real createEvidence frames it. */
const evidence = {
  /** @param {string} label @param {string} content */
  wrap(label, content) {
    return `[${label}]\n${content}`;
  },
};

/**
 * @returns {{ owner: string, repo: string, eventName: string, eventPath: string, workspace: string, apiUrl: string }}
 */
function context() {
  return {
    owner: "ecoma-io",
    repo: "action-agents",
    eventName: "workflow_dispatch",
    eventPath: EVENT_PATH,
    workspace: "/work",
    apiUrl: "https://api.github.com",
  };
}

/**
 * A chat-completions body whose content alone is `contentBytes` of prose —
 * far past every cap this fixture pins.
 *
 * @param {number} contentBytes
 * @returns {string}
 */
function bloatedCompletionBody(contentBytes) {
  return JSON.stringify({
    choices: [{ message: { content: "a".repeat(contentBytes) } }],
  });
}

/**
 * A fresh ReadableStream of `text`, one chunk — a Response body the
 * transport's cap must read and judge while it streams.
 *
 * @param {string} text
 * @returns {ReadableStream<Uint8Array>}
 */
function streamOf(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("harmonise — answer byte caps hold", () => {
  it("refuses a model answer past the 32 KiB translation cap: one call, no writes", async () => {
    // The ceiling the harness pins: exactly the constant `judgeAnswer`
    // enforces, so the refusal below is the documented bound, not a guess.
    assert.equal(MAX_SOURCE_BYTES, 32 * 2 ** 10);

    const forgeDouble = forge(makeRepo());
    const chatDouble = chat([proposes("a".repeat(2 * 2 ** 20))]);
    const ioDouble = { forge: forgeDouble, chat: chatDouble, evidence };

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );

    // Fail-closed, never truncated, never retried: the pair exits red naming
    // the cap, exactly one model call was spent, and zero forge writes ever
    // happened — a huge answer cannot flush a blob.
    assert.match(String(error), /past the 32768-byte cap/);
    assert.match(String(error), /every pair failed/);
    assert.equal(chatDouble.calls(), 1);
    assert.equal(forgeDouble.writes.length, 0);
  });

  it("the transport refuses a multi-MB chat body past the 1 MiB cap, typed", async () => {
    const payload = bloatedCompletionBody(2 * 2 ** 20);
    const fetchImpl = /** @type {typeof globalThis.fetch} */ (
      async () =>
        new Response(streamOf(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    const model = createChat({
      apiUrl: "https://api.example/v1",
      apiKey: "sk-secret",
      fetchImpl,
      timeoutMs: 5_000,
    });

    const error = await model
      .complete({ model: "gpt-x", messages: [{ role: "user", content: "x" }] })
      .catch((cause) => cause);

    // The cap is the client's default: `DEFAULT_MAX_BODY_BYTES` (2**20) in
    // core/transport/http.mjs, surfaced through the seam door as the typed
    // BodyTooLargeError — distinguishable from a network failure, and
    // refused before the giant body is ever assembled.
    assert.ok(error instanceof BodyTooLargeError, "expected the typed body-cap refusal");
    assert.match(String(error), /1048576-byte cap/);
  });

  it("the same transport cap holds end-to-end inside a real harmonise run", async () => {
    // The run-level policy that decides how many attempts a body-cap
    // failure spends: the transport refuses BodyTooLargeError without
    // retrying it, and harmonise classifies it `unknown`, spending exactly
    // this declared retry budget.
    assert.equal(DEFAULT_POLICY.unknown.retries, 1);

    const payload = bloatedCompletionBody(2 * 2 ** 20);
    let fetchCalls = 0;
    const fetchImpl = /** @type {typeof globalThis.fetch} */ (
      async () => {
        fetchCalls++;
        // A fresh stream per attempt: a Response body is single-use.
        return new Response(streamOf(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    );
    const forgeDouble = forge(makeRepo());

    // No `chat` override: `realIo` builds the real chat client over the
    // scripted fetch, so this is the transport cap exercised by a genuine
    // harmonise translation call.
    const error = await run(
      { ...readInputs(runner), dryRun: false },
      context(),
      /** @type {any} */ ({
        forge: forgeDouble,
        evidence,
        sleep: async () => {},
        fetchImpl,
      }),
    ).catch((cause) => cause);

    assert.match(String(error), /exceeds the 1048576-byte cap/);
    assert.match(String(error), /every pair failed/);
    // The refusal was not retried at the transport, and the run spent
    // exactly the one optimistic retry its policy declares for `unknown`.
    assert.equal(fetchCalls, DEFAULT_POLICY.unknown.retries + 1);
    assert.equal(forgeDouble.writes.length, 0);
  });
});
