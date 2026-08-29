// Tests for the `harmonise` entry point.
//
// Three properties are pinned here that no later change may quietly drop:
//
//   1. **Refusals stay refusals.** A real-run request this build cannot honor,
//      an empty document set, a filter that narrows to nothing, every pair
//      failing or skipping — each goes red rather than green-on-nothing.
//   2. **The key is masked before anything can print it.**
//   3. **The report is honest about what it saw** — proposals, unchanged
//      documents, skipped and failed pairs and orphans each get their line,
//      and a failed pair's line names the recovery policy's verdict: a
//      contract refusal is never retried, a transport fault is retried
//      under the declared policy, an unknown failure once, and an auth
//      failure never.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatError } from "#core/chat.mjs";
import { BranchMovedError, ForgeError, isRefAbsentError } from "#core/forge.mjs";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  HttpError,
  TransportError,
} from "#core/transport-errors.mjs";

import { ACTION, DELAY_MS, main, readInputs, run } from "./index.mjs";
import { contentFingerprint, policyFingerprint, TRANSFORMATION_VERSION } from "./fingerprint.mjs";
import { LEGACY_STATE_PATH, renderState, statePath, STATE_SCHEMA_VERSION } from "./state.mjs";
import {
  buildTmKey,
  createTmStore,
  LEGACY_TM_PATH,
  parse as parseTm,
  serialize as serializeTm,
  tmPath,
  TM_SCHEMA_VERSION,
} from "./tm.mjs";
import { DEFAULT_POLICY, DELAY_CLASSES } from "./recovery.mjs";
import { MAX_SOURCE_BYTES } from "./plan.mjs";

/**
 * A real event payload file on disk: the default `readEvent` in the entry
 * point parses this exact file, as it would in a runner. A workflow_dispatch
 * against `refs/heads/main` — the payload the runner below names.
 */
const EVENT_PATH = (() => {
  const dir = mkdtempSync(join(tmpdir(), "harmonise-event-"));
  const path = join(dir, "event.json");
  writeFileSync(path, JSON.stringify({ ref: "refs/heads/main" }));
  return path;
})();

/**
 * @type {import("#core/runtime.mjs").Env}
 */
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

// The advisory paths this suite's fixtures use: the runner's source language
// is `en`, so the publishing branch `harmonise/en` owns the suffixed names.
const STATE_PATH = statePath("en");
const TM_PATH = tmPath("en");

/**
 * The policy digest every default-fixture config hashes to: an empty
 * glossary, no instruction prose, no per-language instructions, the current
 * pipeline version — exactly what `run` folds into its own policy digest.
 */
const POLICY = policyFingerprint({
  glossary: [],
  languageInstructions: {},
  transformationVersion: TRANSFORMATION_VERSION,
});

/**
 * The harmonise config document as text: the en→vi map every test works
 * against, narrowed or extended only by what the caller states.
 *
 * @param {{
 *   sourceLanguage?: string,
 *   languages?: Record<string, string>,
 *   glossary?: string[],
 *   pullRequest?: { title: string },
 *   concurrency?: number,
 * }} [overrides]
 * @returns {string} the document, parsed by the real config reader like any other
 */
function makeConfig(overrides = {}) {
  const config = {
    sourceLanguage: "en",
    languages: { en: "manual/{document}.md", vi: "manual/vi/{document}.md" },
    ...overrides,
  };
  return JSON.stringify(config, null, 2);
}

/**
 * The repository content a forge double serves: the config at its one real
 * path plus one source document, with whatever the caller adds or replaces.
 *
 * @param {{
 *   config?: string,
 *   documents?: Record<string, string>,
 *   state?: string,
 *   memory?: string,
 * }} [overrides]
 * @returns {Record<string, string>} path → bytes
 */
function makeRepo(overrides = {}) {
  /** @type {Record<string, string>} */
  const repo = {
    [CONFIG_PATH]: overrides.config ?? makeConfig(),
    "manual/dev.md": "# Dev\n\nProse.\n",
    ...overrides.documents,
  };
  if (overrides.state !== undefined) repo[STATE_PATH] = overrides.state;
  if (overrides.memory !== undefined) repo[TM_PATH] = overrides.memory;
  return repo;
}

/**
 * The branch tree a forge double reports: every named path as a blob, in the
 * order given.
 *
 * @param {string[]} paths
 * @returns {{ path: string, type: string }[]}
 */
function makeInventory(paths) {
  return paths.map((path) => ({ path, type: "blob" }));
}

/**
 * The state blob among a forge double's writes, found by its shape — the
 * one created blob carrying a `records` JSON document.
 *
 * @param {ReturnType<typeof forge>} forgeDouble
 * @returns {{ records: import("./state.mjs").SyncStateRecord[] }}
 */
function stateBlobOf(forgeDouble) {
  const write = /** @type {unknown} */ (
    forgeDouble.writes.find(
      (w) =>
        w.op === "createBlob" && typeof w.args[0] === "string" && w.args[0].includes('"records"'),
    )
  );
  return JSON.parse(/** @type {{ args: [string] }} */ (write).args[0]);
}
/**
 * A forge double carrying only the reads this build makes; the write surface
 * lands with the Git integration and stays unexercised here.
 *
 * @param {Record<string, string>} files
 * @param {{ path: string, type: string }[]} [tree]
 * @returns {import("#core/forge.mjs").Forge & { writes: { op: string, args: unknown[] }[], reads: { path: string, ref: string | undefined }[], refLookups: string[], baseSha: string }}
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
  /** @type {{ path: string, ref: string | undefined }[]} */
  const reads = [];
  /** @type {string[]} */
  const refLookups = [];
  let blobSeq = 0;
  return /** @type {any} */ ({
    writes,
    reads,
    refLookups,
    baseSha,
    /** @param {string} path @param {{ ref?: string }} [opts] */
    async getContents(path, opts = {}) {
      const ref = opts.ref;
      reads.push({ path, ref });
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
      refLookups.push(name);
      const branch = branches[name];
      return branch !== undefined ? { sha: branch.sha } : { sha: baseSha };
    },
    /**
     * The Forge contract's absence read, as the real client implements it:
     * delegate to `getRef` and convert the typed 404 to `null`. Declared on
     * the double itself, so a test that swaps `getRef` underneath is
     * observed through `readRef` exactly as the real client would observe
     * it — prose failures rethrown, only the typed 404 read as absent.
     *
     * @param {string} name
     */
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
      // The optimistic lock, as core/forge runs it: "found" is the branch's
      // current tip, or the default branch's tip when the branch does not
      // exist yet — the same value getRef fabricates for a missing branch. A
      // stale expectation is refused before the write is recorded; a match
      // moves the tip this double serves to later reads.
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
 * A chat double answering from a script of model contents (one per request;
 * the last answer repeats, which is what a retry loop meets).
 *
 * @param {(string | Error)[]} answers
 * @returns {{ calls: () => number, complete: import("#core/chat.mjs").Chat["complete"] }}
 */
function chat(answers) {
  let cursor = 0;
  let calls = 0;
  return {
    calls: () => calls,
    /** @param {{ model: string, messages: import("#core/chat.mjs").ChatMessage[] }} _request */
    async complete(_request) {
      const answer = answers[Math.min(cursor, answers.length - 1)];
      cursor++;
      calls++;
      if (answer instanceof Error) throw answer;
      return {
        content: /** @type {string} */ (answer),
        toolCalls: [],
        finishReason: undefined,
      };
    },
  };
}

/**
 * A chat that translates honestly by echoing the prepared document back:
 * restoration then reproduces the source byte-for-byte, which every
 * structural comparison accepts.
 * @returns {import("#core/chat.mjs").Chat}
 */
function echoingChat() {
  return /** @type {any} */ ({
    /** @param {{ messages: { role: string, content: string }[] }} request */
    async complete(request) {
      const user = request.messages[request.messages.length - 1]?.content ?? "";
      // Byte-exact slice between this block's opening label and the next
      // block's "\n\n[label]" separator: every byte of the gap belongs to
      // the framing, never to the document.
      const start = user.indexOf("[source-document]\n");
      if (start < 0) {
        return {
          content: JSON.stringify({ drift: true, summary: "nothing found", content: "??" }),
        };
      }
      const from = start + "[source-document]\n".length;
      const nextBlock = user.indexOf("\n\n[", from);
      const source = nextBlock === -1 ? user.slice(from) : user.slice(from, nextBlock);
      return {
        content: JSON.stringify({ drift: true, summary: "kept in step", content: source }),
      };
    },
  });
}

/** @param {string} content @returns {string} a JSON answer proposing a translation */
function proposes(content) {
  return JSON.stringify({ drift: true, summary: "kept in step", content });
}

const evidence = {
  /** @param {string} label @param {string} content */
  wrap(label, content) {
    return `[${label}]\n${content}`;
  },
};

/**
 * An Io whose forge is given and whose chat echoes by default; explicit
 * answers replace the echo.
 *
 * @param {ReturnType<typeof forge>} forgeDouble
 * @param {(string | Error)[]} [answers]
 */
function io(forgeDouble, answers = []) {
  const chatDouble =
    answers.length > 0
      ? chat(answers)
      : /** @type {any} */ ({ calls: () => 0, ...{}, ...echoingChat() });
  return /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });
}

/** @returns {ReturnType<typeof import("#core/runtime.mjs").readContext>} */
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

/** @param {import("vitest").MockInstance} log @returns {string} */
function logged(log) {
  return log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe("readInputs", () => {
  it("carries the shared inputs through", () => {
    expect(readInputs(runner)).toMatchObject({
      githubToken: "ghs_x",
      apiUrl: "https://api.example/v1",
      apiKey: "sk-secret",
      model: "gpt-x",
    });
  });

  it("requires the source of truth, because every other version is judged against it", () => {
    const missing = { ...runner };
    delete missing["INPUT_SOURCE-LANGUAGE"];
    expect(() => readInputs(missing)).toThrow(/'source-language'/);
  });

  it("reads a configured config-path, empty for the default locations", () => {
    expect(readInputs(runner).configPath).toBe("");
    expect(readInputs({ ...runner, "INPUT_CONFIG-PATH": "p/harmonise.json5" }).configPath).toBe(
      "p/harmonise.json5",
    );
  });

  it("defaults the documents filter to empty — the map defines the space", () => {
    expect(readInputs(runner).documents).toEqual([]);
    expect(
      readInputs({ ...runner, INPUT_DOCUMENTS: "manual/a.md, manual/b.md" }).documents,
    ).toEqual(["manual/a.md", "manual/b.md"]);
  });

  it("defaults to a dry run, because this action edits files rather than comments", () => {
    expect(readInputs(runner).dryRun).toBe(true);
  });

  it("defaults request-timeout-ms to 30000 when the input is absent", () => {
    expect(readInputs(runner).requestTimeoutMs).toBe(30_000);
  });

  it("refuses a request-timeout-ms that is not a number", () => {
    expect(() => readInputs({ ...runner, "INPUT_REQUEST-TIMEOUT-MS": "soon" })).toThrow(
      /must be a number/,
    );
  });

  it("refuses a request-timeout-ms under the 1000 ms floor", () => {
    // The floor is what keeps core's disabled-timeout path (timeoutMs <= 0)
    // out of a workflow's reach: an unbounded request is a hung runner.
    expect(() => readInputs({ ...runner, "INPUT_REQUEST-TIMEOUT-MS": "0" })).toThrow(
      /at least 1000/,
    );
    expect(() => readInputs({ ...runner, "INPUT_REQUEST-TIMEOUT-MS": "999" })).toThrow(
      /at least 1000/,
    );
  });
});

describe("run — request-timeout-ms wiring", () => {
  // The floor test above ("refuses a request-timeout-ms under the 1000 ms
  // floor") pins what `readInputs` accepts. These two pin that the accepted
  // number actually reaches the HTTP client `realIo` builds — the hop the
  // floor exists to guard.

  /**
   * A chat-completions transport that answers by echoing the prepared
   * document back — restoration then reproduces the source byte-for-byte —
   * recording every abort signal it was handed.
   *
   * @param {AbortSignal[]} signals
   * @returns {typeof globalThis.fetch}
   */
  function echoingFetch(signals) {
    return /** @type {typeof globalThis.fetch} */ (
      async (_url, init) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("no abort signal reached the chat request");
        }
        signals.push(signal);
        const body = /** @type {{ messages?: { content?: string }[] }} */ (
          JSON.parse(typeof init?.body === "string" ? init.body : "{}")
        );
        const user = body.messages?.[body.messages.length - 1]?.content ?? "";
        const opened = /\[evidence:([0-9a-f]+) source-document\]\n/.exec(user);
        const from = opened === null ? 0 : opened.index + opened[0].length;
        const end = opened === null ? -1 : user.indexOf(`\n\n[end-evidence:${opened[1]}]`, from);
        const source = end === -1 ? user.slice(from) : user.slice(from, end);
        const content =
          opened === null
            ? JSON.stringify({ drift: true, summary: "nothing found", content: "??" })
            : JSON.stringify({ drift: true, summary: "kept in step", content: source });
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
    );
  }

  /**
   * A transport that never answers: every request hangs until its abort
   * signal fires, then rejects with the signal's abort reason.
   *
   * @param {AbortSignal[]} signals
   * @returns {typeof globalThis.fetch}
   */
  function hangingFetch(signals) {
    return /** @type {typeof globalThis.fetch} */ (
      (_url, init) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("no abort signal reached the chat request");
        }
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    );
  }

  it("forwards the configured request-timeout-ms to the chat client as an abort signal", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    /** @type {AbortSignal[]} */
    const signals = [];

    await run(
      { ...readInputs(runner), requestTimeoutMs: 2500 },
      context(),
      /** @type {any} */ ({ forge: forge(makeRepo()), fetchImpl: echoingFetch(signals) }),
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("aborts a hanging provider on every attempt across the recovery policy and fails red", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    /** @type {AbortSignal[]} */
    const signals = [];

    await expect(
      run(
        { ...readInputs(runner), requestTimeoutMs: 1000 },
        context(),
        /** @type {any} */ ({
          forge: forge(makeRepo()),
          fetchImpl: hangingFetch(signals),
          sleep: async () => {},
        }),
      ),
    ).rejects.toThrow(/classified transport, exhausted/);

    expect(signals).toHaveLength(9);
    expect(new Set(signals).size).toBe(9);
  }, 60_000);
});

