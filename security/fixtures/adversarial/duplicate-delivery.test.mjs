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
// Bounded outcome, in two layers. The live re-read before any write
// (`triage/src/mutate.mjs`) compares the payload's claims against the
// thread's state right now — so a literal stale redelivery is a complete
// second run that writes nothing onto the thread and finishes green with a
// warning, its record ending `abandoned` with the reason carried (issue
// #279): the thread moved on while the event sat in the queue. Convergence and repair
// arrive with a fresh payload — a real later event whose claims match live
// state: label sets converge because removals tolerate an absent label (the
// forge reads GitHub's 404 as already-absent, `core/src/forge.mjs`) and
// additions are idempotent; and a fresh delivery that follows a partial
// mutation (a run that died part-way — cancellation is its no-throw
// producer, `triage/src/mutate.mjs`) repairs the half-state. Consumer
// guidance: set a `concurrency` group (see `docs/guides/triage.md`) — the
// belt over these suspenders.
//
// Deterministic and offline: a stateful recording forge, a scripted model
// answer.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createEvidence } from "#core/untrusted.mjs";

import { run } from "../../../triage/src/index.mjs";

const NOW = "2026-07-01T11:00:00Z";
const BOT = "action-agents[bot]";

/** One temp root per world; every run's record write has somewhere to land. */
const roots = [];

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

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
  const root = mkdtempSync(join(tmpdir(), "duplicate-delivery-"));
  roots.push(root);
  const workspace = join(root, "ws");
  mkdirSync(workspace, { recursive: true });
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
    /** The same live state as the pipeline's own pre-write read sees it. */
    async getIssue(_number) {
      return { labels: [...labels].sort() };
    },
    workspace,
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
 * @param {{ name: string }[]} [payloadLabels] the label set the delivered payload claims — stale on a literal redelivery, fresh on a later event
 */
function deliver(worldForge, answer = ANSWER, payloadLabels = [{ name: "needs triage" }]) {
  return run(
    { model: "fake", labels: [], dryRun: false, configPath: "", recordPath: ".triage-record" },
    {
      eventName: "issues",
      repo: "action-agents",
      owner: "ecoma-io",
      apiUrl: "",
      eventPath: "",
      workspace: worldForge.workspace,
    },
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
          labels: payloadLabels,
        },
        repository: { name: "action-agents", description: "" },
      }),
    },
  );
}

describe("triage — the same event redelivered", () => {
  it("a stale redelivery writes nothing; a fresh one converges the thread", async () => {
    const worldForge = forge();
    await deliver(worldForge);
    assert.deepEqual(worldForge.liveLabels(), ["bug"]);
    assert.equal(worldForge.modelCalls.count, 1, "run one paid its own model call");
    const afterRunOne = worldForge.writes.slice();

    // The redelivered payload still claims `needs triage`, but the thread
    // moved on while the event sat in the queue — the live re-read trips the
    // freshness guard. Run two is still a complete run: its own model call,
    // its own reads, its own decision — and not one write.
    await deliver(worldForge);
    assert.equal(worldForge.modelCalls.count, 2, "run two still paid its own model call");
    assert.deepEqual(worldForge.writes, afterRunOne, "the stale redelivery wrote nothing");

    // The record is where that outcome lands (issue #279): a stale
    // redelivery is a write the freshness gate withheld — the record ends
    // `abandoned`, the reason naming the move. Run three rewrites the file;
    // read it now.
    const record = JSON.parse(
      readFileSync(
        join(worldForge.workspace, ".triage-record", "triage-record-issue-7.json"),
        "utf8",
      ),
    );
    assert.equal(record.outcome, "abandoned", "the withheld run's record ends abandoned");
    assert.ok(
      record.reason.includes("the labels are now [bug], not the [needs triage] the event carried"),
      "the record carries the divergence reason",
    );

    // Convergence comes from a delivery whose payload matches live state —
    // a real later event, not the stale replay. Its payload already agrees
    // with the model's judgement, so the re-derived plan is empty: not one
    // further write, and the thread sits where the decisions describe it.
    await deliver(worldForge, ANSWER, [{ name: "bug" }]);
    assert.equal(worldForge.modelCalls.count, 3);
    assert.deepEqual(worldForge.liveLabels(), ["bug"]);
    assert.deepEqual(worldForge.writes, afterRunOne);
  });

  it("a fresh delivery after a partial mutation repairs the half-state", async () => {
    // Run one dies part-way: the marker removal lands, the addition fails —
    // the typed accounting error leaves the run red.
    const worldForge = forge({ failFirstAdd: true });
    await assert.rejects(deliver(worldForge), /the triage mutation stopped part-way/);
    // The half-state a maintainer (or a cancellation) inherits: the queue
    // marker is gone, the category was never applied.
    assert.deepEqual(worldForge.liveLabels(), []);
    const afterRunOne = worldForge.writes.slice();

    // The literal redelivery still claims `needs triage`; the live re-read
    // sees the half-state instead — the guard trips and writes nothing.
    await deliver(worldForge);
    assert.equal(worldForge.modelCalls.count, 2);
    assert.deepEqual(worldForge.writes, afterRunOne, "the stale redelivery wrote nothing");

    // A fresh delivery — a payload whose claims match the half-state —
    // re-derives the remainder and repairs it: the addition lands, and the
    // thread converges.
    await deliver(worldForge, ANSWER, []);
    assert.equal(worldForge.modelCalls.count, 3);
    assert.deepEqual(worldForge.liveLabels(), ["bug"]);
    assert.deepEqual(worldForge.writes, [
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
