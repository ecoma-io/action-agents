// Mutation ceilings — where a hostile input must stop the run before any
// write, and where a write must not repeat itself.
//
// Three ceilings, three attacks:
//
//   1. A change list at GitHub's own 3000-file ceiling, served across Link
//      pages. A run that measured past the ceiling would guess, and a model
//      asked about it is a model invited to invent. The ceiling must fire
//      before the model is ever invoked, and pagination must not hide it.
//   2. `createComment` under a scripted 503. Creating is the one non-
//      idempotent write, so a retried 503 could land two copies of one
//      comment. Exactly one attempt is the ceiling (`maxAttempts: 1`).
//   3. `upsertBranch` whose tip moved between the run's first read and its
//      ref update. Overwriting a concurrent change silently is the failure
//      optimistic locking exists to prevent: refused as `BranchMovedError`,
//      never force-written over.
//
// The run-level ceiling test drives `triage/src/index.mjs` `run()` with a
// recording forge and counts model invocations; the forge-level tests drive
// the real `createForge` through a scripted fetch, so the ceilings asserted
// are the production walker's own, not a fake's. Deterministic and offline.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEvidence } from "#core/untrusted.mjs";
import { BranchMovedError, ForgeError, PastFileCeilingError, createForge } from "#core/forge.mjs";
import { readContext } from "#core/runtime.mjs";
import { HttpError } from "#core/transport-errors.mjs";

import { readInputs, run } from "../../../triage/src/index.mjs";

/**
 * A complete runner environment — the same fixture the triage unit suite
 * drives.
 *
 * @type {import("#core/runtime.mjs").Env}
 */
const runner = {
  "INPUT_GITHUB-TOKEN": "ghs_x",
  "INPUT_API-URL": "https://api.example/v1",
  "INPUT_API-KEY": "sk-secret",
  INPUT_MODEL: "gpt-x",
  GITHUB_REPOSITORY: "ecoma-io/action-agents",
  GITHUB_WORKSPACE: "/work",
  GITHUB_EVENT_NAME: "issues",
  GITHUB_EVENT_PATH: "/work/event.json",
};

/** The sheet the runs act against: universal ∪ pr, with the size ladder. */
const CONFIG = JSON.stringify({
  labels: {
    universal: { bug: "Incorrect behaviour.", docs: "Documentation only." },
    issues: { question: "Asking, not reporting." },
    pr: {
      breaking: "Consumers must act.",
      "size/xs": "",
      "size/s": "",
      "size/xl": "",
    },
  },
  size: {
    exclude: ["pnpm-lock.yaml"],
    ladder: [{ upTo: 10, label: "size/xs" }, { upTo: 50, label: "size/s" }, { label: "size/xl" }],
  },
});

const REPO_LABELS = ["bug", "docs", "question", "breaking", "size/xs", "size/s", "size/xl"];

function prEvent() {
  return {
    pull_request: {
      number: 8,
      title: "Fix the import",
      body: "What changed.",
      labels: [],
      base: { ref: "main" },
    },
    repository: { name: "action-agents", description: "AI GitHub Actions" },
  };
}

/**
 * A recording forge whose files listing mirrors the production ceiling
 * exactly as the unit suite does: a list at past 3000 files is
 * `PastFileCeilingError`, never handed onward.
 *
 * @param {object} [options]
 * @param {import("#core/forge.mjs").PullRequestFile[]} [options.prFiles]
 */