describe("run", () => {
  it("publishes one branch, one commit and one pull request on a real run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const forgeDouble = forge(makeRepo());
    const ioDouble = /** @type {any} */ ({
      forge: forgeDouble,
      chat: echoingChat(),
      evidence,
    });
    const inputs = { ...readInputs(runner), dryRun: false };

    await expect(run(inputs, context(), ioDouble)).resolves.toBeUndefined();

    /** @typedef {{ op: string, args: unknown[] }} Write */
    const ops = forgeDouble.writes.map((w) => w.op);
    expect(ops).toEqual([
      "createBlob",
      "createBlob",
      "createBlob",
      "createTree",
      "createCommit",
      "upsertBranch",
      "upsertPullRequest",
    ]);
    const branch = /** @type {Write} */ (forgeDouble.writes.find((w) => w.op === "upsertBranch"));
    expect(branch.args[0]).toBe("harmonise/en");
    // The optimistic lock is the tip every read anchored to.
    expect(branch.args[2]).toBe(forgeDouble.baseSha);
    const pr = /** @type {{ base: string, head: string, title: string, body: string }} */ (
      /** @type {Write} */ (forgeDouble.writes.find((w) => w.op === "upsertPullRequest")).args[0]
    );
    expect(pr.base).toBe("main");
    expect(pr.head).toBe("harmonise/en");
    expect(pr.title).toBe("chore(harmonise): sync 1 document with en");
    // The pull-request title and the commit subject are one convention: the
    // commit message carries the title as its first line.
    const commit = /** @type {Write} */ (forgeDouble.writes.find((w) => w.op === "createCommit"));
    expect(commit.args[0]).toMatch(/^chore\(harmonise\): sync 1 document with en\n/);
    expect(pr.body).toMatch(/## What changed/);
    expect(logged(log)).toMatch(/opened pull request #42/);
  });

  it("refuses the run when the branch moved under it — the lock fires before the pull request", async () => {
    // The run's own branch existed at start; by update time another writer
    // had moved its tip. The fake mirrors core/forge's optimistic lock: the
    // branch write is refused before it is recorded, exactly as the real
    // forge refuses before the ref update.
    const movedTo = "d".repeat(40);
    const forgeDouble = forge(makeRepo(), undefined, {
      branches: { "harmonise/en": { sha: "b".repeat(40), files: {} } },
    });
    forgeDouble.upsertBranch = /** @type {any} */ (
      /**
       * @param {string} branch
       * @param {string} commitSha
       * @param {string | null} expectedCurrentSha
       */
      async (branch, commitSha, expectedCurrentSha) => {
        throw new BranchMovedError(branch, /** @type {string} */ (expectedCurrentSha), movedTo);
      }
    );
    const ioDouble = io(forgeDouble);

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );

    expect(error).toBeInstanceOf(BranchMovedError);
    expect(error.message).toMatch(/branch 'harmonise\/en' moved while the run worked/);
    // Refused, never overwritten: the write log ends at the commit — the
    // branch never moved and no pull request was requested.
    expect(forgeDouble.writes.map((w) => w.op)).toEqual([
      "createBlob",
      "createBlob",
      "createBlob",
      "createTree",
      "createCommit",
    ]);
  });

  it("refuses the second of two interleaved runs through the optimistic lock", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    /** Yields the macro-task queue once, so pending run continuations advance. */
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    /**
     * A chat double that suspends its first call on a gate, then answers
     * with an honest proposal — the run stays mid-flight until released.
     */
    function heldChat() {
      /** @type {(value?: void) => void} */
      let release = () => {};
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let calls = 0;
      return {
        calls: () => calls,
        release,
        async complete() {
          calls++;
          await gate;
          return {
            content: proposes("# Dev\n\nTraduit.\n"),
            toolCalls: [],
            finishReason: undefined,
          };
        },
      };
    }

    // One shared forge, so both runs read and race over the same branch.
    const forgeDouble = forge(makeRepo(), makeInventory(["manual/dev.md", "manual/vi/dev.md"]), {
      branches: {},
    });
    const chatA = heldChat();
    const chatB = heldChat();

    const runA = run(
      { ...readInputs(runner), dryRun: false },
      context(),
      /** @type {any} */ ({ forge: forgeDouble, chat: chatA, evidence }),
    );
    for (let i = 0; i < 100 && chatA.calls() === 0; i++) await settle();
    expect(chatA.calls()).toBe(1);
    // Run B starts while A is suspended on its model call, so B snapshots
    // the same branch tip A did — the exact interleaving the lock exists
    // for.
    const runB = run(
      { ...readInputs(runner), dryRun: false },
      context(),
      /** @type {any} */ ({ forge: forgeDouble, chat: chatB, evidence }),
    );
    for (let i = 0; i < 100 && chatB.calls() === 0; i++) await settle();
    expect(chatB.calls()).toBe(1);

    // A resumes first: its snapshot is still the tip, so the lock passes
    // and the branch moves under B's feet.
    chatA.release();
    await expect(runA).resolves.toBeUndefined();
    const aWrite = /** @type {{ args: [string, string, string | null] }} */ (
      /** @type {unknown} */ (forgeDouble.writes.find((w) => w.op === "upsertBranch"))
    );
    expect(aWrite.args[2]).toBe(forgeDouble.baseSha);

    // B resumes with a stale snapshot: it walks the whole production path —
    // blobs, tree, commit — and is refused at the branch write, which is
    // never recorded and never followed by a pull request.
    const beforeB = forgeDouble.writes.length;
    chatB.release();
    const error = await runB.catch((cause) => cause);
    expect(error).toBeInstanceOf(BranchMovedError);
    expect(error.message).toMatch(/moved while the run worked/);
    expect(forgeDouble.writes.slice(beforeB).map((w) => w.op)).toEqual([
      "createBlob",
      "createBlob",
      "createBlob",
      "createTree",
      "createCommit",
    ]);
  });

  it("fails the run when the branch read's error text embeds 'HTTP 404' but the status is 500", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const forgeDouble = forge(makeRepo());
    const inner = forgeDouble.getRef.bind(forgeDouble);
    forgeDouble.getRef = /** @type {any} */ (
      /** @param {string} name */
      async (name) => {
        if (name === "harmonise/en") {
          throw new ForgeError(
            "reading the ref of branch 'harmonise/en'",
            new HttpError("the provider answered with an HTTP 404 page", {
              status: 500,
              url: "https://api.example/repos/o/r/git/ref/heads/harmonise%2Fen",
            }),
          );
        }
        return inner(name);
      }
    );
    const ioDouble = io(forgeDouble);

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );

    // The status is typed; the prose is not evidence. A 500 stays a failure
    // even when its text embeds "HTTP 404" — never read as "the branch is
    // absent", which would send the run on to create one.
    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/reading the ref of branch 'harmonise\/en' failed/);
    expect(forgeDouble.writes).toHaveLength(0);
  });

  it("updates an existing pull request in place instead of opening a twin", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const forgeDouble = forge(makeRepo());
    forgeDouble.upsertPullRequest = /** @type {any} */ (
      async () => ({
        number: 7,
        created: false,
      })
    );
    const ioDouble = /** @type {any} */ ({
      forge: forgeDouble,
      chat: echoingChat(),
      evidence,
    });

    await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble);

    expect(logged(log)).toMatch(/updated pull request #7 in place/);
  });

  it("renders a configured pullRequest.title template into commit subject and PR title", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const forgeDouble = forge(
      makeRepo({
        config: makeConfig({
          pullRequest: { title: "docs(i18n): sync {n} documents from {sourceLanguage}" },
        }),
      }),
    );
    const ioDouble = /** @type {any} */ ({
      forge: forgeDouble,
      chat: echoingChat(),
      evidence,
    });

    await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble);

    /** @typedef {{ op: string, args: unknown[] }} Write */
    const pr = /** @type {{ title: string }} */ (
      /** @type {Write} */ (forgeDouble.writes.find((w) => w.op === "upsertPullRequest")).args[0]
    );
    const commit = /** @type {Write} */ (forgeDouble.writes.find((w) => w.op === "createCommit"));
    const expected = "docs(i18n): sync 1 documents from en";
    expect(pr.title).toBe(expected);
    // One convention, two surfaces: the commit subject carries the same line.
    expect(/** @type {string} */ (commit.args[0]).startsWith(expected + "\n")).toBe(true);
  });

  it("publishes successful proposals first, then exits red on failed pairs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const forgeDouble = forge(
      makeRepo({ documents: { "manual/dev.md": "# Dev\n\nFine.\n" } }),
      makeInventory(["manual/dev.md", "manual/lost.md"]),
    );
    const ioDouble = /** @type {any} */ ({
      forge: forgeDouble,
      chat: echoingChat(),
      evidence,
    });

    // The pull request carries the successful changes; the run still goes red.
    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).rejects.toThrow(/1 pair\(s\) failed/);
    expect(forgeDouble.writes.map((/** @type {{ op: string }} */ w) => w.op)).toContain(
      "upsertPullRequest",
    );
  });

  it("reports translated proposals, missing translations and orphans on a dry run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ioDouble = io(
      forge(
        makeRepo({
          config: makeConfig({ glossary: ["repository"] }),
          documents: {
            "manual/dev.md":
              "# Dev\n\nThe repository holds guides.\n\n![diagram](images/dev.png)\n",
          },
        }),
        makeInventory([
          "manual/dev.md",
          "manual/vi/dev.md",
          "manual/images/dev.vi.png",
          "manual/vi/legacy.md",
        ]),
      ),
    );

    await expect(run(readInputs(runner), context(), ioDouble)).resolves.toBeUndefined();

    const out = logged(log);
    expect(out).toMatch(
      /translated vi manual\/dev\.md → manual\/vi\/dev\.md \[existing\] proposed/,
    );
    expect(out).toMatch(/glossary=1/);
    expect(out).toMatch(/links=1/); // the localized image exists
    expect(out).toMatch(/orphans: 1 \(reported, never touched\)/);
    expect(out).toMatch(/orphan manual\/vi\/legacy\.md \[vi\]/);
  });

  it("reports an honest no-op even when glossary tokens are in play", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const published = "# Dev\n\nLe dépôt repository grandit.\n";
    // The record predates a policy change, so the deterministic gate cannot
    // prove the pair unchanged and the model path runs; the target bytes
    // themselves are canonical, so a byte-identical answer is a noop — and
    // it holds no run tokens, and must not need any.
    const staleRecord = {
      schemaVersion: STATE_SCHEMA_VERSION,
      sourcePath: "manual/dev.md",
      destinationPath: "manual/vi/dev.md",
      language: "vi",
      sourceFingerprint: contentFingerprint("# Dev\n\nProse.\n"),
      translationFingerprint: contentFingerprint(published),
      policyFingerprint: contentFingerprint("a policy harmonise no longer runs"),
      transformationVersion: TRANSFORMATION_VERSION,
    };
    const chatDouble = chat([
      JSON.stringify({ drift: false, summary: "none", content: published }),
    ]);
    const forgeDouble = forge(
      makeRepo({
        config: makeConfig({ glossary: ["repository"] }),
        documents: { "manual/vi/dev.md": published },
        state: renderState([staleRecord]),
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();
    expect(chatDouble.calls()).toBe(1);
    expect(logged(log)).toMatch(/unchanged/);
    expect(logged(log)).not.toMatch(/proposed/);
  });

  it("refuses a translation that deletes a code block adjacent to another", async () => {
    const source = "# Dev\n\n```js\nfirst()\n```\n```py\nsecond()\n```\n";
    const ioDouble = io(
      forge(makeRepo({ documents: { "manual/dev.md": source } })),
      // Two adjacent blocks in, one out: the count walk must see both.
      [proposes("# Dev\n\n```js\nfirst()\n```\n"), proposes("# Dev\n\n```js\nfirst()\n```\n")],
    );

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/fenced code block count changed: 2 → 1/);
    expect(error.message).toMatch(/classified refusal, give-up/);
    expect(ioDouble.chat.calls()).toBe(1);
  });

  it("skips a pair whose existing translation is past the cap", async () => {
    const ioDouble = io(
      forge(
        makeRepo({
          documents: {
            "manual/dev.md": "# Dev\n\nFine.\n",
            "manual/vi/dev.md": "x".repeat(33 * 1024),
          },
        }),
      ),
    );

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair skipped/);
    expect(error.message).toMatch(/existing translation is 33792 bytes, past the 32768-byte cap/);
  });

  it("refuses a malformed answer without spending a retry", async () => {
    const chatDouble = chat(["this is not json at all", "still not json"]);
    const ioDouble = /** @type {any} */ ({
      forge: forge(makeRepo()),
      chat: chatDouble,
      evidence,
    });

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/does not parse as JSON|holds no JSON object/);
    expect(error.message).toMatch(/classified refusal, give-up/);
    expect(chatDouble.calls()).toBe(1);
  });

  it("refuses an answer whose content is whitespace only", async () => {
    const ioDouble = io(forge(makeRepo()), [proposes("\n\n"), proposes("   \n ")]);

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/no content beyond whitespace/);
    expect(ioDouble.chat.calls()).toBe(1);
  });

  it("fails a pair whose answer lost a protected token, however fluent the prose", async () => {
    const ioDouble = io(
      forge(
        makeRepo({
          config: makeConfig({ glossary: ["repository"] }),
          documents: { "manual/dev.md": "# Dev\n\nThe repository grows.\n" },
        }),
      ),
      // No token in the answer: restoration refuses it.
      [proposes("# Dev\n\nLe dépôt grandit.\n"), proposes("# Dev\n\nLe dépôt grandit.\n")],
    );

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/lost protected content|appears 0 times/);
    expect(ioDouble.chat.calls()).toBe(1);
  });

  it("fails a pair whose answer corrupts Markdown structure", async () => {
    const ioDouble = io(
      forge(makeRepo({ documents: { "manual/dev.md": "# Dev\n\n```js\nkeep()\n```\n" } })),
      // The code fence vanished from the translation.
      [proposes("# Dev\n\nkeep()\n"), proposes("# Dev\n\nkeep()\n")],
    );

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/structural validation failed/);
    expect(ioDouble.chat.calls()).toBe(1);
  });

  it("fails a pair whose answer re-targets a link, without spending a retry", async () => {
    const chatDouble = chat([
      proposes("# Dev\n\nSee [api](https://evil.example).\n"),
      proposes("# Dev\n\nSee [api](https://evil.example).\n"),
    ]);
    const ioDouble = /** @type {any} */ ({
      forge: forge(
        makeRepo({
          documents: {
            "manual/dev.md": "# Dev\n\nSee [api](api.md).\n",
            "manual/api.md": "# API\n",
          },
        }),
      ),
      chat: chatDouble,
      evidence,
    });

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(
      /link validation failed: line 3: link destination changed: 'api\.md' → 'https:\/\/evil\.example'/,
    );
    expect(error.message).toMatch(/classified refusal, give-up/);
    expect(chatDouble.calls()).toBe(1);
  });

  describe("recovery policy in the pair loop", () => {
    /**
     * An Io whose chat is given and whose sleep records the waits the policy
     * asks for instead of spending real time.
     *
     * @param {Record<string, string>} map
     * @param {ReturnType<typeof chat>} chatDouble
     * @returns {{ ioDouble: any, sleeps: number[] }}
     */
    function sleeping(map, chatDouble) {
      /** @type {number[]} */
      const sleeps = [];
      const ioDouble = /** @type {any} */ ({
        forge: forge(map),
        chat: chatDouble,
        evidence,
        /** @param {number} ms */
        async sleep(ms) {
          sleeps.push(ms);
        },
      });
      return { ioDouble, sleeps };
    }

    const overloaded = () =>
      new HttpError("the request was refused", {
        status: 503,
        url: "https://api.example/v1/chat/completions",
        excerpt: "overloaded",
      });

    it("retries a retryable status once with the mapped delay, then succeeds", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const chatDouble = chat([overloaded(), proposes("# Dev\n\nTraduit.\n")]);
      const { ioDouble, sleeps } = sleeping(makeRepo(), chatDouble);

      await expect(run(readInputs(runner), context(), ioDouble)).resolves.toBeUndefined();

      expect(chatDouble.calls()).toBe(2);
      expect(sleeps).toEqual([DELAY_MS.short]);
      expect(logged(log)).toMatch(/translated vi manual\/dev\.md/);
    });

    it("classifies a timed-out request as transport and retries", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const chatDouble = chat([
        new TransportError("https://api.example/v1/chat/completions", "timed out"),
        proposes("# Dev\n\nTraduit.\n"),
      ]);
      const { ioDouble, sleeps } = sleeping(makeRepo(), chatDouble);

      await expect(run(readInputs(runner), context(), ioDouble)).resolves.toBeUndefined();

      expect(chatDouble.calls()).toBe(2);
      expect(sleeps).toEqual([DELAY_MS.short]);
    });

    it("gives up on an auth status: one call, no wait", async () => {
      const chatDouble = chat([
        new HttpError("the request was refused", {
          status: 401,
          url: "https://api.example/v1/chat/completions",
          excerpt: "bad credentials",
        }),
      ]);
      const { ioDouble, sleeps } = sleeping(makeRepo(), chatDouble);

      const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);

      expect(error.message).toMatch(/every pair failed/);
      expect(error.message).toMatch(/classified auth, give-up/);
      expect(chatDouble.calls()).toBe(1);
      expect(sleeps).toEqual([]);
    });

    it("gives up on a contract refusal: one call, no wait", async () => {
      const chatDouble = chat([proposes("# Dev\n\nkeep()\n")]);
      const { ioDouble, sleeps } = sleeping(
        makeRepo({ documents: { "manual/dev.md": "# Dev\n\n```js\nkeep()\n```\n" } }),
        chatDouble,
      );

      const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);

      expect(error.message).toMatch(/every pair failed/);
      expect(error.message).toMatch(/structural validation failed/);
      expect(error.message).toMatch(/classified refusal, give-up/);
      expect(chatDouble.calls()).toBe(1);
      expect(sleeps).toEqual([]);
    });

    it("exhausts the transport retries with the mapped delays", async () => {
      const chatDouble = chat([overloaded()]);
      const { ioDouble, sleeps } = sleeping(makeRepo(), chatDouble);

      const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);

      expect(error.message).toMatch(/every pair failed/);
      expect(error.message).toMatch(/classified transport, exhausted/);
      expect(chatDouble.calls()).toBe(3);
      expect(sleeps).toEqual([DELAY_MS.short, DELAY_MS.long]);
    });

    it("retries an unknown failure exactly once, then records the class", async () => {
      const chatDouble = chat([
        new ChatError("the provider answered with an error object", { excerpt: "quota" }),
      ]);
      const { ioDouble, sleeps } = sleeping(makeRepo(), chatDouble);

      const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);

      expect(error.message).toMatch(/every pair failed/);
      expect(error.message).toMatch(/the provider answered with an error object: quota/);
      expect(error.message).toMatch(/classified unknown, exhausted/);
      expect(chatDouble.calls()).toBe(2);
      expect(sleeps).toEqual([DELAY_MS.short]);
    });

    it("keeps the composed retry ceiling at nine provider calls per pair", () => {
      // Two layers compose multiplicatively: the pair loop owns the outer
      // attempts (DEFAULT_POLICY), http.mjs the inner ones
      // (DEFAULT_MAX_ATTEMPTS). Move either constant and the composed
      // ceiling moves with it — restate "The retry ceiling" in
      // docs/development/ceilings.md in the same change or this pin fails.
      expect(DEFAULT_POLICY.transport.retries + 1).toBe(3);
      expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
      expect((DEFAULT_POLICY.transport.retries + 1) * DEFAULT_MAX_ATTEMPTS).toBe(9);
    });
  });

  describe("DELAY_MS — the caller's delay mapping", () => {
    it("maps every declared delay name to its millisecond cost", () => {
      expect(Object.keys(DELAY_MS)).toEqual(["immediate", "short", "long"]);
      expect(DELAY_MS.immediate).toBe(0);
      expect(DELAY_MS.short).toBe(1_000);
      expect(DELAY_MS.long).toBe(5_000);
      for (const name of DELAY_CLASSES) {
        expect(Number.isSafeInteger(DELAY_MS[name])).toBe(true);
      }
    });

    it("pays the transport layer's own backoff step as the short delay", () => {
      // Shared by import from core/src/transport-errors.mjs: a change to the
      // transport's backoff moves the pair loop's short delay with it —
      // mirroring by construction, not by a restated literal.
      expect(DELAY_MS.short).toBe(DEFAULT_RETRY_DELAY_MS);
    });
  });

  it("resolves a planned target's links before the translation exists", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ioDouble = io(
      forge(
        makeRepo({
          documents: {
            // api's vi twin does not exist yet, but this run plans to create it:
            // the internal link must already point at its future home while the
            // external one stays exactly as authored.
            "manual/dev.md": "See [the api](api.md) and [the site](https://example.com/).\n",
            "manual/api.md": "# API\n\nEndpoints.\n",
          },
        }),
        makeInventory(["manual/dev.md", "manual/vi/dev.md", "manual/api.md"]),
      ),
    );

    await expect(run(readInputs(runner), context(), ioDouble)).resolves.toBeUndefined();

    expect(logged(log)).toMatch(/links=1/);
  });

  it("refuses when no source document matches the map", async () => {
    const ioDouble = io(forge(makeRepo(), makeInventory(["README.md"])));

    await expect(run(readInputs(runner), context(), ioDouble)).rejects.toThrow(
      /no document matches the source language 'en'/,
    );
  });

  it("refuses a documents filter that narrows everything away", async () => {
    const ioDouble = io(forge(makeRepo()));
    const inputs = { ...readInputs(runner), documents: ["nope/**/*.md"] };

    await expect(run(inputs, context(), ioDouble)).rejects.toThrow(
      /narrows 1 source documents to none/,
    );
  });

  it("goes red when every pair fails preparation, naming the defect", async () => {
    const ioDouble = io(
      forge(
        makeRepo({
          documents: {
            // An unclosed region is malformed: preparation must refuse it.
            "manual/dev.md": "<!-- harmonise:skip-start -->\nnever closed\n",
          },
        }),
      ),
    );

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/never closed/);
  });

  it("skips an oversized source with its reason while healthy pairs prepare", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ioDouble = io(
      forge(
        makeRepo({
          documents: {
            "manual/dev.md": "# Dev\n\nFine.\n",
            // 33 KiB: past the deterministic cap.
            "manual/big.md": "x".repeat(33 * 1024),
          },
        }),
        makeInventory(["manual/dev.md", "manual/big.md"]),
      ),
    );

    await expect(run(readInputs(runner), context(), ioDouble)).resolves.toBeUndefined();
    const out = logged(log);
    expect(out).toMatch(/skipped vi manual\/big\.md: 33792 bytes, past the 32768-byte cap/);
    expect(out).toMatch(/translated vi manual\/dev\.md/);
  });

  it("accepts a source document of exactly the 32 KiB cap — the boundary is inclusive", async () => {
    expect(MAX_SOURCE_BYTES).toBe(32768);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const source = "x".repeat(MAX_SOURCE_BYTES);
    expect(new TextEncoder().encode(source).byteLength).toBe(MAX_SOURCE_BYTES);
    const ioDouble = io(
      forge(makeRepo({ documents: { "manual/big.md": source } }), makeInventory(["manual/big.md"])),
    );

    await expect(run(readInputs(runner), context(), ioDouble)).resolves.toBeUndefined();
    expect(logged(log)).toMatch(/translated vi manual\/big\.md/);
  });

  it("skips a source document of exactly one byte past the cap, naming the limit", async () => {
    expect(MAX_SOURCE_BYTES).toBe(32768);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const source = "x".repeat(MAX_SOURCE_BYTES + 1);
    expect(new TextEncoder().encode(source).byteLength).toBe(MAX_SOURCE_BYTES + 1);
    const ioDouble = io(
      forge(
        makeRepo({
          documents: { "manual/dev.md": "# Dev\n\nFine.\n", "manual/big.md": source },
        }),
        makeInventory(["manual/dev.md", "manual/big.md"]),
      ),
    );

    await expect(run(readInputs(runner), context(), ioDouble)).resolves.toBeUndefined();
    const out = logged(log);
    expect(out).toMatch(
      new RegExp(
        `skipped vi manual/big\\.md: ${String(MAX_SOURCE_BYTES + 1)} bytes, past the ` +
          `${String(MAX_SOURCE_BYTES)}-byte cap`,
      ),
    );
    expect(out).toMatch(/translated vi manual\/dev\.md/);
  });

  it("goes red when every pair skips — work existed and none was attempted", async () => {
    const ioDouble = io(
      forge(makeRepo({ documents: { "manual/dev.md": "" } }), makeInventory(["manual/dev.md"])),
    );

    await expect(run(readInputs(runner), context(), ioDouble)).rejects.toThrow(
      /every pair skipped[\s\S]*the source document is empty/,
    );
  });

  it("carries on when one pair fails and another prepares", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Two sources on the branch, but only one still readable: the second
    // pair's preparation fails and must not take the healthy pair down.
    const ioDouble = io(
      forge(
        makeRepo({
          config: makeConfig({
            languages: {
              en: "manual/{document}.md",
              vi: "manual/vi/{document}.md",
              fr: "manual/fr/{document}.md",
            },
          }),
          documents: { "manual/dev.md": "# Dev\n\nFine prose.\n" },
        }),
        makeInventory(["manual/dev.md", "manual/lost.md"]),
      ),
    );

    // A failed pair is a failed run even when others carried — but the
    // healthy pair's line is still reported before the red.
    await expect(run(readInputs(runner), context(), ioDouble)).rejects.toThrow(
      /1 pair\(s\) failed[\s\S]*manual\/lost\.md: gone from the branch/,
    );
    expect(logged(log)).toMatch(/translated vi manual\/dev\.md/);
  });

  it("refuses a source-language input the config does not declare", async () => {
    const ioDouble = io(forge(makeRepo()));
    const env = { ...runner, "INPUT_SOURCE-LANGUAGE": "de" };
    await expect(run(readInputs(env), context(), ioDouble)).rejects.toThrow(
      /'de' is not a language the config declares/,
    );
  });

  it("surfaces a truncated tree as the refusal it is", async () => {
    class TruncatedTreeError extends Error {}
    const forgeDouble = /** @type {any} */ ({
      ...forge(makeRepo()),
      /** @param {string} _sha */
      async listTree(_sha) {
        throw new TruncatedTreeError("truncated");
      },
    });
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chat([]), evidence });

    await expect(run(readInputs(runner), context(), ioDouble)).rejects.toThrow(TruncatedTreeError);
  });
});

