// Tests for the marker upsert.
//
// One comment per action per thread — everything here pins some face of that
// invariant: found by author before marker, exactly one kept (losers deleted
// with a log line), the marker's id preserved across updates so the upsert
// stays an upsert, and a comment a concurrent run already moved past is
// abandoned rather than overwritten.

import { describe, expect, it } from "vitest";

import { markerLine, parseMarker, upsertComment } from "./comment.mjs";

/** @typedef {import("./forge.mjs").CommentEntry} CommentEntry */

const LOGIN = "action-agents[bot]";

/**
 * @param {Partial<CommentEntry>} [overrides]
 * @returns {CommentEntry}
 */
function comment(overrides = {}) {
  return {
    id: 1,
    body: "<!-- action-agents:triage:e5710001 --> classification",
    user: { login: LOGIN },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * An in-memory comment store: the same operations the forge client offers,
 * so the upsert is tested against the semantics it will really run on.
 *
 * @param {CommentEntry[]} initial
 * @param {{ login?: string }} [identity]
 */
function store(initial, identity = {}) {
  const comments = [...initial];
  let nextId = Math.max(0, ...initial.map((c) => c.id)) + 1;
  /** @type {string[]} */
  const log = [];
  /** @type {import("./comment.mjs").CommentStore & { log: string[] }} */
  const api = {
    log,
    async whoami() {
      return { login: identity.login ?? LOGIN };
    },
    async listComments() {
      return [...comments];
    },
    async createComment(_number, body) {
      const entry = comment({
        id: nextId,
        body,
        user: { login: identity.login ?? LOGIN },
        created_at: "2026-02-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
      });
      nextId++;
      comments.push(entry);
      return { id: entry.id };
    },
    async updateComment(id, body) {
      const entry = comments.find((c) => c.id === id);
      if (entry === undefined) throw new Error(`no comment ${String(id)}`);
      entry.body = body;
      entry.updated_at = "2026-02-01T00:00:00Z";
    },
    async deleteComment(id) {
      const at = comments.findIndex((c) => c.id === id);
      if (at === -1) throw new Error(`no comment ${String(id)}`);
      comments.splice(at, 1);
    },
  };
  return api;
}

describe("the marker", () => {
  it("round-trips through parseMarker, with and without a head", () => {
    expect(parseMarker(`${markerLine("triage", "abc123")} body`)).toEqual({
      action: "triage",
      id: "abc123",
      head: undefined,
    });
    expect(parseMarker(`${markerLine("review", "abc123", "deadbeef9")} body`)).toEqual({
      action: "review",
      id: "abc123",
      head: "deadbeef9",
    });
  });

  it("ignores a body with no marker, and another action's marker", () => {
    expect(parseMarker("just text")).toBeNull();
    expect(parseMarker("<!-- action-agents:review:abc123 -->")).toEqual(
      expect.objectContaining({ action: "review" }),
    );
  });
});

describe("creating", () => {
  it("creates when the action has no comment on the thread, minting an id", async () => {
    const api = store([]);
    const outcome = await upsertComment({
      store: api,
      action: "triage",
      issueNumber: 7,
      buildBody: (marker) => `# Triage\n${marker}\nsummary`,
      newId: () => "0badcafe",
    });

    expect(outcome.outcome).toBe("created");
    expect(outcome.id).toBe(1);
    expect(api.log).toHaveLength(0);
  });
});

describe("updating", () => {
  it("updates the action's own comment, preserving its marker id", async () => {
    const mine = comment({ id: 5, body: `${markerLine("triage", "ee99a1b2")} old text` });
    const api = store([mine]);
    /** @type {string} */
    let seenMarker = "";

    const outcome = await upsertComment({
      store: api,
      action: "triage",
      issueNumber: 7,
      buildBody: (marker) => {
        seenMarker = marker;
        return `${marker} new text`;
      },
    });

    expect(outcome).toEqual({ outcome: "updated", id: 5 });
    expect(seenMarker).toContain("ee99a1b2");
  });

  it("keeps exactly one: duplicates lose, newest wins, losers deleted with a log line", async () => {
    const older = comment({ id: 3, body: `${markerLine("triage", "a1d00001")} first` });
    const newer = comment({ id: 9, body: `${markerLine("triage", "a1d00002")} second` });
    const api = store([older, newer]);

    const outcome = await upsertComment({
      store: api,
      action: "triage",
      issueNumber: 7,
      buildBody: (marker) => marker,
      log: (line) => api.log.push(line),
    });

    expect(outcome.id).toBe(9);
    expect(api.log.some((line) => line.match(/duplicate/) && line.includes("3"))).toBe(true);
  });

  it("does not claim a human's quote of the action's marker while its own stands", async () => {
    const mine = comment({ id: 2, body: `${markerLine("triage", "b1b00003")} real` });
    const quote = comment({
      id: 8,
      body: `> ${markerLine("triage", "b1b00003")} real`,
      user: { login: "a-human" },
      updated_at: "2026-06-01T00:00:00Z",
    });
    const api = store([mine, quote]);

    const outcome = await upsertComment({
      store: api,
      action: "triage",
      issueNumber: 7,
      buildBody: (marker) => marker,
    });

    expect(outcome.id).toBe(2);
    expect(api.log).toHaveLength(0);
  });

  it("falls back to the marker alone when the author was renamed", async () => {
    const renamed = comment({
      id: 4,
      body: `${markerLine("triage", "c0c00004")} still ours`,
      user: { login: "action-agents-old[bot]" },
    });
    const api = store([renamed]);

    const outcome = await upsertComment({
      store: api,
      action: "triage",
      issueNumber: 7,
      buildBody: (marker) => marker,
    });

    expect(outcome).toEqual({ outcome: "updated", id: 4 });
  });
});

describe("the newer-head rule", () => {
  it("abandons when a concurrent run recorded a different head after this one started", async () => {
    const newer = comment({
      id: 6,
      body: `${markerLine("triage", "d0d00006", "aaaabbbbccccdddde")} raced`,
      updated_at: "2026-07-01T12:00:00Z",
    });
    const api = store([newer]);

    const outcome = await upsertComment({
      store: api,
      action: "triage",
      issueNumber: 7,
      buildBody: (marker) => marker,
      head: "ffff0000ffff0000f",
      startedAt: Date.parse("2026-07-01T11:00:00Z"),
      log: (line) => api.log.push(line),
    });

    expect(outcome.outcome).toBe("abandoned");
    expect(api.log.some((line) => line.includes("abandoning"))).toBe(true);
  });

  it("updates when the recorded head is this run's head, however old the comment", async () => {
    const mine = comment({
      id: 6,
      body: `${markerLine("triage", "d0d00006", "aaaabbbbccccdddde")} same head`,
      updated_at: "2026-07-01T12:00:00Z",
    });
    const api = store([mine]);

    const outcome = await upsertComment({
      store: api,
      action: "triage",
      issueNumber: 7,
      buildBody: (marker) => marker,
      head: "aaaabbbbccccdddde",
      startedAt: Date.parse("2026-07-01T11:00:00Z"),
    });

    expect(outcome.outcome).toBe("updated");
  });
});