function fakeForge(options = {}) {
  return {
    async getRepository() {
      return { defaultBranch: "main", name: "action-agents", description: "" };
    },
    async getPullRequest() {
      return {
        number: 8,
        state: "open",
        draft: false,
        merged: false,
        title: "",
        body: "",
        head: { ref: "x", sha: "0".repeat(40) },
        base: { ref: "main", sha: "0".repeat(40) },
      };
    },
    async createBlob() {
      return { sha: "0".repeat(40) };
    },
    async createTree() {
      return { sha: "0".repeat(40) };
    },
    async createCommit() {
      return { sha: "0".repeat(40) };
    },
    async upsertBranch() {},
    async upsertPullRequest() {
      return { number: 1, created: false };
    },
    async getRef() {
      return { sha: "0".repeat(40) };
    },
    async readRef() {
      return { sha: "0".repeat(40) };
    },
    async listTree() {
      return [];
    },
    /** @param {string} path */
    async getContents(path) {
      return path.includes("triage.json5") ? { content: CONFIG } : null;
    },
    async listRepositoryLabels() {
      return REPO_LABELS;
    },
    async listRepositoryLabelsDetailed() {
      return REPO_LABELS.map((name) => ({ name, description: "", color: "" }));
    },
    /** @param {number} number */
    async listPullRequestFiles(number) {
      if (options.prFiles !== undefined && options.prFiles.length >= 3000) {
        throw new PastFileCeilingError(number, options.prFiles.length);
      }
      return options.prFiles ?? [];
    },
    async addLabels() {},
    async removeLabel() {},
    async listComments() {
      return [];
    },
    async createComment() {
      return { id: 1 };
    },
    async updateComment() {},
    async deleteComment() {},
    async whoami() {
      return { login: "action-agents[bot]" };
    },
  };
}

/**
 * The whole world `run` touches, with a model seam that counts every
 * invocation — the ordering pin for "refused before the model is asked".
 *
 * @param {Parameters<typeof fakeForge>[0]} [options]
 */
function io(options = {}) {
  const forge = fakeForge(options);
  /** @type {{ calls: number }} */
  const chat = { calls: 0 };
  return {
    forge,
    chatCalls: () => chat.calls,
    chat: {
      async complete() {
        chat.calls++;
        throw new Error("the model must never be asked");
      },
    },
    evidence: createEvidence(() => "aaaabbbb"),
    now: () => Date.parse("2026-07-01T11:00:00Z"),
    readEvent: async () => prEvent(),
  };
}

/** @param {Partial<ReturnType<typeof readInputs>>} [overrides] */
function inputs(overrides = {}) {
  return { ...readInputs(runner), dryRun: false, ...overrides };
}

/** The context of a pull_request run, from the same fixture. */
const prContext = { ...readContext(runner), eventName: "pull_request" };

/** A forge client wired to a scripted provider. */
function testForge(fetchImpl) {
  return createForge({
    owner: "ecoma-io",
    repo: "action-agents",
    token: "ghs_x",
    apiUrl: "https://api.example",
    fetchImpl,
  });
}

/** @returns {{ filename: string, status: string, additions: number, deletions: number }} */
function fileEntry(index, page) {
  return {
    filename: `lib/f${String(page * 100 + index)}.mjs`,
    status: "modified",
    additions: 1,
    deletions: 0,
  };
}

describe("triage — the files-listing ceiling fires before the model is asked", () => {
  it("a 3000-file change list raises PastFileCeilingError with zero chat calls", async () => {
    const world = io({
      prFiles: Array.from({ length: 3000 }, (_, index) => fileEntry(index, 0)),
    });

    await assert.rejects(run(inputs(), prContext, world), PastFileCeilingError);
    assert.equal(world.chatCalls(), 0, "the model must not be asked about an unmeasurable diff");
  });
});