describe("run with recorded state", () => {
  const SOURCE = "# Dev\n\nProse.\n";
  const TRANSLATED = "# Dev\n\nTraduit.\n";

  /**
   * A full sync-state record for the fixture's en→vi pair, pinning whatever
   * source and translation bytes the caller states.
   *
   * @param {{ source?: string, translation?: string, schemaVersion?: number }} [overrides]
   * @returns {import("./state.mjs").SyncStateRecord}
   */
  function viRecord({
    source = SOURCE,
    translation = TRANSLATED,
    schemaVersion = STATE_SCHEMA_VERSION,
  } = {}) {
    return {
      schemaVersion,
      sourcePath: "manual/dev.md",
      destinationPath: "manual/vi/dev.md",
      language: "vi",
      sourceFingerprint: contentFingerprint(source),
      translationFingerprint: contentFingerprint(translation),
      policyFingerprint: POLICY,
      transformationVersion: TRANSFORMATION_VERSION,
    };
  }

  it("skips a pair whose recorded state and target bytes both prove unchanged", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // The transport is a tripwire: a single call fails the run and the test.
    const chatDouble = chat([new Error("the model must not be called")]);
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": SOURCE, "manual/vi/dev.md": TRANSLATED },
        state: renderState([viRecord()]),
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    expect(chatDouble.calls()).toBe(0);
    expect(forgeDouble.writes).toEqual([]);
    const out = logged(log);
    expect(out).toMatch(/unchanged-skipped vi manual\/dev\.md → manual\/vi\/dev\.md/);
    expect(out).toMatch(/nothing to propose/);
  });

  it("runs the model exactly as before when the source changed since the record", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const chatDouble = chat([proposes("# Dev\n\nNouvelle prose.\n")]);
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": SOURCE, "manual/vi/dev.md": TRANSLATED },
        state: renderState([viRecord({ source: "# Dev\n\nOld text.\n" })]),
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    expect(chatDouble.calls()).toBe(1);
    expect(logged(log)).toMatch(/translated vi manual\/dev\.md/);
    expect(forgeDouble.writes.map((w) => w.op)).toContain("upsertPullRequest");
  });

  it("degrades a corrupt state file to absent — the unrecorded pair refuses, loudly", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // The state file is unparseable, so the read degrades to absent — the
    // run never blocks on advisory state. The destination's existing bytes
    // are then human work with no record: manual-edit protection refuses
    // the pair before any model call instead of translating over them.
    const chatDouble = chat([proposes("# Dev\n\nTraduit à nouveau.\n")]);
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": SOURCE, "manual/vi/dev.md": TRANSLATED },
        state: "{ this is not json",
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/manual-edit protection refused/);
    expect(error.message).toMatch(/never recorded publishing/);
    expect(chatDouble.calls()).toBe(0);
    expect(forgeDouble.writes).toEqual([]);
  });
  it("treats a foreign-schema state file as absent — a missing target still translates", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // The foreign schema refuses the whole state document, so the pair is
    // unrecorded; the advisory read itself still never blocks the run. With
    // no target on disk there is nothing to preserve — the pair is
    // create-allowed and translates exactly as before.
    const chatDouble = chat([proposes("# Dev\n\nTraduit à nouveau.\n")]);
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": SOURCE },
        state: renderState([viRecord({ schemaVersion: 999 })]),
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    expect(chatDouble.calls()).toBe(1);
    expect(logged(log)).toMatch(/translated vi manual\/dev\.md/);
    expect(forgeDouble.writes.map((w) => w.op)).toContain("upsertPullRequest");
  });

  it("refuses a drifted pair with no verifiable base — zero model calls, nothing written", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const edited = "# Dev\n\nTraduit et mis à jour.\n";
    // The record pins a translation the target's current bytes do not match:
    // someone edited it outside harmonise. Manual-edit protection forbids
    // the blind overwrite, and with no translation memory there is no
    // verifiable base to merge against — the pair is refused before any
    // model call, and the run goes red without writing a byte.
    const chatDouble = chat([new Error("the model must not be called")]);
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": SOURCE, "manual/vi/dev.md": edited },
        state: renderState([viRecord({ translation: "# Dev\n\nAutre version.\n" })]),
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/manual-edit protection refused/);

    expect(chatDouble.calls()).toBe(0);
    expect(forgeDouble.writes).toEqual([]);
    const out = logged(log);
    // A fully-failed run exits before the report block: the refusal reaches
    // the thrown message, never a report line. The policy-source audit line
    // is the one thing a refused run still logs — it fires before any model
    // call, so the run's provenance is on record even when it goes red.
    expect(out).toBe(
      "policy source: event=workflow_dispatch basis=dispatched branch=main " +
        `sha=${"a".repeat(40)} path=.github/action-agents/harmonise/harmonise.json5`,
    );
  });

  it("writes prior and proposed records into the same commit's state file", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const french = "# Dev\n\nTraduit en français.\n";
    const chatDouble = chat([proposes(french)]);
    const forgeDouble = forge(
      makeRepo({
        config: makeConfig({
          languages: {
            en: "manual/{document}.md",
            vi: "manual/vi/{document}.md",
            fr: "manual/fr/{document}.md",
          },
        }),
        documents: { "manual/dev.md": SOURCE, "manual/vi/dev.md": TRANSLATED },
        state: renderState([viRecord()]),
      }),
      makeInventory(["manual/dev.md", "manual/vi/dev.md", "manual/fr/dev.md"]),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    // Only fr saw the model; vi was provably unchanged.
    expect(chatDouble.calls()).toBe(1);
    // One tree carries the translation and the state file together.
    const tree = /** @type {{ args: unknown[] }} */ (
      forgeDouble.writes.find((w) => w.op === "createTree")
    );
    const changes = /** @type {{ path: string }[]} */ (tree.args[1]);
    expect(changes.map((change) => change.path)).toEqual(["manual/fr/dev.md", STATE_PATH, TM_PATH]);
    // The merged state file carries the preserved vi record and the new fr
    // record, each pinning exactly the bytes this commit publishes.
    const { records } = stateBlobOf(forgeDouble);
    expect(records).toEqual([
      {
        schemaVersion: STATE_SCHEMA_VERSION,
        sourcePath: "manual/dev.md",
        destinationPath: "manual/fr/dev.md",
        language: "fr",
        sourceFingerprint: contentFingerprint(SOURCE),
        translationFingerprint: contentFingerprint(french),
        policyFingerprint: POLICY,
        transformationVersion: TRANSFORMATION_VERSION,
      },
      viRecord(),
    ]);
  });

  it("round-trips: the state file one run publishes makes the next run skip", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const files = makeRepo({ documents: { "manual/dev.md": SOURCE } });

    // Run one: no state file, no existing translation — the model proposes.
    const chatDouble = chat([proposes(TRANSLATED)]);
    const firstForge = forge(files);
    const firstIo = /** @type {any} */ ({ forge: firstForge, chat: chatDouble, evidence });
    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), firstIo),
    ).resolves.toBeUndefined();
    expect(chatDouble.calls()).toBe(1);

    // The merge this PR's commit models: the translation and the state file
    // land on the branch the next run reads.
    files["manual/vi/dev.md"] = TRANSLATED;
    files[STATE_PATH] = JSON.stringify(stateBlobOf(firstForge));

    // Run two: every verdict is provably unchanged — zero model calls.
    const secondChat = chat([new Error("the model must not be called")]);
    const secondForge = forge(files);
    const secondIo = /** @type {any} */ ({ forge: secondForge, chat: secondChat, evidence });
    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), secondIo),
    ).resolves.toBeUndefined();

    expect(secondChat.calls()).toBe(0);
    expect(secondForge.writes).toEqual([]);
  });
  it("reports a policy-stale pair the model endorses as unchanged (noop)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const french = "# Dev\n\nTraduit en français.\n";
    // The vi record is policy-stale — its policy digest no longer matches
    // this run's — so the pair goes to the model, which returns the exact
    // bytes already published (a noop). fr has never been recorded, so the
    // model proposes and the run publishes. Targets are processed fr first,
    // then vi, so the answers line up in that order.
    const staleVi = { ...viRecord(), policyFingerprint: contentFingerprint("an older policy") };
    const chatDouble = chat([proposes(french), proposes(TRANSLATED)]);
    const forgeDouble = forge(
      makeRepo({
        config: makeConfig({
          languages: {
            en: "manual/{document}.md",
            vi: "manual/vi/{document}.md",
            fr: "manual/fr/{document}.md",
          },
        }),
        documents: { "manual/dev.md": SOURCE, "manual/vi/dev.md": TRANSLATED },
        state: renderState([staleVi]),
      }),
      makeInventory(["manual/dev.md", "manual/vi/dev.md", "manual/fr/dev.md"]),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    // Both pairs reached the model: a stale policy digest is never a skip
    // verdict, and the noop answer still costs a call.
    expect(chatDouble.calls()).toBe(2);
    const out = logged(log);
    expect(out).toMatch(
      /^translated fr manual\/dev\.md → manual\/fr\/dev\.md \[existing\] proposed\b/m,
    );
    expect(out).toMatch(
      /^translated vi manual\/dev\.md → manual\/vi\/dev\.md \[existing\] unchanged\b/m,
    );
    // The state file carries both records: the fr proposal's, and the vi
    // record re-pinned to this run's policy digest — the model endorsed the
    // published bytes, so the source and translation fingerprints are
    // unchanged and only the currency fields move (#88).
    const { records } = stateBlobOf(forgeDouble);
    expect(records).toEqual([
      {
        schemaVersion: STATE_SCHEMA_VERSION,
        sourcePath: "manual/dev.md",
        destinationPath: "manual/fr/dev.md",
        language: "fr",
        sourceFingerprint: contentFingerprint(SOURCE),
        translationFingerprint: contentFingerprint(french),
        policyFingerprint: POLICY,
        transformationVersion: TRANSFORMATION_VERSION,
      },
      viRecord(),
    ]);
  });

  it("publishes the re-pinned state when nothing is proposed, and the next run skips at zero calls", async () => {
    // The only pair is policy-stale and the model endorses the published
    // bytes: a noop. No pair proposes, yet the re-pinned record must reach
    // the state file — otherwise the pair costs one model call on every run
    // forever (#88).
    const staleVi = { ...viRecord(), policyFingerprint: contentFingerprint("an older policy") };
    const chatDouble = chat([proposes(TRANSLATED)]);
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": SOURCE, "manual/vi/dev.md": TRANSLATED },
        state: renderState([staleVi]),
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    expect(chatDouble.calls()).toBe(1);
    // The publication carries the state file and the memory alone — no
    // translation changed.
    const tree = /** @type {{ args: unknown[] }} */ (
      forgeDouble.writes.find((w) => w.op === "createTree")
    );
    const changes = /** @type {{ path: string }[]} */ (tree.args[1]);
    expect(changes.map((change) => change.path)).toEqual([STATE_PATH, TM_PATH]);
    expect(stateBlobOf(forgeDouble)).toEqual({ records: [viRecord()] });

    // The merge this PR's commit models: the re-pinned state reaches the
    // files the next run reads, and that run proves every verdict without
    // a single model call.
    const nextFiles = makeRepo({
      documents: { "manual/dev.md": SOURCE, "manual/vi/dev.md": TRANSLATED },
      state: JSON.stringify(stateBlobOf(forgeDouble)),
    });
    const secondChat = chat([new Error("the model must not be called")]);
    const secondForge = forge(nextFiles);
    const secondIo = /** @type {any} */ ({ forge: secondForge, chat: secondChat, evidence });
    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), secondIo),
    ).resolves.toBeUndefined();

    expect(secondChat.calls()).toBe(0);
    expect(secondForge.writes).toEqual([]);
  });

  it("refuses an unrecorded pair before any model call — adoption never overwrites", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // No state file: the destination predates harmonise, or the state was
    // lost. Its bytes are treated as human-authored, and with no record
    // there is never a merge base — the pair refuses before any model call
    // instead of translating over the existing bytes.
    const chatDouble = chat([proposes(TRANSLATED)]);
    const forgeDouble = forge(
      makeRepo({ documents: { "manual/dev.md": SOURCE, "manual/vi/dev.md": TRANSLATED } }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/manual-edit protection refused/);
    expect(error.message).toMatch(/never recorded publishing/);
    expect(chatDouble.calls()).toBe(0);
    expect(forgeDouble.writes).toEqual([]);
  });
});

