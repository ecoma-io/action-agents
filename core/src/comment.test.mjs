// Tests for the marker upsert.
//
// One comment per action per thread — everything here pins some face of that
// invariant: found by exact marker AND known bot identity (never by marker
// alone), exactly one kept (own losers deleted with a log line), the marker's
// id preserved across updates so the upsert stays an upsert, and a comment a
// concurrent run already moved past is abandoned rather than overwritten.
// The identity rule gets its own adversarial cases: a quoted marker in a
// human's comment is never claimed and never deleted.

import { describe, expect, it } from "vitest";

import {
  OwnLoginsError,
  markerLine,
  parseMarker,
  resolveOwnLogins,
  upsertComment,
} from "./comment.mjs";
import { ForgeError } from "./forge.mjs";

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
 */
function store(initial) {
  const comments = [...initial];
  let nextId = Math.max(0, ...initial.map((c) => c.id)) + 1;
  /** @type {string[]} */
  const log = [];
  /** @type {import("./comment.mjs").CommentStore & { log: string[] }} */
  const api = {
    log,
    async listComments() {
      return [...comments];
    },
    async createComment(_number, body) {
      const entry = comment({
        id: nextId,
        body,
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

/**
 * The options every call shares: this action writes under LOGIN, said
 * explicitly, because that statement is what the identity guard judges.
 *
 * @param {ReturnType<typeof store>} api
 * @param {{ head?: string, startedAt?: number }} [extra]
 * @returns {import("./comment.mjs").UpsertOptions}
 */
function baseOptions(api, extra = {}) {
  return {
    store: api,
    action: "triage",
    issueNumber: 7,
    buildBody: (marker) => marker,
    ownLogins: [LOGIN],
    ...extra,
  };
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
      ...baseOptions(api),
      buildBody: (marker) => `# Triage\n${marker}\nsummary`,
      newId: () => "0badcafe",
    });

    expect(outcome.outcome).toBe("created");
    expect(outcome.id).toBe(1);
    expect(api.log).toHaveLength(0);
  });
});

describe("the default id generator", () => {
  it("mints a distinct, marker-compatible id on every create when newId is not injected", async () => {
    // No newId option anywhere in this loop: every id comes from the
    // production default (crypto.randomBytes), the path the injected
    // generators in the tests above exist to bypass.
    /** @type {string[]} */
    const ids = [];
    for (let at = 0; at < 1000; at++) {
      const api = store([]);
      const outcome = await upsertComment({ ...baseOptions(api) });
      expect(outcome.outcome).toBe("created");
      const [entry] = await api.listComments(7);
      const marker = parseMarker(entry?.body ?? "");
      ids.push(marker === null ? "" : marker.id);
    }

    expect(ids).toHaveLength(1000);
    expect(new Set(ids).size).toBe(1000); // every mint distinct
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f-]{6,64}$/); // fits the marker's id slot
    }
  });
});

describe("updating", () => {
  it("updates the action's own comment, preserving its marker id", async () => {
    const mine = comment({ id: 5, body: `${markerLine("triage", "ee99a1b2")} old text` });
    const api = store([mine]);
    /** @type {string} */
    let seenMarker = "";

    const outcome = await upsertComment({
      ...baseOptions(api),
      buildBody: (marker) => {
        seenMarker = marker;
        return `${marker} new text`;
      },
    });

    expect(outcome).toEqual({ outcome: "updated", id: 5 });
    expect(seenMarker).toContain("ee99a1b2");
  });

  it("keeps exactly one of its own: newest wins, losers deleted with a log line", async () => {
    const older = comment({ id: 3, body: `${markerLine("triage", "a1d00001")} first` });
    const newer = comment({ id: 9, body: `${markerLine("triage", "a1d00002")} second` });
    const api = store([older, newer]);

    const outcome = await upsertComment({ ...baseOptions(api), log: (line) => api.log.push(line) });

    expect(outcome.id).toBe(9);
    expect(api.log.some((line) => line.match(/duplicate/) && line.includes("3"))).toBe(true);
  });

  it("deletes only its own duplicates — a foreign marker stands beside them untouched", async () => {
    const older = comment({ id: 3, body: `${markerLine("triage", "a1d00001")} first` });
    const newer = comment({ id: 9, body: `${markerLine("triage", "a1d00002")} second` });
    const quote = comment({
      id: 11,
      body: `> ${markerLine("triage", "b1b00003")} real`,
      user: { login: "a-human" },
    });
    const api = store([older, newer, quote]);

    const outcome = await upsertComment({ ...baseOptions(api), log: (line) => api.log.push(line) });

    expect(outcome.id).toBe(9);
    expect(api.log.some((line) => line.includes("3") && line.match(/duplicate/))).toBe(true);
    expect(api.log.some((line) => line.includes("untouched"))).toBe(true);
  });
});

