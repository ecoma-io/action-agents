// Duplicate delivery — GitHub redelivers webhook events (at-least-once).
//
// Attack (a reliability attack, not a prompt one): the same `issues.opened`
// payload arrives twice. Nothing in the pipeline keys an event to a run —
// there is no dedupe, by design (a second run doubles provider calls, a cost
// consequence, not a cause of wrongness) — so the second delivery is a
// complete second run. The accepted semantics, pinned here end to end: the
// second run re-derives its plan from live state — its own model call, its
// own policy decision — and never replays a previous run's plan. There is no
// plan store anywhere in the pipeline; the only state a run reads is the
// redelivered payload and the thread's live state.
//
// Bounded outcome: the second run completes green and the thread converges
// to the state the identical decisions describe — label sets converge
// because removals tolerate an absent label (the forge reads GitHub's 404 as
// already-absent, `core/src/forge.mjs`) and additions are idempotent; and a
// redelivery that follows a partial mutation (a run that died part-way —
// cancellation is its no-throw producer, `triage/src/mutate.mjs`) repairs
// the half-state. Consumer guidance: set a `concurrency` group (see
// `docs/guides/triage.md`) — the belt over these suspenders.
//
// Deterministic and offline: a stateful recording forge, a scripted model
// answer.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEvidence } from "#core/untrusted.mjs";

import { run } from "../../../triage/src/index.mjs";

const NOW = "2026-07-01T11:00:00Z";
const BOT = "action-agents[bot]";

/** A sheet with a queue marker, so one plan carries both a removal and an addition. */
const CONFIG = JSON.stringify({
  labels: {
    use: ["bug", "docs", "needs triage"],
    roles: {
      bug: "semantic-classification",
      docs: "semantic-classification",
      "needs triage": "workflow-marker",
    },
    workflowMarkers: ["needs triage"],
  },
});

const REPO_LABELS = ["bug", "docs", "needs triage"];

/** The model's answer is identical on every delivery — redelivery, not a new judgement. */
const ANSWER = JSON.stringify({ labels: ["bug"], rationale: "redelivery fixture" });

/**
 * A forge whose label state is live: writes mutate the set, and a removal of
 * an absent label succeeds silently — the forge reads GitHub's 404 as
 * already-absent (`core/src/forge.mjs`), so a re-derived removal is a no-op,
 * never a red run.
 *
 * @param {{ failFirstAdd?: boolean }} [options]
 */
function forge(options = {}) {
  const labels = new Set(["needs triage"]);
  /** @type {{ op: store, args: unknown[] }[]} */
  const writes = [];
  /** @type {{ count: number }} */
  const modelCalls = { count: 0 };
  /** @type {import("#core/forge.mjs").CommentEntry[]} */
  const comments = [];
  let nextId = 1;
  let failFirstAdd = options.failFirstAdd ?? false;
  const world = {
    writes,
    modelCalls,
    async getRepository() {
      return { defaultBranch: "main", name: "action-agents", description: "" };
    },
    async getRef(_branch) {
      return { sha: "0".repeat(40) };
    },
    async listTree(_sha) {
      return [];
    },

    /** @param {string} path */
    async getContents(path) {
      return path.endsWith("triage.json5") ? { content: CONFIG } : null;
    },
    async listRepositoryLabelsDetailed() {
      return REPO_LABELS.map((name) => ({ name, description: "", color: "" }));
    },
    async searchIssues() {
      return { items: [], totalCount: 0, cappedAt: false };
    },
    /** @param {number} _number @param {string[]} names */
    async addLabels(_number, names) {
      if (failFirstAdd) {
        failFirstAdd = false;
        throw new Error("the labels endpoint answered 503");
      }
      for (const name of names) labels.add(name);
      writes.push({ op: "addLabels", args: [names] });
    },
    /** @param {number} _number @param {string} name */
    async removeLabel(_number, name) {
      labels.delete(name);
      writes.push({ op: "removeLabel", args: [name] });
    },
    async listComments() {
      return comments.map((entry) => ({ ...entry }));
    },
    /** @param {number} _number @param {string} body */
    async createComment(_number, body) {
      const id = nextId++;
      comments.push({ id, body, user: { login: BOT }, created_at: NOW, updated_at: NOW });
      writes.push({ op: "createComment", args: [body.slice(0, 40)] });
      return { id };
    },
    /** @param {number} id @param {string} body */
    async updateComment(id, body) {
      const stored = comments.find((entry) => entry.id === id);
      assert.ok(stored, `update of unknown comment ${String(id)}`);
      stored.body = body;
      writes.push({ op: "updateComment", args: [id, body.slice(0, 40)] });
    },
    /** @param {number} id */
    async deleteComment(id) {
      const at = comments.findIndex((entry) => entry.id === id);
      assert.ok(at !== -1, `delete of unknown comment ${String(id)}`);
      comments.splice(at, 1);
      writes.push({ op: "deleteComment", args: [id] });
    },
    async whoami() {
      return { login: "action-agents[bot]" };
    },
    /** The thread's live label state, as a maintainer would read it. */
    liveLabels() {
      return [...labels].sort();
    },
  };
  return world;
}