describe("run with manual-edit protection and three-way merge", () => {
  const OLD_SOURCE = "# Dev\n\nProse.\n";
  const NEW_SOURCE = "# Dev\n\nProse expanded.\n";
  // A publication, a manual edit on top of it, a fresh proposal, and the
  // diff3-disjoint merge of the latter two: the manual edit rewrites one
  // line, the fresh proposal appends after it, so the merge keeps both.
  const BASE = "# Dev\n\nBản dịch đã công bố.\n";
  const EDITED = "# Dev\n\nBản dịch đã công bố — đã sửa tay.\n";
  const FRESH = "# Dev\n\nBản dịch đã công bố.\n\nĐoạn mô hình vừa dịch.\n";
  const MERGED = "# Dev\n\nBản dịch đã công bố — đã sửa tay.\n\nĐoạn mô hình vừa dịch.\n";

  // The memory key the drifted pair's base lives under: the record's own
  // (source, policy) fingerprints, not the current source's.
  const VI_BASE_KEY = buildTmKey({
    sourceHash: contentFingerprint(OLD_SOURCE),
    targetLang: "vi",
    policyContext: POLICY,
  });

  /**
   * A sync-state record for the fixture's en→vi pair, pinning whatever
   * source and translation bytes the caller states — by default the recorded
   * publication of OLD_SOURCE whose bytes are BASE.
   *
   * @param {{ source?: string, translation?: string }} [overrides]
   * @returns {import("./state.mjs").SyncStateRecord}
   */
  function viPublication({ source = OLD_SOURCE, translation = BASE } = {}) {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      sourcePath: "manual/dev.md",
      destinationPath: "manual/vi/dev.md",
      language: "vi",
      sourceFingerprint: contentFingerprint(source),
      translationFingerprint: contentFingerprint(translation),
      policyFingerprint: POLICY,
      transformationVersion: TRANSFORMATION_VERSION,
    };
  }

  /**
   * A serialized translation memory carrying exactly one entry.
   *
   * @param {string} key a key as `buildTmKey` produces
   * @param {string} value
   * @returns {string}
   */
  function memoryWith(key, value) {
    const store = createTmStore();
    store.record(key, value);
    return serializeTm(store);
  }

  /**
   * The created-blob contents among a forge double's writes, in write order:
   * proposals first, then the state file, then the translation memory.
   *
   * @param {ReturnType<typeof forge>} forgeDouble
   * @returns {string[]}
   */
  function blobsOf(forgeDouble) {
    return forgeDouble.writes
      .filter((w) => w.op === "createBlob")
      .map((w) => /** @type {{ args: [string] }} */ (/** @type {unknown} */ (w)).args[0]);
  }

  /**
   * The parsed translation memory among a forge double's writes — the last
   * blob, written after every proposal and the state file.
   *
   * @param {ReturnType<typeof forge>} forgeDouble
   * @returns {import("./tm.mjs").TmStore}
   */
  function tmOf(forgeDouble) {
    const blobs = blobsOf(forgeDouble);
    return parseTm(/** @type {string} */ (blobs[blobs.length - 1])).store;
  }

  it("merges the fresh proposal with the manual edit against the verified base", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const chatDouble = chat([proposes(FRESH)]);
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": NEW_SOURCE, "manual/vi/dev.md": EDITED },
        state: renderState([viPublication()]),
        memory: memoryWith(VI_BASE_KEY, BASE),
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    expect(chatDouble.calls()).toBe(1);
    // The publication carries the merge — never the raw proposal, never the
    // raw manual text.
    const blobs = blobsOf(forgeDouble);
    expect(blobs[0]).toBe(MERGED);
    const out = logged(log);
    expect(out).toMatch(/translated vi manual\/dev\.md/);
    expect(out).toMatch(/three-way merge: 1 manual region\(s\) preserved, 1 fresh adopted/);
    // Publication happens exactly once, after the drain: proposal, state,
    // memory, tree, commit, branch, request.
    expect(forgeDouble.writes.map((w) => w.op)).toEqual([
      "createBlob",
      "createBlob",
      "createBlob",
      "createTree",
      "createCommit",
      "upsertBranch",
      "upsertPullRequest",
    ]);
    // State and memory pin the merged bytes, so the next run sees the
    // published text as exactly what harmonise published.
    const state = stateBlobOf(forgeDouble);
    expect(state.records[0]?.translationFingerprint).toBe(contentFingerprint(MERGED));
    expect(
      tmOf(forgeDouble).lookup(
        buildTmKey({
          sourceHash: contentFingerprint(NEW_SOURCE),
          targetLang: "vi",
          policyContext: POLICY,
        }),
      ),
    ).toBe(MERGED);
  });

  it("refuses a conflicted three-way merge fail-closed while siblings publish", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // The fresh proposal rewrites the very line the manual edit changed:
    // diff3 reports a conflict, and the merge refuses rather than picking a
    // winner — the raw translation must not slip in behind the refusal.
    const rewritten = "# Dev\n\nBản dịch mô hình viết đè.\n";
    const chatDouble = chat([proposes(rewritten)]);
    const forgeDouble = forge(
      makeRepo({
        documents: {
          "manual/dev.md": NEW_SOURCE,
          "manual/api.md": "# Api\n\nEndpoints.\n",
          "manual/vi/dev.md": EDITED,
        },
        state: renderState([viPublication()]),
        memory: memoryWith(VI_BASE_KEY, BASE),
      }),
      makeInventory(["manual/dev.md", "manual/api.md", "manual/vi/dev.md", "manual/vi/api.md"]),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );
    expect(error.message).toMatch(/1 pair\(s\) failed/);
    expect(error.message).toMatch(/three-way merge refused/);
    expect(error.message).toMatch(/1 conflict region\(s\)/);
    // The conflicted pair still translated once; the refusal is post-merge.
    expect(chatDouble.calls()).toBe(2);
    // The healthy sibling published exactly once; the conflicted destination
    // is nowhere in the tree.
    const treeWrite = /** @type {{ args: [string, { path: string }[]] }} */ (
      /** @type {unknown} */ (forgeDouble.writes.find((w) => w.op === "createTree"))
    );
    expect(treeWrite.args[1].map((change) => change.path)).toEqual([
      "manual/vi/api.md",
      STATE_PATH,
      TM_PATH,
    ]);
    expect(forgeDouble.writes.filter((w) => w.op === "upsertPullRequest")).toHaveLength(1);
  });

  it("refuses a drifted pair with no verifiable base before any model call while siblings translate", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const chatDouble = chat([proposes("# Api\n\nCác điểm cuối.\n")]);
    const forgeDouble = forge(
      makeRepo({
        documents: {
          "manual/dev.md": NEW_SOURCE,
          "manual/api.md": "# Api\n\nEndpoints.\n",
          "manual/vi/dev.md": EDITED,
        },
        state: renderState([viPublication()]),
        // No TM_PATH: nothing to verify a merge base against.
      }),
      makeInventory(["manual/dev.md", "manual/api.md", "manual/vi/dev.md", "manual/vi/api.md"]),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );
    expect(error.message).toMatch(/1 pair\(s\) failed/);
    expect(error.message).toMatch(/manual-edit protection refused/);
    // The refusal is loud only after both authorities were tried: the
    // memory was sought at the resolved branch snapshot first, then at the
    // audited default snapshot — both reads pin a SHA, never a name.
    expect(forgeDouble.reads.filter((r) => r.path === TM_PATH).map((r) => r.ref)).toEqual([
      forgeDouble.baseSha,
      forgeDouble.baseSha,
    ]);
    // The refused pair consumed no pool slot and no model call.
    expect(chatDouble.calls()).toBe(1);
    const treeWrite = /** @type {{ args: [string, { path: string }[]] }} */ (
      /** @type {unknown} */ (forgeDouble.writes.find((w) => w.op === "createTree"))
    );
    expect(treeWrite.args[1].map((change) => change.path)).toEqual([
      "manual/vi/api.md",
      STATE_PATH,
      TM_PATH,
    ]);
    expect(forgeDouble.writes.filter((w) => w.op === "upsertPullRequest")).toHaveLength(1);
  });

  it("refuses a pair with a corrupted fingerprint before any model call", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // The fingerprint is a string, so the strict parser accepts the record;
    // drift cannot judge it and refuses to guess — and with no verifiable
    // base there is no merge path, so manual-edit protection refuses the
    // pair rather than publishing over bytes it cannot prove are not a
    // human edit.
    const corrupted = { ...viPublication(), translationFingerprint: "corrupted" };
    const chatDouble = chat([proposes(FRESH)]);
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": NEW_SOURCE, "manual/vi/dev.md": EDITED },
        state: renderState([corrupted]),
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/manual-edit protection refused/);
    expect(error.message).toMatch(/cannot prove what harmonise last published/);
    expect(chatDouble.calls()).toBe(0);
    expect(forgeDouble.writes).toEqual([]);
  });

  it("refuses a recorded pair whose target was deleted instead of recreating it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // The record survives but the destination's bytes are gone: drift cannot
    // judge what is not on disk, the policy preserves, and there are no
    // bytes to merge against — the deletion stands, loudly.
    const chatDouble = chat([proposes(FRESH)]);
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": OLD_SOURCE },
        state: renderState([viPublication()]),
        memory: memoryWith(VI_BASE_KEY, BASE),
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/manual-edit protection refused/);
    expect(error.message).toMatch(/the target is missing on disk/);
    expect(chatDouble.calls()).toBe(0);
    expect(forgeDouble.writes).toEqual([]);
  });

  it("converges a drift whose fresh side matches the base — the manual text is republished and the record catches up", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // The source is unchanged, so the fresh translation reproduces the
    // recorded publication; the merge then carries the manual edit alone,
    // and the record's fingerprint moves onto the merged bytes — the next
    // run sees a canonical target and skips.
    const chatDouble = chat([proposes(BASE)]);
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": OLD_SOURCE, "manual/vi/dev.md": EDITED },
        state: renderState([viPublication()]),
        memory: memoryWith(VI_BASE_KEY, BASE),
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    expect(chatDouble.calls()).toBe(1);
    const blobs = blobsOf(forgeDouble);
    expect(blobs[0]).toBe(EDITED);
    expect(logged(log)).toMatch(/three-way merge: 1 manual region\(s\) preserved, 0 fresh adopted/);
    const state = stateBlobOf(forgeDouble);
    expect(state.records[0]?.sourceFingerprint).toBe(contentFingerprint(OLD_SOURCE));
    expect(state.records[0]?.translationFingerprint).toBe(contentFingerprint(EDITED));
  });

  it("converges a drifted pair the model endorses — the record catches up to the disk", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // The source changed, so the model path runs; the model answers that the
    // manual edit on disk already conveys it (a noop). The endorsement
    // re-pins the record onto exactly the disk bytes with this run's
    // currency (#88, #95) — the old pin kept the stale fingerprint and the
    // pair re-translated forever.
    const chatDouble = chat([proposes(EDITED)]);
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": NEW_SOURCE, "manual/vi/dev.md": EDITED },
        state: renderState([viPublication()]),
        memory: memoryWith(VI_BASE_KEY, BASE),
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    expect(chatDouble.calls()).toBe(1);
    const out = logged(log);
    expect(out).toMatch(/\[existing\] unchanged/);
    expect(out).not.toMatch(/three-way merge/);
    // The record was re-pinned onto the endorsed bytes with this run's
    // source: nothing was merged or republished, and the manual edit is the
    // recorded publication now.
    const healed = viPublication({ source: NEW_SOURCE, translation: EDITED });
    expect(stateBlobOf(forgeDouble)).toEqual({ records: [healed] });
    // The endorsed bytes are in the memory under the healed record's key, so
    // a later manual edit on this pair still finds a verified base.
    expect(
      tmOf(forgeDouble).lookup(
        buildTmKey({
          sourceHash: contentFingerprint(NEW_SOURCE),
          targetLang: "vi",
          policyContext: POLICY,
        }),
      ),
    ).toBe(EDITED);
    // Second run: the pair is provably unchanged — zero model calls, zero
    // writes, the honest green run. The memory file is the one this run
    // published, prune included.
    const publishedMemory = /** @type {string} */ (
      blobsOf(forgeDouble)[blobsOf(forgeDouble).length - 1]
    );
    const secondForge = forge(
      makeRepo({
        documents: { "manual/dev.md": NEW_SOURCE, "manual/vi/dev.md": EDITED },
        state: renderState([healed]),
        memory: publishedMemory,
      }),
    );
    const secondChat = chat([new Error("the model must not be called")]);
    const secondIo = /** @type {any} */ ({ forge: secondForge, chat: secondChat, evidence });
    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), secondIo),
    ).resolves.toBeUndefined();
    expect(secondChat.calls()).toBe(0);
    expect(secondForge.writes).toEqual([]);
  });

  describe("run with the proposal branch unmerged", () => {
    // The proposal branch's tip as a prior run left it: state and memory
    // ride the branch, the default branch knows neither file yet.
    const BRANCH = "harmonise/en";
    const BRANCH_SHA = "b".repeat(40);

    /**
     * The branch snapshot: state and memory exactly as the publication
     * tests' single commit would have left them, on the branch tip.
     *
     * @param {{ state?: boolean, memory?: boolean }} [options]
     * @returns {Record<string, string>}
     */
    function branchFiles({ state = true, memory = true } = {}) {
      /** @type {Record<string, string>} */
      const files = {};
      if (state) files[STATE_PATH] = renderState([viPublication()]);
      if (memory) files[TM_PATH] = memoryWith(VI_BASE_KEY, BASE);
      return files;
    }

    /**
     * The forge double's reads of one path, in call order, by ref.
     *
     * @param {{ reads: { path: string, ref: string | undefined }[] }} forgeDouble
     * @param {string} path
     * @returns {(string | undefined)[]}
     */
    function readsOf(forgeDouble, path) {
      return forgeDouble.reads.filter((r) => r.path === path).map((r) => r.ref);
    }

    it("joins state to memory from the branch tip while the PR is open — TM reads stop at the branch", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const chatDouble = chat([proposes(FRESH)]);
      const forgeDouble = forge(
        makeRepo({
          documents: {
            "manual/dev.md": NEW_SOURCE,
            "manual/vi/dev.md": EDITED,
            // Neither advisory file on the default branch: the branch is the
            // only place they exist, exactly as while the PR is unmerged.
          },
        }),
        undefined,
        { branches: { [BRANCH]: { sha: BRANCH_SHA, files: branchFiles() } } },
      );
      const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

      await expect(
        run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
      ).resolves.toBeUndefined();

      expect(chatDouble.calls()).toBe(1);
      // The merge base resolved from the branch TM: the manual edit is
      // preserved and the fresh proposal adopted, never a refusal.
      const blobs = blobsOf(forgeDouble);
      expect(blobs[0]).toBe(MERGED);
      const out = logged(log);
      expect(out).toMatch(/three-way merge: 1 manual region\(s\) preserved, 1 fresh adopted/);
      expect(out).not.toMatch(/manual-edit protection refused/);
      // Both advisory files resolved from the branch tip alone — no
      // default-branch read for either, state or memory.
      expect(readsOf(forgeDouble, STATE_PATH)).toEqual([BRANCH_SHA]);
      expect(readsOf(forgeDouble, TM_PATH)).toEqual([BRANCH_SHA]);
      // The optimistic lock still guards the branch tip this run found.
      const branchWrite = /** @type {{ args: [string, string, string | null] }} */ (
        /** @type {unknown} */ (forgeDouble.writes.find((w) => w.op === "upsertBranch"))
      );
      expect(branchWrite.args[2]).toBe(BRANCH_SHA);
    });

    it("falls back to the default-branch memory when the branch carries state alone", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const chatDouble = chat([proposes(FRESH)]);
      const forgeDouble = forge(
        makeRepo({
          documents: {
            "manual/dev.md": NEW_SOURCE,
            "manual/vi/dev.md": EDITED,
            // The memory on the default branch: a past publication landed
            // there before the branch workflow, say — still joinable.
          },
          memory: memoryWith(VI_BASE_KEY, BASE),
        }),
        undefined,
        {
          branches: {
            [BRANCH]: { sha: BRANCH_SHA, files: branchFiles({ memory: false }) },
          },
        },
      );
      const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

      await expect(
        run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
      ).resolves.toBeUndefined();

      expect(chatDouble.calls()).toBe(1);
      // The join resolved across snapshots — branch state, default memory —
      // and the merge went through.
      expect(blobsOf(forgeDouble)[0]).toBe(MERGED);
      expect(logged(log)).toMatch(
        /three-way merge: 1 manual region\(s\) preserved, 1 fresh adopted/,
      );
      // State stopped at the branch; the memory read the branch first, then
      // fell through to the default branch.
      expect(readsOf(forgeDouble, STATE_PATH)).toEqual([BRANCH_SHA]);
      expect(readsOf(forgeDouble, TM_PATH)).toEqual([BRANCH_SHA, forgeDouble.baseSha]);
    });

    it("resolves the branch tip once — one ref read feeds both advisory files", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const chatDouble = chat([proposes(FRESH)]);
      const forgeDouble = forge(
        makeRepo({
          documents: { "manual/dev.md": NEW_SOURCE, "manual/vi/dev.md": EDITED },
        }),
        undefined,
        { branches: { [BRANCH]: { sha: BRANCH_SHA, files: branchFiles() } } },
      );
      const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

      await expect(
        run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
      ).resolves.toBeUndefined();

      // The branch tip was resolved exactly once this run, and both advisory
      // reads pinned to that one SHA: a push landing between two reads can
      // never pair a state from one commit with a memory from another (#148).
      expect(forgeDouble.refLookups.filter((name) => name === BRANCH)).toHaveLength(1);
      expect(readsOf(forgeDouble, STATE_PATH)).toEqual([BRANCH_SHA]);
      expect(readsOf(forgeDouble, TM_PATH)).toEqual([BRANCH_SHA]);
    });
    it("migrates a pre-#156 repository in one cycle — legacy names read once, suffixed names published", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const chatDouble = chat([proposes(FRESH)]);
      // The branch carries only the un-suffixed names: a proposal opened
      // before the suffix landed — exactly what a mid-migration repository
      // holds while the first suffixed publication is still unmerged.
      const forgeDouble = forge(
        makeRepo({
          documents: {
            "manual/dev.md": NEW_SOURCE,
            "manual/vi/dev.md": EDITED,
          },
        }),
        undefined,
        {
          branches: {
            [BRANCH]: {
              sha: BRANCH_SHA,
              files: {
                [LEGACY_STATE_PATH]: renderState([viPublication()]),
                [LEGACY_TM_PATH]: memoryWith(VI_BASE_KEY, BASE),
              },
            },
          },
        },
      );
      const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

      await expect(
        run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
      ).resolves.toBeUndefined();

      expect(chatDouble.calls()).toBe(1);
      // The join resolved through the legacy names — the merge went through.
      expect(blobsOf(forgeDouble)[0]).toBe(MERGED);
      // The legacy files were read at the branch tip, and the publication
      // wrote ONLY the suffixed names: this commit ends the fallback for
      // every later run.
      expect(readsOf(forgeDouble, LEGACY_STATE_PATH)).toEqual([BRANCH_SHA]);
      expect(readsOf(forgeDouble, LEGACY_TM_PATH)).toEqual([BRANCH_SHA]);
      const treeWrite = /** @type {{ args: [string, { path: string }[]] }} */ (
        /** @type {unknown} */ (forgeDouble.writes.find((w) => w.op === "createTree"))
      );
      expect(treeWrite.args[1].map((change) => change.path)).toEqual([
        "manual/vi/dev.md",
        STATE_PATH,
        TM_PATH,
      ]);
    });
  });
});