describe("the identity guard", () => {
  it("never claims or deletes a human's quote of the action's marker while its own stands", async () => {
    const mine = comment({ id: 2, body: `${markerLine("triage", "b1b00003")} real` });
    const quote = comment({
      id: 8,
      body: `> ${markerLine("triage", "b1b00003")} real`,
      user: { login: "a-human" },
      updated_at: "2026-06-01T00:00:00Z",
    });
    const api = store([mine, quote]);

    const outcome = await upsertComment({
      ...baseOptions(api),
      log: (line) => api.log.push(line),
    });

    expect(outcome).toEqual({ outcome: "updated", id: 2 });
    expect(api.log.some((line) => line.includes("untouched"))).toBe(true);
  });

  it("creates fresh rather than claiming a thread where every marker is foreign", async () => {
    const renamed = comment({
      id: 4,
      body: `${markerLine("triage", "c0c00004")} written under a login we do not claim`,
      user: { login: "action-agents-old[bot]" },
    });
    const api = store([renamed]);

    const outcome = await upsertComment({
      ...baseOptions(api),
      newId: () => "fresh001",
      log: (line) => api.log.push(line),
    });

    expect(outcome.outcome).toBe("created");
    expect(outcome.id).not.toBe(4);
    expect(api.log.some((line) => line.includes("untouched"))).toBe(true);
  });

  it("treats an authorless comment as foreign — markers without authors are claims, not facts", async () => {
    const orphaned = comment({ id: 5, user: null });
    const api = store([orphaned]);

    const outcome = await upsertComment({ ...baseOptions(api), newId: () => "fresh002" });

    expect(outcome.outcome).toBe("created");
    expect(outcome.id).not.toBe(5);
  });

  it("lets a caller claim a non-default bot identity explicitly", async () => {
    const appAuthored = comment({
      id: 6,
      body: `${markerLine("triage", "d1d00006")} ours via a GitHub App`,
      user: { login: "ecoma-io-app[bot]" },
    });
    const api = store([appAuthored]);

    const outcome = await upsertComment({
      ...baseOptions(api),
      ownLogins: ["ecoma-io-app[bot]"],
    });

    expect(outcome).toEqual({ outcome: "updated", id: 6 });
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
      ...baseOptions(api, {
        head: "ffff0000ffff0000f",
        startedAt: Date.parse("2026-07-01T11:00:00Z"),
      }),
      log: (line) => api.log.push(line),
    });

    expect(outcome.outcome).toBe("abandoned");
    expect(api.log.some((line) => line.includes("abandoning"))).toBe(true);
  });
  it("abandons when the newer head cannot be dated — a NaN updated_at must not prove the comment older", async () => {
    const undated = comment({
      id: 6,
      body: `${markerLine("triage", "d0d00006", "aaaabbbbccccdddde")} undated`,
      updated_at: "not-a-timestamp",
    });
    const api = store([undated]);

    const outcome = await upsertComment({
      ...baseOptions(api, {
        head: "ffff0000ffff0000f",
        startedAt: Date.parse("2026-07-01T11:00:00Z"),
      }),
      log: (line) => api.log.push(line),
    });

    // Fail closed: a body that cannot be dated is treated as possibly a
    // concurrent run's, never as provably older — abandoned, not clobbered.
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
      ...baseOptions(api, {
        head: "aaaabbbbccccdddde",
        startedAt: Date.parse("2026-07-01T11:00:00Z"),
      }),
    });

    expect(outcome.outcome).toBe("updated");
  });
});

