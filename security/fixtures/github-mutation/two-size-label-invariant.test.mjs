// The size-rung doctrine — size is measured, never chosen. One size label
// per thread, and an answer that names a rung must not red-run the run.
//
// The corpus pins the doctrine at the surface a hostile model answer can
// reach. What the code already guarantees: `effectiveSheet` deletes the
// ladder's rungs from the sheet it offers the model (`triage/src/config.mjs`
// — the rungs are reserved for measurement), `matchLabels` accepts only
// sheet bytes, and `sizeAdd`/`replace` in `triage/src/index.mjs:246-251`
// apply the measured rung as the sole size mutation. So the applied set
// carries at most one rung, from measurement, never from the answer.
//
// This fixture previously pinned the hole on the answer side of that same
// doctrine as EXPECTED RED: the model is offered no rungs, so when it
// answers the measured rung itself (the cheapest honest answer to a "how big
// is this" prompt), the run used to reject the whole classification as
// "entirely off-sheet" and apply NOTHING — not even the rung measurement
// would apply anyway. Hardening in `triage/src/index.mjs` now reconciles a
// rung-named answer on a PR as a measured-rung confirmation: it is never
// applied raw, never a red-run, and the measured rung proceeds alone. This
// fixture is the green pin for that fix.
//
// Sibling tests pin what holds today: a mixed answer carrying a rung plus a
// real category lands exactly the measured rung (one size label), an old
// rung on the thread is replaced not added to, and byte-exact off-sheet
// twins apply no label at all. Deterministic and offline: the model seam is
// a scripted answer, the forge a recording fake.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEvidence } from "#core/untrusted.mjs";
import { PastFileCeilingError } from "#core/forge.mjs";
import { readContext } from "#core/runtime.mjs";

import { readInputs, run } from "../../../triage/src/index.mjs";

/**
 * A complete runner environment, from which each test removes what it is
 * about — the same fixture the triage unit suite drives.
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

/** A diff that measures `size/s`: 25 counted lines, under the 50-line rung. */
const FILES = [
  { filename: "src/a.mjs", status: "modified", additions: 20, deletions: 5 },
  { filename: "pnpm-lock.yaml", status: "modified", additions: 500, deletions: 0 },
];

/** The rungs of the ladder above — the labels that must be singleton. */
const SIZE_RUNGS = new Set(["size/xs", "size/s", "size/xl"]);

/** @param {{ number?: number, labels?: string[], body?: string }} [thread] */
function prEvent(thread = {}) {
  return {
    pull_request: {
      number: thread.number ?? 8,
      title: "Fix the import",
      body: thread.body ?? "What changed.",
      labels: (thread.labels ?? []).map((name) => ({ name })),
      base: { ref: "main" },
    },
    repository: { name: "action-agents", description: "AI GitHub Actions" },
  };
}

/**
 * A recording forge: label writes append to `writes` — the security-relevant
 * view, what actually reached the mutation surface. Here and in the sibling
 * fixtures, a write the action did not mean is the failure this corpus hunts.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.files] policy files, default branch
 * @param {import("#core/forge.mjs").PullRequestFile[]} [options.prFiles]
 * @param {string[]} [options.threadLabels] what the live label read answers with
 *   — the event's own claim, so an honest run diverges from nothing
 */