describe("run with language-suffixed advisory files (#156)", () => {
  // Shape 1 of the #156 design note: the source language names the
  // publishing branch and the advisory files it owns alike. Concurrent runs
  // for different languages write disjoint file sets, and a repository with
  // no advisory files anywhere behaves exactly as it always has.

  it("publishes only the language-suffixed advisory files on a fresh repository", async () => {
    // Zero-config parity: no advisory file, no branch, no legacy paths —
    // the run behaves exactly as before and publishes the suffixed names.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const forgeDouble = forge(makeRepo());
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: echoingChat(), evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    const treeWrite = /** @type {{ args: [string, { path: string }[]] }} */ (
      /** @type {unknown} */ (forgeDouble.writes.find((w) => w.op === "createTree"))
    );
    expect(treeWrite.args[1].map((change) => change.path)).toEqual([
      "manual/vi/dev.md",
      statePath("en"),
      tmPath("en"),
    ]);
  });

  it("keeps a second source language's run out of the first language's advisory files", async () => {
    // The en run's proposal already landed — its suffixed advisory files
    // sit on the default branch. The fr run must neither read nor write
    // them: disjoint file sets are what removes the merge collision (#156).
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const forgeDouble = forge(
      makeRepo({
        config: makeConfig({
          sourceLanguage: "fr",
          languages: { fr: "manual-fr/{document}.md", vi: "manual/vi/{document}.md" },
        }),
        documents: {
          "manual-fr/dev.md": "# Dev\n\nProse.\n",
          [statePath("en")]: renderState([]),
          [tmPath("en")]: serializeTm(createTmStore()),
        },
      }),
      makeInventory(["manual-fr/dev.md", "manual/vi/dev.md"]),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: echoingChat(), evidence });
    const env = { ...runner, "INPUT_SOURCE-LANGUAGE": "fr" };

    await expect(
      run({ ...readInputs(env), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    const branchWrite = /** @type {{ args: [string, string, string | null] }} */ (
      /** @type {unknown} */ (forgeDouble.writes.find((w) => w.op === "upsertBranch"))
    );
    // The branch key follows the source language, the same key the advisory
    // file names are suffixed by.
    expect(branchWrite.args[0]).toBe("harmonise/fr");
    const treeWrite = /** @type {{ args: [string, { path: string }[]] }} */ (
      /** @type {unknown} */ (forgeDouble.writes.find((w) => w.op === "createTree"))
    );
    expect(treeWrite.args[1].map((change) => change.path)).toEqual([
      "manual/vi/dev.md",
      statePath("fr"),
      tmPath("fr"),
    ]);
    // The en files were never read — not for state, not for memory.
    const enPaths = [statePath("en"), tmPath("en")];
    expect(forgeDouble.reads.filter((r) => enPaths.includes(r.path))).toEqual([]);
  });
});

describe("run with frontmatter", () => {
  const FM_SOURCE = "---\ntitle: Dev guide\nslug: dev\n---\n\n# Dev\n\nProse.\n";
  const FM_TRANSLATED = "---\ntitle: Guide de dev\nslug: dev\n---\n\n# Dev\n\nProse.\n";

  /**
   * A chat double that echoes the prepared source through a transform — an
   * honest translation of the translatable parts, tokens and structure kept
   * — and captures every request for assertion.
   *
   * @param {(source: string) => string} translate
   * @returns {{ calls: () => number, userContent: () => string, complete: import("#core/chat.mjs").Chat["complete"] }}
   */
  function translatingChat(translate) {
    /** @type {string[]} */
    const users = [];
    let calls = 0;
    return {
      calls: () => calls,
      userContent: () => users[users.length - 1] ?? "",
      async complete(request) {
        calls++;
        const user = request.messages[request.messages.length - 1]?.content ?? "";
        users.push(user);
        const start = user.indexOf("[source-document]\n");
        if (start < 0) {
          return {
            content: JSON.stringify({ drift: true, summary: "nothing found", content: "??" }),
            toolCalls: [],
            finishReason: undefined,
          };
        }
        const from = start + "[source-document]\n".length;
        const nextBlock = user.indexOf("\n\n[", from);
        const source = nextBlock === -1 ? user.slice(from) : user.slice(from, nextBlock);
        return {
          content: JSON.stringify({
            drift: true,
            summary: "kept in step",
            content: translate(source),
          }),
          toolCalls: [],
          finishReason: undefined,
        };
      },
    };
  }

  it("masks protected frontmatter in the prompt and restores it byte-for-byte on publication", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const chatDouble = translatingChat((masked) =>
      masked.replace("title: Dev guide", "title: Guide de dev"),
    );
    const forgeDouble = forge(makeRepo({ documents: { "manual/dev.md": FM_SOURCE } }));
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    // The prompt carried the protected slug as a placeholder, never its value.
    const user = chatDouble.userContent();
    expect(user).toMatch(/slug: \[\[harmonise:[0-9a-f]{16}:f1\]\]/);
    expect(user).not.toMatch(/slug: dev/);
    // The published bytes restored the slug exactly and kept the translation.
    const published = /** @type {any} */ (
      forgeDouble.writes.find(
        (w) =>
          w.op === "createBlob" &&
          typeof w.args[0] === "string" &&
          w.args[0].startsWith("---\ntitle: Guide de dev"),
      )
    );
    expect(published.args[0]).toBe(FM_TRANSLATED);
    expect(logged(log)).toMatch(/blocks=whole-file/);
  });

  it("refuses a translation that alters a protected frontmatter value", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const tampered = "---\ntitle: Guide de dev\nslug: autre\n---\n\n# Dev\n\nProse.\n";
    const chatDouble = chat([proposes(tampered), proposes(tampered)]);
    const ioDouble = /** @type {any} */ ({
      forge: forge(makeRepo({ documents: { "manual/dev.md": FM_SOURCE } })),
      chat: chatDouble,
      evidence,
    });

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/frontmatter validation failed/);
    expect(error.message).toMatch(/slug/);
    expect(error.message).toMatch(/classified refusal, give-up/);
    expect(chatDouble.calls()).toBe(1);
  });

  it("refuses to translate a document whose frontmatter does not parse", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const chatDouble = chat([new Error("the model must not be called")]);
    const ioDouble = /** @type {any} */ ({
      forge: forge(
        makeRepo({
          documents: { "manual/dev.md": "---\ntitle: a\ntitle: b\n---\n\n# Dev\n\nProse.\n" },
        }),
      ),
      chat: chatDouble,
      evidence,
    });

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair skipped/);
    expect(error.message).toMatch(/frontmatter protection refused/);
    expect(error.message).toMatch(/declared twice/);
    expect(chatDouble.calls()).toBe(0);
  });

  it("refuses an answer that forges a frontmatter token in prose", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const chatDouble = translatingChat(
      (masked) =>
        `${masked.replace("title: Dev guide", "title: Guide de dev")}\n\nVoir [[harmonise:deadbeefdeadbeef:f9]].\n`,
    );
    const ioDouble = /** @type {any} */ ({
      forge: forge(makeRepo({ documents: { "manual/dev.md": FM_SOURCE } })),
      chat: chatDouble,
      evidence,
    });

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/which this run never minted/);
    expect(error.message).toMatch(/classified refusal, give-up/);
    expect(chatDouble.calls()).toBe(1);
  });
});