describe("the publication outcome", () => {
  // The upsert's outcome is the publication fact every caller judges: an
  // abandoned write names the comment that stands as another run's — never
  // an id of its own — and leaves the thread exactly as it found it.
  it("abandons with no id, the standing comment named as foreign, and zero mutations", async () => {
    const raced = comment({
      id: 6,
      body: `${markerLine("triage", "d0d00006", "aaaabbbbccccdddde")} raced`,
      updated_at: "2026-07-01T12:00:00Z",
    });
    const duplicate = comment({
      id: 5,
      body: `${markerLine("triage", "d0d00005")} older duplicate`,
    });
    const api = store([duplicate, raced]);

    const outcome = await upsertComment({
      ...baseOptions(api, {
        head: "ffff0000ffff0000f",
        startedAt: Date.parse("2026-07-01T11:00:00Z"),
      }),
      log: (line) => api.log.push(line),
    });

    // No `id`: the standing comment belongs to the run that won the thread.
    expect(outcome).toStrictEqual({
      outcome: "abandoned",
      foreignId: 6,
      deletedDuplicates: 0,
    });
    expect("id" in outcome).toBe(false);
    // Zero mutations — the duplicate the upsert would have deleted is still
    // on the thread, and nothing was created or updated.
    const listed = await api.listComments(7);
    expect(listed.map((entry) => entry.id)).toEqual([5, 6]);
  });

  it("abandons on an undatable standing comment without mutating the thread", async () => {
    const undated = comment({
      id: 6,
      body: `${markerLine("triage", "d0d00006", "aaaabbbbccccdddde")} undated`,
      updated_at: "not-a-timestamp",
    });
    const api = store([undated]);

    const outcome = await upsertComment({
      ...baseOptions(api, {
        head: "ffff0000ffff0000f",
        startedAt: Date.parse("2026-07-01T11:00:00Z"),
      }),
    });

    expect(outcome).toStrictEqual({
      outcome: "abandoned",
      foreignId: 6,
      deletedDuplicates: 0,
    });
  });

  it("counts the duplicates it deleted on an update", async () => {
    const older = comment({ id: 5, body: `${markerLine("triage", "d0d00005")} older duplicate` });
    const winner = comment({ id: 6, body: `${markerLine("triage", "d0d00006")} the one` });
    const api = store([older, winner]);

    const outcome = await upsertComment(baseOptions(api));

    expect(outcome).toStrictEqual({
      outcome: "updated",
      id: 6,
      deletedDuplicates: 1,
    });
    const listed = await api.listComments(7);
    expect(listed.map((entry) => entry.id)).toEqual([6]);
  });

  it("counts zero duplicates on a create", async () => {
    const api = store([]);

    const outcome = await upsertComment(baseOptions(api));

    expect(outcome).toStrictEqual({
      outcome: "created",
      id: 1,
      deletedDuplicates: 0,
    });
  });
});

describe("resolveOwnLogins", () => {
  it("resolves the identity the token writes as", async () => {
    const ownLogins = await resolveOwnLogins({ whoami: async () => ({ login: "docs-bot[bot]" }) });
    expect(ownLogins).toEqual(["docs-bot[bot]"]);
  });

  it("refuses as a typed red run when the read fails — never an assumed identity", async () => {
    const refused = resolveOwnLogins({
      whoami: async () => {
        throw new Error("502 behind a proxy");
      },
    });
    await expect(refused).rejects.toThrow(OwnLoginsError);
    await expect(refused).rejects.toThrow(/502 behind a proxy/);
    await expect(refused).rejects.toThrow(/refusing to guess/);
  });

  it("still red-runs when whoami rejects with the forge's own typed refusal — the named operation surfaces", async () => {
    const refused = resolveOwnLogins({
      whoami: () =>
        Promise.reject(
          new ForgeError(
            "reading the token's identity from the GraphQL viewer",
            new Error("the answer carries an error: Bad credentials"),
          ),
        ),
    });
    await expect(refused).rejects.toThrow(OwnLoginsError);
    await expect(refused).rejects.toThrow(/GraphQL viewer/);
    await expect(refused).rejects.toThrow(/refusing to guess/);
  });

  it("hands the resolution straight to the upsert: a prior comment by the resolved identity is claimed", async () => {
    const forge = { whoami: async () => ({ login: "docs-bot[bot]" }) };
    const ownLogins = await resolveOwnLogins(forge);
    const prior = comment({
      id: 9,
      body: `${markerLine("triage", "e2e00009")} ours under an App token`,
      user: { login: "docs-bot[bot]" },
    });
    const api = store([prior]);

    const outcome = await upsertComment({ ...baseOptions(api), ownLogins });

    expect(outcome).toEqual({ outcome: "updated", id: 9 });
  });
});
