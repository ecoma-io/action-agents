// Subject moved — the event's view of the thread is a claim, not authority.
//
// Attack: a pull request moves while a triage run is in flight — a push
// replaces the head between the run's snapshot read and the moment it writes.
// A run that trusted the values it started from would stamp decisions built
// from one diff onto a thread whose content has changed underneath them, and
// its marker would record a head the findings never belonged to.
//
// Bounded outcome: triage re-reads the thread immediately before any write
// and treats what it read at the start as claims (`triage/src/mutate.mjs`,
// judged through the live reads `core/src/forge.mjs` serves). When the live
// head differs from the one the run read, nothing is written onto the thread
// — no label, no comment — the skip is logged with the reason in the
// annotation, and the run's record is written as `abandoned` carrying that
// reason (issue #279): the record, not the thread, is where the outcome
// lands. The run never re-derives: re-deriving would mean another model call
// on a subject that is no longer the one that was asked about. A run whose
// subject did not move is unaffected: the same fixture with a still head
// writes, and the marker records the head the run verified.
//
// Deterministic and offline: no network, no model, no timers.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createEvidence } from "#core/untrusted.mjs";

import { run } from "../../../triage/src/index.mjs";

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const BOT = "github-actions[bot]";
const NOW = Date.parse("2026-07-01T11:00:00Z");

/** @type {string} */
let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), "subject-moved-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * The whole world of a pull_request triage run, with the one hostile fact
 * wired in: the head the forge answers on the run's first (snapshot) read
 * and on its second (pre-write) read.
 *
 * @param {string[]} heads the head each successive getPullRequest answers
 * @param {string} name the world's own workspace directory under the temp root
 * @returns {{ forge: { writes: { op: string, args: unknown[] }[] }, logs: string[], workspace: string, recordPath: string, drive: () => Promise<void> }}
 */
function world(heads, name) {
  const workspace = join(root, name);
  mkdirSync(workspace, { recursive: true });
  const comments = [];
  /** @type {{ op: string, args: unknown[] }[]} */
  const writes = [];
  const logs = [];
  let reads = 0;

  const forge = {
    writes,
    async getRepository() {
      return { defaultBranch: "main", name: "action-agents", description: "" };
    },
    async getPullRequest(_number) {
      const head = heads[Math.min(reads, heads.length - 1)];
      reads += 1;
      return {
        number: 7,
        state: "open",
        draft: false,
        merged: false,
        labels: [],
        title: "Fix the import",
        body: "What changed.",
        head: { ref: "topic", sha: head },
        base: { ref: "main", sha: "0".repeat(40) },
      };
    },
    async listPullRequestFiles(_number) {
      return [];
    },
    async getContents(_path) {
      return null; // no config file -> the comment half
    },
    async getRef(_branch) {
      return { sha: "0".repeat(40) };
    },
    async readRef() {
      return { sha: "0".repeat(40) };
    },
    async listTree() {
      return [];
    },
    async listCheckRuns(_ref) {
      return { total: 0, byConclusion: {} };
    },
    async listPullRequestReviews(_number) {
      return { requestedReviewers: [], reviewers: [], reviews: [] };
    },
    async listComments() {
      return comments.map((comment) => ({ ...comment }));
    },
    async createComment(_number, body) {
      writes.push({ op: "createComment", args: [7, body] });
      const id = comments.length + 1;
      comments.push({
        id,
        body,
        user: { login: BOT },
        created_at: "2026-07-01T11:00:00Z",
        updated_at: "2026-07-01T11:00:00Z",
      });
      return { id };
    },
    async updateComment(id, body) {
      writes.push({ op: "updateComment", args: [id, body] });
    },
    async deleteComment(id) {
      writes.push({ op: "deleteComment", args: [id] });
    },
    async addLabels(_number, names) {
      writes.push({ op: "addLabels", args: [7, names] });
    },
    async removeLabel(_number, name) {
      writes.push({ op: "removeLabel", args: [7, name] });
    },
    async whoami() {
      return { login: BOT };
    },
  };

  const io = {
    forge,
    chat: {
      async complete() {
        return {
          content: '{"classification":"bug report","rationale":"Fails on import."}',
          toolCalls: [],
        };
      },
    },
    evidence: createEvidence(() => "aaaabbbb"),
    now: () => NOW,
    readEvent: async () => ({
      pull_request: {
        number: 7,
        title: "Fix the import",
        body: "What changed.",
        labels: [],
        base: { ref: "main" },
      },
      repository: { name: "action-agents", description: "AI GitHub Actions" },
    }),
  };

  const context = {
    eventName: "pull_request",
    repo: "action-agents",
    owner: "ecoma-io",
    apiUrl: "",
    eventPath: "",
    workspace,
  };

  return {
    forge,
    logs,
    workspace,
    recordPath: ".triage-record",
    drive: async () => {
      const original = console.log;
      console.log = (line) => logs.push(String(line));
      try {
        await run(
          {
            model: "fake",
            labels: [],
            dryRun: false,
            configPath: "",
            recordPath: ".triage-record",
          },
          context,
          io,
        );
      } finally {
        console.log = original;
      }
    },
  };
}

describe("a subject that moves between the read and the write", () => {
  it("a head that moved in flight receives nothing — no label, no comment", async () => {
    const moved = world([H1, H2], "moved");

    await moved.drive();

    assert.deepEqual(
      moved.forge.writes,
      [],
      "the run wrote nothing onto a thread that moved underneath it",
    );
    const annotation = moved.logs.join("\n");
    assert.match(
      annotation,
      /nothing written — the thread changed while this run was in flight: the head is now bbbbbbbbbbbb, not the aaaaaaaaaaaa this run read/,
      "the skip names the move",
    );
    assert.ok(annotation.includes("::warning"), "the skip reaches the run log as a warning");

    // The record is where the outcome lands now (issue #279): a write the
    // freshness gate withheld is an `abandoned` record, the divergence
    // reason riding as its `reason`.
    const record = JSON.parse(
      readFileSync(join(moved.workspace, moved.recordPath, "triage-record-pr-7.json"), "utf8"),
    );
    assert.equal(record.outcome, "abandoned", "the withheld run's record ends abandoned");
    assert.match(
      record.reason,
      /the head is now bbbbbbbbbbbb/,
      "the record carries the move as the reason",
    );
    assert.ok(record.decision !== null, "the superseded decision stays in the record");
  });

  it("a still head writes — and the marker records the head the run verified", async () => {
    const still = world([H1, H1], "still");

    await still.drive();

    const comment = still.forge.writes.find(({ op }) => op === "createComment");
    assert.ok(comment, "an unchanged subject receives the run's one comment");
    assert.match(
      /** @type {{ args: [number, string] }} */ (comment).args[1],
      new RegExp(`head=${H1}`),
      "the marker records the head the pre-write read agreed on",
    );
    assert.ok(
      !still.forge.writes.some(({ op }) => op === "addLabels" || op === "removeLabel"),
      "no sheet, no label writes",
    );
  });
});