describe("run with a translation memory", () => {
  const SOURCE = "# Dev\n\nProse.\n";

  /**
   * @param {string} key a key as `buildTmKey` produces
   * @param {string} value
   * @returns {string} a serialized TM carrying exactly one entry
   */
  function memoryWith(key, value) {
    const store = createTmStore();
    store.record(key, value);
    return serializeTm(store);
  }

  /**
   * A chat double that echoes the prepared source through a transform and
   * captures every request.
   *
   * @param {(source: string) => string} translate
   * @returns {{ calls: () => number, userContent: () => string, complete: import("#core/chat.mjs").Chat["complete"] }}
   */
  function translatingChat(translate) {
    /** @type {string[]} */
    const users = [];
    let calls = 0;
    return {
      calls: () => calls,
      userContent: () => users[users.length - 1] ?? "",
      async complete(request) {
        calls++;
        const user = request.messages[request.messages.length - 1]?.content ?? "";
        users.push(user);
        const start = user.indexOf("[source-document]\n");
        if (start < 0) {
          return {
            content: JSON.stringify({ drift: true, summary: "nothing found", content: "??" }),
            toolCalls: [],
            finishReason: undefined,
          };
        }
        const from = start + "[source-document]\n".length;
        const nextBlock = user.indexOf("\n\n[", from);
        const source = nextBlock === -1 ? user.slice(from) : user.slice(from, nextBlock);
        return {
          content: JSON.stringify({
            drift: true,
            summary: "kept in step",
            content: translate(source),
          }),
          toolCalls: [],
          finishReason: undefined,
        };
      },
    };
  }

  it("offers no prior translation when the memory is absent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const chatDouble = translatingChat((source) => source.replace("Prose.", "Traduit."));
    const forgeDouble = forge(makeRepo({ documents: { "manual/dev.md": SOURCE } }));
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: true }, context(), ioDouble),
    ).resolves.toBeUndefined();

    expect(chatDouble.userContent()).not.toMatch(/prior-accepted-translation/);
  });

  it("renders a memory hit as context and still validates what comes back", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const source = "# Dev\n\n```js\nkeep()\n```\n";
    const prior = "# Dev\n\nTraduit.\n\n```js\nkeep()\n```\n";
    const key = buildTmKey({
      sourceHash: contentFingerprint(source),
      targetLang: "vi",
      policyContext: POLICY,
    });
    // The model returns the prior text but drops the fence — a structural
    // violation that proves validation still runs on a TM-shaped answer.
    const chatDouble = chat([proposes("# Dev\n\nTraduit.\n"), proposes("# Dev\n\nTraduit.\n")]);
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": source },
        memory: memoryWith(key, prior),
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/structural validation failed/);
    expect(error.message).toMatch(/fenced code block count changed/);
    expect(error.message).toMatch(/classified refusal, give-up/);
    expect(chatDouble.calls()).toBe(1);
  });

  it("renders the prior-accepted-translation block in the prompt when the memory hits", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const prior = "# Dev\n\nTraduit.\n";
    const key = buildTmKey({
      sourceHash: contentFingerprint(SOURCE),
      targetLang: "vi",
      policyContext: POLICY,
    });
    const chatDouble = translatingChat((source) => source.replace("Prose.", "Traduit à nouveau."));
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": SOURCE },
        memory: memoryWith(key, prior),
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: true }, context(), ioDouble),
    ).resolves.toBeUndefined();

    const user = chatDouble.userContent();
    expect(user).toMatch(/\[prior-accepted-translation\]/);
    expect(user).toContain(prior);
  });

  it("degrades a corrupt memory file to an empty store and completes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const chatDouble = translatingChat((source) => source.replace("Prose.", "Traduit."));
    const forgeDouble = forge(
      makeRepo({
        documents: { "manual/dev.md": SOURCE },
        memory: "{ not json",
      }),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: true }, context(), ioDouble),
    ).resolves.toBeUndefined();

    expect(chatDouble.userContent()).not.toMatch(/prior-accepted-translation/);
  });

  it("records each proposed pair in the memory blob the same commit publishes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const translated = "# Dev\n\nTraduit.\n";
    const chatDouble = chat([proposes(translated)]);
    const forgeDouble = forge(makeRepo({ documents: { "manual/dev.md": SOURCE } }));
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();
    // The memory blob is the one carrying an "entries" array — distinct from
    // the state blob, which carries "records".
    const tmWrite = /** @type {any} */ (
      forgeDouble.writes.find(
        (w) =>
          w.op === "createBlob" && typeof w.args[0] === "string" && w.args[0].includes('"entries"'),
      )
    );
    const doc = JSON.parse(tmWrite.args[0]);
    expect(doc.tmSchemaVersion).toBe(TM_SCHEMA_VERSION);
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].key).toEqual({
      sourceHash: contentFingerprint(SOURCE),
      targetLang: "vi",
      policyContext: POLICY,
    });
    expect(doc.entries[0].value).toBe(translated);
  });
});

