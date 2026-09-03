// Own-logins resolution failure — the identity half of the marker upsert,
// attacked by GitHub itself: the API does not answer the identity read.
//
// Attack (a reliability attack, not a prompt one): the run holds a token
// whose writing identity cannot be read — the `whoami` call fails. Under a
// GITHUB_TOKEN the old behaviour guessed `github-actions[bot]` and got away
// with it; under any other identity (a GitHub App's bot login, a PAT) the
// guessed set reads the action's own prior comment as somebody else's, so
// the upsert creates a duplicate comment instead of updating in place — the
// exact symptom the identity resolution exists to prevent.
//
// Bounded outcome: the failure is a typed red run (`OwnLoginsError`) raised
// before any write. Nothing reaches the forge: no comment created, updated,
// or deleted, no duplicate on the thread. A run that cannot establish which
// comments are its own does not write at all.
//
// The unit suite covers `resolveOwnLogins` in isolation; this fixture drives
// the full `run()` on the no-sheet path, where the classification comment is
// the whole write surface. Deterministic and offline: a failing `whoami` on
// a recording fake forge, a scripted model answer.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEvidence } from "#core/untrusted.mjs";

import { run } from "../../../triage/src/index.mjs";

const BOT = "action-agents[bot]";
const NOW = "2026-07-01T11:00:00Z";

/**
 * @param {Partial<import("#core/forge.mjs").CommentEntry>} [overrides]
 * @returns {import("#core/forge.mjs").CommentEntry}
 */
function comment(overrides = {}) {
  return {
    id: 1,
    body: "",
    user: { login: BOT },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/**
 * An in-memory comment store that records every write, so the fixture can
 * assert that the refusal left the thread untouched.
 *
 * @param {import("#core/forge.mjs").CommentEntry[]} initial
 */
function store(initial = []) {
  const comments = [...initial];
  let nextId = Math.max(0, ...comments.map((c) => c.id)) + 1;
  /** @type {{ op: string, id?: number, body?: string }[]} */
  const writes = [];
  const api = {
    comments,
    writes,
    async listComments() {
      return [...comments];
    },
    async createComment(_number, body) {
      const entry = comment({ id: nextId, body });
      nextId++;
      comments.push(entry);
      writes.push({ op: "create", id: entry.id, body });
      return { id: entry.id };
    },
    async updateComment(id, body) {
      const entry = comments.find((c) => c.id === id);
      assert.ok(entry, `update of unknown comment ${String(id)}`);
      entry.body = body;
      writes.push({ op: "update", id, body });
    },
    async deleteComment(id) {
      const at = comments.findIndex((c) => c.id === id);
      assert.ok(at !== -1, `delete of unknown comment ${String(id)}`);
      writes.push({ op: "delete", id });
      comments.splice(at, 1);
    },
  };
  return api;
}

/**
 * The no-sheet triage forge, with an identity read that fails — the attack:
 * the one read whose failure a guessed fallback used to paper over.
 *
 * @param {import("#core/forge.mjs").CommentEntry[]} [comments]
 */
function forge(comments = []) {
  const s = store(comments);
  return {
    ...s,
    async getRepository() {
      return { defaultBranch: "main", name: "action-agents", description: "" };
    },
    async getRef(_branch) {
      return { sha: "0".repeat(40) };
    },
    async getContents(_path) {
      return null;
    },
    async whoami() {
      throw new Error("the identity endpoint answered 503");
    },
  };
}

/**
 * Runs the real triage pipeline end to end on the no-sheet path and returns
 * the rejection — the fixture asserts on it and on what the forge recorded.
 *
 * @param {ReturnType<typeof forge>} worldForge
 * @param {string} answer the model's raw answer
 * @returns {Promise<{ rejection: unknown, forge: ReturnType<typeof forge> }>}
 */
async function triageRun(worldForge, answer) {
  const io = {
    forge: worldForge,
    chat: { complete: async () => ({ content: answer }) },
    evidence: createEvidence(() => "aaaabbbb"),
    now: () => Date.parse(NOW),
    readEvent: async () => ({
      issue: { number: 7, title: "Import fails", body: "Steps.", labels: [] },
      repository: { name: "action-agents", description: "" },
    }),
  };
  const context = {
    eventName: "issues",
    repo: "action-agents",
    owner: "ecoma-io",
    apiUrl: "",
    eventPath: "",
  };
  const rejection = await run(
    { model: "fake", labels: [], dryRun: false, configPath: "" },
    context,
    io,
  ).then(
    () => null,
    (cause) => cause,
  );
  return { rejection, forge: worldForge };
}

describe("triage — a failed identity read refuses, it never guesses", () => {
  it("a whoami failure is a typed red run before any write", async () => {
    // The thread already carries the action's own classification comment —
    // authored by the App-token identity a guess would no longer recognise.
    const world = await triageRun(
      forge([
        comment({
          id: 55,
          body: "<!-- action-agents:triage:0badcafe -->\nPreviously: a bug.",
          user: { login: BOT },
        }),
      ]),
      JSON.stringify({ classification: "a bug", rationale: "Because." }),
    );

    // Typed: the run is red with a name, not a silent fallback.
    assert.ok(world.rejection instanceof Error);
    assert.equal(
      /** @type {Error} */ (world.rejection).name,
      "OwnLoginsError",
      "the run did not refuse as OwnLoginsError",
    );
    assert.match(/** @type {Error} */ (world.rejection).message, /refusing to guess/);

    // The bounded outcome: the write surface is untouched. No duplicate
    // created, no claim of the existing comment, nothing deleted.
    assert.deepEqual(
      world.forge.writes,
      [],
      "a run that cannot establish its identity wrote anyway",
    );
  });

  it("a dry run never pays for the identity read, so a failed one still refuses nothing", async () => {
    // A dry run writes nothing and therefore needs no identity: it renders
    // the preview and stops before resolveOwnLogins. The failed `whoami` is
    // simply never called.
    const worldForge = forge();
    const io = {
      forge: worldForge,
      chat: {
        complete: async () => ({
          content: JSON.stringify({ classification: "a bug", rationale: "r" }),
        }),
      },
      evidence: createEvidence(() => "aaaabbbb"),
      now: () => Date.parse(NOW),
      readEvent: async () => ({
        issue: { number: 7, title: "Import fails", body: "Steps.", labels: [] },
        repository: { name: "action-agents", description: "" },
      }),
    };
    await run(
      { model: "fake", labels: [], dryRun: true, configPath: "" },
      { eventName: "issues", repo: "action-agents", owner: "ecoma-io", apiUrl: "", eventPath: "" },
      io,
    );
    assert.deepEqual(worldForge.writes, []);
  });
});
