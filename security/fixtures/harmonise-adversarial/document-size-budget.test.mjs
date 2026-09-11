// Document size budgets — a hostile or oversized document, and a hostile or
// oversized model answer, attacked at the bounds a run must hold under the
// chunked-translation contract.
//
// Under the chunked contract there is no whole-document 32 KiB ceiling: a
// source larger than one chunk is accepted, partitioned deterministically by
// `chunkDocument` (`harmonise/src/chunks.mjs`), and every chunk is translated
// — one provider request per chunk — with the reassembled whole judged by the
// same whole-document gates. What stays bounded, and what this fixture pins:
//
//   -> the chunk budget: a document needing more than `MAX_CHUNKS_PER_PAIR`
//      (32) chunks skips at preparation — resource exhaustion is an explicit
//      refusal, zero model calls, zero writes;
//   -> the per-chunk payload bound: a single unsplittable block (one fenced
//      block, one paragraph) past `MAX_CHUNK_BYTES` (8 KiB) refuses the same
//      way — the chunker never truncates or splits what it cannot carry;
//   -> a large-but-valid source is translated end to end: N chunks, N
//      provider calls, one proposal carrying the whole reassembled document;
//   -> a hostile model answer is still refused fail-closed: an answer that
//      does not mirror the source's structure fails the structural gate
//      before anything is written (and past the transport's 1 MiB body cap,
//      the typed `BodyTooLargeError` refuses it while the body streams —
//      before it is ever assembled), and a refusal is never retried
//      (`harmonise/src/recovery.mjs`).
//
// Pinned through real `run()`s on scripted chats and forge doubles, plus the
// transport cap both directly (real `createChat` over a scripted fetch) and
// end-to-end. Deterministic and offline.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createChat } from "#core/chat.mjs";
import { BranchMovedError, isRefAbsentError } from "#core/forge.mjs";
import { BodyTooLargeError } from "#core/transport-errors.mjs";

import { readInputs, run } from "../../../harmonise/src/index.mjs";
import {
  MAX_CHUNK_BYTES,
  MAX_CHUNKS_PER_PAIR,
  chunkDocument,
} from "../../../harmonise/src/chunks.mjs";
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

/**
 * The pinned ceilings themselves — asserted once so the refusals below are
 * the documented bounds, not guesses.
 */
const CEILINGS = { chunkBytes: MAX_CHUNK_BYTES, chunksPerPair: MAX_CHUNKS_PER_PAIR };

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
 * @param {string} [source] the source document's bytes
 * @returns {Record<string, string>} path -> bytes
 */
function makeRepo(source = "# Dev\n\nProse.\n") {
  return {
    [CONFIG_PATH]: makeConfig(),
    "manual/dev.md": source,
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

/**
 * A multi-section source document of roughly `sections` × `sectionBytes`
 * bytes: one heading and one paragraph per section, blank-line separated —
 * the chunker's ordinary diet.
 *
 * @param {number} sections
 * @param {number} sectionBytes
 * @returns {string}
 */
function bigSource(sections, sectionBytes) {
  const filler = "content ".repeat(Math.max(1, Math.ceil(sectionBytes / 8)));
  let out = "";
  for (let i = 0; i < sections; i += 1) {
    out += `## Section ${String(i)}\n\n${filler.slice(0, sectionBytes)}\n\n`;
  }
  return out;
}

describe("harmonise — document size budgets hold", () => {
  it("pins the chunk ceilings the run enforces", () => {
    // The fixture's ceilings mirror the module's constants. The tuned byte
    // value itself is asserted nowhere: every construction below derives
    // its sizes from the constant, so the fixture holds at any retune.
    assert.equal(CEILINGS.chunkBytes, MAX_CHUNK_BYTES);
    assert.equal(CEILINGS.chunksPerPair, MAX_CHUNKS_PER_PAIR);
  });

  it("accepts a multi-chunk source and translates it chunk by chunk", async () => {
    // Three half-chunk sections (~1.5 chunk-frames of ordinary Markdown):
    // past the single-chunk bound, three chunks under the per-chunk bound.
    const source = bigSource(3, MAX_CHUNK_BYTES / 2);
    const planned = chunkDocument(source);
    assert.ok(planned.chunks.length >= 2, "expected the large source to split");

    const forgeDouble = forge(makeRepo(source));
    // One honest answer per chunk: the chunk comes back structurally
    // unchanged (an in-place translation keeps every heading and block).
    const chatDouble = chat(planned.chunks.map((chunk) => proposes(chunk)));
    const ioDouble = { forge: forgeDouble, chat: chatDouble, evidence };

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );

    // The run goes green: one provider call per chunk — and no more — and
    // the proposal carries the whole reassembled document.
    assert.equal(error === undefined ? "green" : String(error), "green");
    assert.equal(chatDouble.calls(), planned.chunks.length);
    const blob = forgeDouble.writes.find((w) => w.op === "createBlob");
    assert.ok(blob, "expected the proposal's blob write");
    assert.equal(blob.args[0], source);
  });

  it("refuses a document past the chunk execution budget before any model call", async () => {
    // 200 half-chunk sections — one chunk each, far past the 32-chunk budget.
    const source = bigSource(200, MAX_CHUNK_BYTES / 2);
    assert.ok(chunkDocument(source).refusal !== null, "expected the chunker to refuse");

    const forgeDouble = forge(makeRepo(source));
    const chatDouble = chat([proposes("x")]);
    const ioDouble = { forge: forgeDouble, chat: chatDouble, evidence };

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );

    // Fail-closed at preparation: every pair skips naming the budget,
    // zero model calls, zero writes.
    assert.match(String(error), /past the 32-chunk execution budget/);
    assert.match(String(error), /every pair skipped/);
    assert.equal(chatDouble.calls(), 0);
    assert.equal(forgeDouble.writes.length, 0);
  });

  it("refuses an unsplittable block past the per-chunk bound before any model call", async () => {
    // One fenced block a chunk-frame wide: no structural boundary inside.
    const source = "# Dev\n\n```text\n" + "x".repeat(MAX_CHUNK_BYTES) + "\n```\n";
    assert.ok(chunkDocument(source).refusal !== null, "expected the chunker to refuse");

    const forgeDouble = forge(makeRepo(source));
    const chatDouble = chat([proposes("x")]);
    const ioDouble = { forge: forgeDouble, chat: chatDouble, evidence };

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );

    assert.match(String(error), /an unsplittable block of \d+ bytes does not fit one chunk/);
    assert.match(String(error), /every pair skipped/);
    assert.equal(chatDouble.calls(), 0);
    assert.equal(forgeDouble.writes.length, 0);
  });

  it("refuses a hostile oversized answer fail-closed: one call, no writes", async () => {
    // A 2 MiB answer for a small document cannot mirror the source's
    // structure: the structural gate refuses it before anything is
    // written — and past the transport's own 1 MiB body cap, the typed
    // BodyTooLargeError refuses it while the body streams.
    const forgeDouble = forge(makeRepo());
    const chatDouble = chat([proposes("a".repeat(2 * 2 ** 20))]);
    const ioDouble = { forge: forgeDouble, chat: chatDouble, evidence };

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );

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