describe("run with a bounded-concurrency pool", () => {
  const CONFIG_2 = makeConfig({
    languages: {
      en: "manual/{document}.md",
      vi: "manual/vi/{document}.md",
      fr: "manual/fr/{document}.md",
    },
    concurrency: 2,
  });

  const SOURCE_DEV = "# Dev\n\nProse.\n";
  const SOURCE_API = "# Api\n\nReference.\n";
  const SOURCE_GUIDE = "# Guide\n\nWalkthrough.\n";

  /**
   * @param {number} ticks
   * @returns {Promise<void>}
   */
  function delay(ticks) {
    if (ticks <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let remaining = ticks;
      const tick = () => {
        remaining--;
        if (remaining <= 0) resolve();
        else setImmediate(tick);
      };
      setImmediate(tick);
    });
  }

  /**
   * A chat double that tracks in-flight concurrency, finishes calls out of
   * order, and can fail selected calls. `plan[i]` governs call `i` (calls are
   * issued in walk order): `{ delay }` waits `delay` macrotask ticks before
   * completing with an honest echo; `{ fail: "message" }` throws.
   *
   * @param {Array<{ delay?: number, fail?: string }>} plan
   * @returns {{
   *   peak: () => number,
   *   calls: () => number,
   *   completions: () => string[],
   *   complete: import("#core/chat.mjs").Chat["complete"],
   * }}
   */
  function pooledChat(plan) {
    let issued = 0;
    let inFlight = 0;
    let peak = 0;
    /** @type {string[]} */
    const completions = [];
    return {
      peak: () => peak,
      calls: () => issued,
      completions: () => /** @type {string[]} */ ([...completions]),
      async complete(request) {
        const index = issued++;
        const step = plan[Math.min(index, plan.length - 1)] ?? { delay: 0 };
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          if (step.fail !== undefined) throw new Error(step.fail);
          const user = request.messages[request.messages.length - 1]?.content ?? "";
          const start = user.indexOf("[source-document]\n");
          let source = "";
          if (start >= 0) {
            const from = start + "[source-document]\n".length;
            const nextBlock = user.indexOf("\n\n[", from);
            source = nextBlock === -1 ? user.slice(from) : user.slice(from, nextBlock);
          }
          await delay(step.delay ?? 0);
          completions.push(`call${index}`);
          return {
            content: JSON.stringify({ drift: true, summary: "kept in step", content: source }),
            toolCalls: [],
            finishReason: undefined,
          };
        } finally {
          inFlight -= 1;
        }
      },
    };
  }

  it("translates under the declared bound and finishes in pair order, not completion order", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const plan = [{ delay: 5 }, { delay: 0 }, { delay: 0 }, { delay: 0 }];
    const chatDouble = pooledChat(plan);
    const forgeDouble = forge(
      makeRepo({
        config: CONFIG_2,
        documents: { "manual/dev.md": SOURCE_DEV, "manual/api.md": SOURCE_API },
      }),
      makeInventory(["manual/dev.md", "manual/api.md"]),
    );
    /** @type {number[]} */
    const atBlob = [];
    const origBlob = forgeDouble.createBlob.bind(forgeDouble);
    forgeDouble.createBlob = /** @type {any} */ (
      async (/** @type {string} */ content) => {
        atBlob.push(chatDouble.completions().length);
        return origBlob(content);
      }
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    // The cap held: two lanes ran and peaked at exactly 2 in flight.
    expect(chatDouble.peak()).toBe(2);
    expect(chatDouble.calls()).toBe(4);
    // Completion order was genuinely scrambled — the slow pair finished last.
    expect(chatDouble.completions()).toEqual(["call1", "call2", "call3", "call0"]);

    // The report and the publication order are pair-identity, not completion
    // order: pairs walk slug-sorted sources × alphabetized targets —
    // fr→api, vi→api, fr→dev, vi→dev.
    const out = logged(log);
    const translated = [...out.matchAll(/translated (vi|fr) manual\/(dev|api)\.md/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(translated).toEqual(["fr api", "vi api", "fr dev", "vi dev"]);

    // Publication happened once, after every pooled pair settled.
    expect(forgeDouble.writes.map((w) => w.op)).toEqual([
      "createBlob",
      "createBlob",
      "createBlob",
      "createBlob",
      "createBlob",
      "createBlob",
      "createTree",
      "createCommit",
      "upsertBranch",
      "upsertPullRequest",
    ]);
    // Every blob was created only after all four model completions.
    for (const n of atBlob) expect(n).toBe(4);
  });

  it("skipped pairs consume no slot and no model call", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Recorded state: vi/dev is unchanged, api pairs go to the model.
    const viRecord = {
      schemaVersion: STATE_SCHEMA_VERSION,
      sourcePath: "manual/dev.md",
      destinationPath: "manual/vi/dev.md",
      language: "vi",
      sourceFingerprint: contentFingerprint(SOURCE_DEV),
      translationFingerprint: contentFingerprint("# Dev\n\nTraduit.\n"),
      policyFingerprint: POLICY,
      transformationVersion: TRANSFORMATION_VERSION,
    };
    const plan = [{ delay: 0 }, { delay: 0 }, { delay: 0 }];
    const chatDouble = pooledChat(plan);
    const forgeDouble = forge(
      makeRepo({
        config: CONFIG_2,
        documents: {
          "manual/dev.md": SOURCE_DEV,
          "manual/vi/dev.md": "# Dev\n\nTraduit.\n",
          "manual/api.md": SOURCE_API,
        },
        state: renderState([viRecord]),
      }),
      makeInventory(["manual/dev.md", "manual/vi/dev.md", "manual/api.md"]),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    // The unchanged pair never reached the model; the other three did.
    expect(chatDouble.calls()).toBe(3);
    expect(chatDouble.peak()).toBe(2);

    const out = logged(log);
    // The skip line is positioned before the fr/dev model line, in walk order.
    const skipIdx = out.indexOf("unchanged-skipped vi manual/dev.md → manual/vi/dev.md");
    const frDevIdx = out.indexOf("translated fr manual/dev.md → manual/fr/dev.md");
    expect(skipIdx).toBeGreaterThan(-1);
    // The skip fills its walk slot — dev is the last slug, vi the last
    // target, so the skip line lands after every translated line.
    expect(skipIdx).toBeGreaterThan(frDevIdx);
    // The unchanged destination is not proposed — it never lands in the tree.
    const tree = /** @type {{ args: unknown[] }} */ (
      forgeDouble.writes.find((w) => w.op === "createTree")
    );
    const paths = /** @type {{ path: string }[]} */ (tree.args[1]).map((c) => c.path);
    expect(paths).not.toContain("manual/vi/dev.md");
  });

  it("keeps a failing pair contained and follows the failure policy", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Call 1 is api→vi's first attempt; its one policy retry is call 2 — a
    // plain failure classifies `unknown`, and the policy grants unknown
    // exactly one retry. Both fail; every other call succeeds with
    // controlled timing, so the failure happens while a sibling is in
    // flight.
    const plan = [
      { delay: 0 },
      { fail: "provider overloaded" },
      { fail: "provider overloaded" },
      { delay: 0 },
      { delay: 0 },
    ];
    const chatDouble = pooledChat(plan);
    const forgeDouble = forge(
      makeRepo({
        config: CONFIG_2,
        documents: { "manual/dev.md": SOURCE_DEV, "manual/api.md": SOURCE_API },
      }),
      makeInventory(["manual/dev.md", "manual/api.md"]),
    );
    const ioDouble = /** @type {any} */ ({
      forge: forgeDouble,
      chat: chatDouble,
      evidence,
      // The policy's wait between the failure and its one retry, replaced
      // so the controlled timing below stays exact.
      sleep: async () => undefined,
    });

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );
    expect(error.message).toMatch(/1 pair\(s\) failed/);
    expect(error.message).toMatch(/vi manual\/api\.md: provider overloaded/);
    expect(error.message).toMatch(/classified unknown, exhausted/);

    // The pool never aborted on the failure: the pair's retry ran (five
    // calls total) and the sibling lanes finished their work.
    expect(chatDouble.calls()).toBe(5);
    expect(chatDouble.peak()).toBe(2);

    // Publication happened first — the three healthy pairs published.
    expect(forgeDouble.writes.map((w) => w.op)).toContain("upsertPullRequest");
    const out = logged(log);
    expect(out).toMatch(/translated fr manual\/api\.md/);
    expect(out).toMatch(/translated fr manual\/dev\.md/);
    expect(out).toMatch(/translated vi manual\/dev\.md/);
    expect(out).toMatch(/failed vi manual\/api\.md/);
  });

  it("refuses an invalid concurrency at startup", async () => {
    const bad = [0, -1, 2.5, "3"];
    for (const value of bad) {
      // The test feeds concurrency values the schema refuses; the builder
      // types the valid shape, so the raw value is smuggled through.
      const config = makeConfig({ concurrency: /** @type {number} */ (value) });
      const chatDouble = chat([new Error("the model must not be called")]);
      const forgeDouble = forge(makeRepo({ config, documents: { "manual/dev.md": SOURCE_DEV } }));
      const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

      await expect(run(readInputs(runner), context(), ioDouble)).rejects.toThrow(
        /concurrency must be a positive integer/,
      );
      expect(chatDouble.calls()).toBe(0);
    }
  });

  it("caps the declared bound at the module maximum", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const config = makeConfig({
      languages: {
        en: "manual/{document}.md",
        vi: "manual/vi/{document}.md",
        fr: "manual/fr/{document}.md",
      },
      concurrency: 50,
    });
    // Three sources × two targets = six pairs — more than the cap of four.
    const plan = [
      { delay: 0 },
      { delay: 0 },
      { delay: 0 },
      { delay: 0 },
      { delay: 0 },
      { delay: 0 },
    ];
    const chatDouble = pooledChat(plan);
    const forgeDouble = forge(
      makeRepo({
        config,
        documents: {
          "manual/dev.md": SOURCE_DEV,
          "manual/api.md": SOURCE_API,
          "manual/guide.md": SOURCE_GUIDE,
        },
      }),
      makeInventory(["manual/dev.md", "manual/api.md", "manual/guide.md"]),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    // Six calls ran but never more than four at once — the cap held.
    expect(chatDouble.calls()).toBe(6);
    expect(chatDouble.peak()).toBe(4);
  });

  it("degrades a corrupt state file and memory to the model path under the pool", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const plan = [{ delay: 0 }, { delay: 0 }, { delay: 0 }, { delay: 0 }];
    const chatDouble = pooledChat(plan);
    const forgeDouble = forge(
      makeRepo({
        config: CONFIG_2,
        documents: { "manual/dev.md": SOURCE_DEV, "manual/api.md": SOURCE_API },
        state: "{ this is not json",
        memory: "{ not json",
      }),
      makeInventory(["manual/dev.md", "manual/api.md"]),
    );
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });

    await expect(
      run({ ...readInputs(runner), dryRun: false }, context(), ioDouble),
    ).resolves.toBeUndefined();

    // Every pair degraded to the model path; the pool ran at the bound.
    expect(chatDouble.calls()).toBe(4);
    expect(chatDouble.peak()).toBe(2);
  });
});

describe("main", () => {
  it("turns a refusal into a failed step, not a green one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await main(runner, () => Promise.reject(new Error("the work refused")));

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/the work refused/);
    expect(process.exitCode).toBe(1);
  });

  it("masks the key before it writes anything else", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(runner, () => Promise.reject(new Error("stopped early")));

    expect(log.mock.calls[0]?.[0]).toBe("::add-mask::sk-secret");
  });

  it("reports success when the work succeeds", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await main(runner, () => Promise.resolve());

    expect(result).toEqual({ ok: true });
    expect(process.exitCode).toBe(0);
  });

  it("fails on a missing required input without reaching the work", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const incomplete = { ...runner };
    delete incomplete["INPUT_API-URL"];

    const result = await main(incomplete, () => Promise.reject(new Error("must not run")));

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/'api-url'/);
  });

  it("names itself", () => {
    expect(ACTION).toBe("harmonise");
  });
});