describe("forge — the real walker, scripted", () => {
  it("keeps the ceiling across Link pagination — 30 pages still refuse, never a partial read", async () => {
    const calls = [];
    let page = 1;
    const fetchImpl = async (url) => {
      calls.push(String(url));
      const body = Array.from({ length: 100 }, (_, index) => fileEntry(index, page - 1));
      const link =
        page < 30
          ? `<https://api.example/repos/ecoma-io/action-agents/pulls/8/files?per_page=100&page=${String(page + 1)}>; rel="next"`
          : "";
      page++;
      return new Response(JSON.stringify(body), { status: 200, headers: { link } });
    };
    const forge = testForge(fetchImpl);

    await assert.rejects(forge.listPullRequestFiles(8), PastFileCeilingError);

    assert.equal(calls.length, 30, "every page was walked before the ceiling fired");
    for (const call of calls) {
      assert.ok(
        call.includes("/pulls/8/files") && call.includes("per_page=100"),
        "the walker only ever asked the files listing, paged",
      );
    }
  });

  it("createComment under a scripted 503 makes exactly one attempt — no retry into a duplicate", async () => {
    let calls = 0;
    const forge = testForge(async () => {
      calls++;
      return new Response("service unavailable", { status: 503 });
    });

    const error = await forge.createComment(7, "hello").catch((cause) => cause);

    assert.ok(error instanceof ForgeError, "the refusal is the forge's typed failure");
    assert.ok(error.cause instanceof HttpError, "the cause is the typed HTTP refusal");
    assert.equal(error.cause.status, 503, "the provider's 503 is the reason, not a guessed class");
    assert.equal(calls, 1, "a non-idempotent create must not be retried");
  });

  it("upsertBranch refuses a tip that moved between the read and the write", async () => {
    const EXPECTED = "a".repeat(40);
    const MOVED = "b".repeat(40);
    const COMMIT = "c".repeat(40);
    let refReads = 0;
    /** @type {{ method: string, url: string }[]} */
    const writes = [];
    const forge = testForge(async (url, init) => {
      const target = new URL(String(url));
      const path = decodeURIComponent(target.pathname);
      if (path.endsWith("/git/ref/heads/harmonise/x") && (init?.method ?? "GET") === "GET") {
        refReads++;
        const sha = refReads === 1 ? EXPECTED : MOVED;
        return new Response(JSON.stringify({ object: { sha } }), { status: 200 });
      }
      writes.push({ method: init?.method ?? "GET", url: target.pathname });
      return new Response("{}", { status: 200 });
    });

    const error = await forge.upsertBranch("harmonise/x", COMMIT, EXPECTED).catch((cause) => cause);

    assert.ok(error instanceof BranchMovedError, "the moved tip is refused by name");
    assert.equal(refReads, 2, "the tip was read once and re-read once before the write");
    assert.deepEqual(writes, [], "no ref write was ever attempted over the moved tip");
  });

  it("upsertBranch refuses to create over a ref that appeared under the run", async () => {
    const EXPECTED = "a".repeat(40);
    const COMMIT = "c".repeat(40);
    /** @type {{ method: string, url: string }[]} */
    const writes = [];
    const forge = testForge(async (url, init) => {
      const target = new URL(String(url));
      const path = decodeURIComponent(target.pathname);
      if (path.endsWith("/git/ref/heads/harmonise/y")) {
        return new Response("not found", { status: 404 });
      }
      writes.push({ method: init?.method ?? "GET", url: target.pathname });
      return new Response("{}", { status: 200 });
    });

    const error = await forge.upsertBranch("harmonise/y", COMMIT, EXPECTED).catch((cause) => cause);

    assert.ok(error instanceof BranchMovedError, "the appeared ref is refused by name");
    assert.deepEqual(writes, [], "no ref create was attempted over a tip the run did not read");
  });

  it("upsertBranch with a stable tip performs exactly the one force-update it was asked for", async () => {
    // The control: the harness above refuses real writes; this proves the
    // warnings are not the stub's paranoia — a stable tip gets its PATCH.
    const EXPECTED = "a".repeat(40);
    const COMMIT = "c".repeat(40);
    let refReads = 0;
    let wrote = false;
    /** @type {{ method: string, url: string, body: string }[]} */
    const writes = [];
    const forge = testForge(async (url, init) => {
      const target = new URL(String(url));
      const path = decodeURIComponent(target.pathname);
      if (path.endsWith("/git/ref/heads/harmonise/z") && (init?.method ?? "GET") === "GET") {
        refReads++;
        const sha = wrote ? COMMIT : EXPECTED;
        return new Response(JSON.stringify({ object: { sha } }), { status: 200 });
      }
      if (path.endsWith("/git/refs/heads/harmonise/z") && init?.method === "PATCH") wrote = true;
      writes.push({
        method: init?.method ?? "GET",
        url: target.pathname,
        body: String(init?.body ?? ""),
      });
      return new Response("{}", { status: 200 });
    });

    await forge.upsertBranch("harmonise/z", COMMIT, EXPECTED);

    assert.equal(refReads, 3, "read, re-read before the write, verified after it");
    assert.equal(writes.length, 1, "exactly one write for a stable tip");
    const update = writes[0];
    assert.equal(update.method, "PATCH");
    assert.ok(decodeURIComponent(update.url).endsWith("/git/refs/heads/harmonise/z"));
    const sent = JSON.parse(update.body);
    assert.equal(sent.sha, COMMIT);
    assert.equal(sent.force, true);
  });
});