/**
 * One delivery of the event: the same payload every time — that is the
 * point. Runs the real `run()` end to end; the forge counts the model call
 * every delivery pays.
 *
 * @param {ReturnType<typeof forge>} worldForge
 * @param {string} [answer] the scripted model answer; identical across deliveries unless a test overrides it
 */
function deliver(worldForge, answer = ANSWER) {
  return run(
    { model: "fake", labels: [], dryRun: false, configPath: "" },
    { eventName: "issues", repo: "action-agents", owner: "ecoma-io", apiUrl: "", eventPath: "" },
    {
      forge: worldForge,
      chat: {
        // The scripted answer is identical on every delivery.
        complete: async () => {
          worldForge.modelCalls.count += 1;
          return { content: answer };
        },
      },
      evidence: createEvidence(() => "aaaabbbb"),
      now: () => Date.parse(NOW),
      readEvent: async () => ({
        action: "opened",
        issue: {
          number: 7,
          title: "Import fails",
          body: "Op body.",
          labels: [{ name: "needs triage" }],
        },
        repository: { name: "action-agents", description: "" },
      }),
    },
  );
}

describe("triage — the same event redelivered", () => {
  it("the second run re-derives from live state and the thread converges", async () => {
    const worldForge = forge();
    await deliver(worldForge);
    assert.deepEqual(worldForge.liveLabels(), ["bug"]);
    assert.equal(worldForge.modelCalls.count, 1, "run one paid its own model call");

    // The redelivered payload still claims `needs triage`; run two re-derives
    // from that claim plus its own reads — its own model call, its own
    // policy decision.
    await deliver(worldForge);
    assert.equal(worldForge.modelCalls.count, 2, "run two paid its own model call");

    // Converged: the thread ends in the state the identical decisions
    // describe, and every write across both deliveries stayed within the
    // sheet's reversible surface.
    assert.deepEqual(worldForge.liveLabels(), ["bug"]);
    assert.deepEqual(worldForge.writes, [
      { op: "removeLabel", args: ["needs triage"] },
      { op: "addLabels", args: [["bug"]] },
      { op: "removeLabel", args: ["needs triage"] },
      { op: "addLabels", args: [["bug"]] },
    ]);
  });

  it("a redelivery that follows a partial mutation repairs the half-state", async () => {
    // Run one dies part-way: the marker removal lands, the addition fails —
    // the typed accounting error leaves the run red.
    const worldForge = forge({ failFirstAdd: true });
    await assert.rejects(deliver(worldForge), /the triage mutation stopped part-way/);
    // The half-state a maintainer (or a cancellation) inherits: the queue
    // marker is gone, the category was never applied.
    assert.deepEqual(worldForge.liveLabels(), []);
    // The redelivery re-derives from the half-state — the tolerant removal
    // no-ops (the label is already absent), the addition lands, and the
    // thread converges. Run two wrote nothing run one's plan would not have.
    await deliver(worldForge);
    assert.deepEqual(worldForge.liveLabels(), ["bug"]);
    assert.deepEqual(worldForge.writes, [
      { op: "removeLabel", args: ["needs triage"] },
      { op: "removeLabel", args: ["needs triage"] },
      { op: "addLabels", args: [["bug"]] },
    ]);
  });
});

describe("triage — a redelivered no-sheet classification", () => {
  it("updates its one comment in place instead of duplicating it", async () => {
    // No config file: the classification is the marker comment. The
    // redelivery finds the run's own prior comment — same marker namespace,
    // same identity — and updates it; a second comment on the thread would
    // be the duplication the upsert exists to prevent.
    const worldForge = forge();
    worldForge.getContents = async () => null;
    await deliver(worldForge, JSON.stringify({ classification: "a bug", rationale: "r" }));
    assert.deepEqual(
      worldForge.writes.map((write) => write.op),
      ["createComment"],
    );
    const created = worldForge.writes[0];
    assert.ok(created?.op === "createComment");
    assert.ok(String(created.args[0]).includes("<!-- action-agents:triage:"));

    await deliver(worldForge, JSON.stringify({ classification: "a bug", rationale: "r" }));

    assert.deepEqual(
      worldForge.writes.map((write) => write.op),
      ["createComment", "updateComment"],
    );
    assert.equal((await worldForge.listComments()).length, 1, "a second comment appeared");
  });
});