function fakeForge(options = {}) {
  const files = options.files ?? { ".github/action-agents/triage/triage.json5": CONFIG };
  /** @type {{ op: string, args: unknown[] }[]} */
  const writes = [];
  return {
    writes,
    // Present for the Forge type's completeness; triage never calls these.
    async getRepository() {
      return { defaultBranch: "main", name: "action-agents", description: "" };
    },
    async getPullRequest() {
      return {
        number: 8,
        state: "open",
        draft: false,
        merged: false,
        labels: options.threadLabels ?? [],
        title: "",
        body: "",
        head: { ref: "x", sha: "0".repeat(40) },
        base: { ref: "main", sha: "0".repeat(40) },
      };
    },
    /** The live label read a mutation is judged against. */
    async getIssue(_number) {
      return { labels: options.threadLabels ?? [] };
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
      const content = files[path];
      return content === undefined ? null : { content };
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
    /** @param {number} number @param {string[]} names */
    async addLabels(number, names) {
      writes.push({ op: "addLabels", args: [number, names] });
    },
    /** @param {number} number @param {string} name */
    async removeLabel(number, name) {
      writes.push({ op: "removeLabel", args: [number, name] });
    },
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
 * The whole world `run` touches: the recording forge plus the model seam's
 * scripted answer. `chatCalls` counts every model invocation — the ordering
 * pin for "refused before the model is asked".
 *
 * @param {Parameters<typeof fakeForge>[0] & { event?: Record<string, unknown>, answer?: string }} [options]
 */
function io(options = {}) {
  const event = options.event ?? prEvent();
  const raw = /** @type {{ labels?: { name: string }[] }} */ (
    event["pull_request"] ?? event["issue"]
  );
  const claimed = (raw?.["labels"] ?? []).map(({ name }) => name);
  const forge = fakeForge({ ...options, threadLabels: claimed });
  /** @type {{ calls: number }} */
  const chat = { calls: 0 };
  return {
    forge,
    chatCalls: () => chat.calls,
    chat: {
      async complete() {
        chat.calls++;
        return { content: options.answer ?? '{"labels":["bug"],"rationale":"r"}', toolCalls: [] };
      },
    },
    evidence: createEvidence(() => "aaaabbbb"),
    now: () => Date.parse("2026-07-01T11:00:00Z"),
    readEvent: async () => event,
  };
}

/** @param {Partial<ReturnType<typeof readInputs>>} [overrides] */
function inputs(overrides = {}) {
  return { ...readInputs(runner), dryRun: false, ...overrides };
}

/** The context of a pull_request run, from the same fixture. */
const prContext = { ...readContext(runner), eventName: "pull_request" };

/**
 * The net set of labels a run applied: everything `addLabels` named that no
 * `removeLabel` took back. On GitHub a label add is set semantics, so a
 * name appearing twice in one call is still one label; the security property
 * is about the set, not the call count.
 *
 * @param {{ op: string, args: unknown[] }[]} writes what the forge recorded
 * @returns {string[]}
 */
function appliedLabels(writes) {
  const added = new Set();
  const removed = new Set();
  for (const { op, args } of writes) {
    if (op === "addLabels") for (const name of /** @type {string[]} */ (args[1])) added.add(name);
    if (op === "removeLabel") removed.add(/** @type {string} */ (args[1]));
  }
  return [...added].filter((name) => !removed.has(name));
}

/** @param {{ op: string, args: unknown[] }[]} writes */
function appliedSizeLabels(writes) {
  return appliedLabels(writes).filter((name) => SIZE_RUNGS.has(name));
}

describe("triage — exactly one size label, and size rungs never red-run the run", () => {
  it("an answer naming the measured rung itself proceeds with exactly that rung, not a red run", async () => {
    const world = io({
      event: prEvent(),
      prFiles: FILES,
      answer: '{"labels":["size/s"],"rationale":"it matches the diff"}',
    });

    // A rung-only answer is reconciled before the off-sheet check: the rung
    // the model named is the rung the measurement applies anyway, so the run
    // proceeds and lands exactly that rung. This pin is green since the
    // hardening in triage/src/index.mjs.
    await run(inputs(), prContext, world);

    assert.deepEqual(
      appliedSizeLabels(world.forge.writes),
      ["size/s"],
      "an answer naming the measured rung must land exactly that rung — the " +
        "run reconciles a ladder name as a measured-rung confirmation instead " +
        "of treating a rung-only answer as entirely off-sheet",
    );
  });

  it("a mixed answer carrying a rung plus a category lands exactly one size label — the measured one", async () => {
    const world = io({
      event: prEvent(),
      prFiles: FILES,
      answer: '{"labels":["bug","size/xl"],"rationale":"a rung the sheet never offered"}',
    });

    await run(inputs(), prContext, world);

    assert.deepEqual(
      appliedSizeLabels(world.forge.writes),
      ["size/s"],
      "the measured rung is the only size mutation — the model-named rung is refused, " +
        "never coerced, never applied",
    );
  });

  it("an old rung on the thread is replaced by the measured one — never added to", async () => {
    const world = io({
      event: prEvent({ labels: ["size/xl"] }),
      prFiles: FILES,
      answer: '{"labels":["breaking"],"rationale":"breaking change"}',
    });

    await run(inputs(), prContext, world);

    assert.deepEqual(appliedSizeLabels(world.forge.writes), ["size/s"]);
  });

  for (const twin of ["BUG", "bug ", "⭐", "feat:x"]) {
    it(`a byte-exact off-sheet twin ${JSON.stringify(twin)} applies no label at all`, async () => {
      const world = io({
        event: prEvent(),
        prFiles: FILES,
        answer: JSON.stringify({ labels: [twin], rationale: "r" }),
      });

      await assert.rejects(run(inputs(), prContext, world), /entirely off-sheet/);

      assert.equal(
        world.forge.writes.filter(({ op }) => op === "addLabels" || op === "removeLabel").length,
        0,
        "an entirely off-sheet answer is refused before any label write",
      );
    });
  }
});
