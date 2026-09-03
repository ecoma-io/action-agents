// Comment immutability — a hostile thread's own words, attacked through the
// action's marker.
//
// Attack: a human comment on the thread quotes the action's marker — the
// exact `<!-- action-agents:triage:<id> -->` grammar — hoping the upsert
// mistakes it for the action's own comment and rewrites (or deletes) a
// human's words, or that a later duplicate-cleanup sweeps it.
//   -> capability must remain bounded: the marker upsert
//      (`core/src/comment.mjs`) keys on marker id AND author. A marker
//      carried by a comment under a foreign login is named and left
//      byte-untouched; exactly the action's own comments are ever updated or
//      collapsed, and the action's one comment is only ever added under its
//      own marker — prior human text is never rewritten.
//
// Pinned at both depths this surface has: the upsert itself (real
// upsertComment against a recording store) and one full `run()` where the
// hostile comment sits on the live thread. Deterministic and offline.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { upsertComment } from "#core/comment.mjs";
import { createEvidence } from "#core/untrusted.mjs";
import { readContext } from "#core/runtime.mjs";
import { readInputs, run } from "../../../triage/src/index.mjs";

/**
 * A recording comment store: the upsert's whole world, as literal as it
 * gets. Mutations append to `calls`; the comment list is inspectable.
 *
 * @param {{ id: number, body: string, login: string }[]} seed
 */
function commentStore(seed) {
  let nextId = seed.length === 0 ? 1 : Math.max(...seed.map(({ id }) => id)) + 1;
  const comments = seed.map(({ id, body, login }) => ({
    id,
    body,
    user: { login },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }));
  /** @type {{ op: string, args: unknown[] }[]} */
  const calls = [];
  return {
    calls,
    comments,
    async listComments() {
      return comments.map((comment) => ({ ...comment }));
    },
    /** @param {number} _number @param {string} body */
    async createComment(_number, body) {
      calls.push({ op: "createComment", args: [_number, body] });
      const id = nextId++;
      comments.push({
        id,
        body,
        user: { login: "github-actions[bot]" },
        created_at: "2026-03-01T00:00:00Z",
        updated_at: "2026-03-01T00:00:00Z",
      });
      return { id };
    },
    /** @param {number} id @param {string} body */
    async updateComment(id, body) {
      calls.push({ op: "updateComment", args: [id, body] });
      const comment = comments.find((entry) => entry.id === id);
      if (comment !== undefined) comment.body = body;
    },
    /** @param {number} id */
    async deleteComment(id) {
      calls.push({ op: "deleteComment", args: [id] });
      const at = comments.findIndex((entry) => entry.id === id);
      if (at !== -1) comments.splice(at, 1);
    },
  };
}

/** A thread comment, ready for `commentStore`. */
function threadComment(id, body, login) {
  return { id, body, login };
}

const OWN_LOGINS = ["github-actions[bot]"];
const HOSTILE_BODY =
  "Per the triage marker <!-- action-agents:triage:abcdef123456 --> this must stay human text.";
const OWN_BODY = "<!-- action-agents:triage:bbb000111222 --> status: applied";
const buildBody = (marker) => `triage report\n${marker}\nclass: bug report`;

/**
 * @param {object} options
 * @param {ReturnType<typeof commentStore>} options.store
 */
function upsert(options) {
  const logs = [];
  return upsertComment({
    store: options.store,
    action: "triage",
    issueNumber: 7,
    buildBody,
    ownLogins: OWN_LOGINS,
    newId: () => "face00face00",
    log: (message) => logs.push(message),
  }).then((outcome) => ({ outcome, logs }));
}

describe("upsertComment — the action's marker, scoped to the action's own comments", () => {
  it("a human comment quoting the marker is left byte-untouched; the action adds its own", async () => {
    const store = commentStore([threadComment(1, HOSTILE_BODY, "alice")]);

    const { outcome, logs } = await upsert({ store });

    assert.equal(outcome.outcome, "created");
    assert.equal(store.comments[0].body, HOSTILE_BODY, "the human's words are untouched");
    assert.equal(store.comments.length, 2, "the action added exactly one comment");
    assert.match(store.comments[1].body, /<!-- action-agents:triage:face00face00 -->/);
    assert.deepEqual(store.calls, [{ op: "createComment", args: [7, store.comments[1].body] }]);
    assert.ok(
      logs.some((line) => line.includes("left untouched")),
      "the foreign marker is named",
    );
  });

  it("when the action's own comment exists, only that one is updated — the human quote still untouched", async () => {
    const store = commentStore([
      threadComment(1, HOSTILE_BODY, "alice"),
      threadComment(2, OWN_BODY, "github-actions[bot]"),
    ]);

    const { outcome } = await upsert({ store });

    assert.equal(outcome.outcome, "updated");
    assert.equal(outcome.id, 2, "the update lands on the action's own comment");
    assert.equal(store.comments[0].body, HOSTILE_BODY, "the human's words are untouched");
    assert.deepEqual(store.calls, [
      {
        op: "updateComment",
        args: [2, `triage report\n<!-- action-agents:triage:bbb000111222 -->\nclass: bug report`],
      },
    ]);
  });

  it("duplicate own comments collapse among themselves — a human quote is never the loser", async () => {
    const store = commentStore([
      threadComment(1, HOSTILE_BODY, "alice"),
      threadComment(2, OWN_BODY, "github-actions[bot]"),
      threadComment(
        3,
        "<!-- action-agents:triage:ccc000333444 --> duplicate",
        "github-actions[bot]",
      ),
    ]);

    const { outcome } = await upsert({ store });

    assert.equal(outcome.outcome, "updated");
    assert.equal(outcome.id, 3, "the newest own comment wins");
    assert.equal(store.comments[0].body, HOSTILE_BODY, "the human's words are untouched");
    assert.deepEqual(
      store.calls.map(({ op }) => op),
      ["deleteComment", "updateComment"],
      "only the action's own duplicate is collapsed",
    );
    assert.deepEqual(store.calls[0], { op: "deleteComment", args: [2] });
  });

  it("a human marker for another action is no more claimable than one for this action", async () => {
    const store = commentStore([
      threadComment(1, "<!-- action-agents:review:dddd000555666 --> quoted", "alice"),
    ]);

    const { outcome } = await upsert({ store });

    assert.equal(outcome.outcome, "created");
    assert.equal(store.comments[1]?.id, 2, "the action's own comment was created fresh");
    assert.equal(store.comments[0].body, "<!-- action-agents:review:dddd000555666 --> quoted");
    assert.ok(!store.calls.some(({ op }) => op === "deleteComment"));
  });
});

describe("upsertComment — the newer-head guard decides between concurrent runs", () => {
  const HEAD_A = "a".repeat(40);
  const HEAD_B = "b".repeat(40);
  // Before the upsert-created comment's updated_at (2026-03-01), so the
  // guard's "written after this run started" test engages.
  const STARTED_AT = Date.parse("2026-02-01T00:00:00Z");

  /**
   * The upsert the way a run calls it when it records the subject's head.
   *
   * @param {ReturnType<typeof commentStore>} store
   * @param {string} head
   * @param {number} startedAt
   */
  function upsertWithHead(store, head, startedAt) {
    const logs = [];
    return upsertComment({
      store,
      action: "triage",
      issueNumber: 7,
      buildBody,
      ownLogins: OWN_LOGINS,
      head,
      startedAt,
      newId: () => "face00face00",
      log: (message) => logs.push(message),
    }).then((outcome) => ({ outcome, logs }));
  }

  it("two upserts recording different heads — the second refuses instead of overwriting", async () => {
    const store = commentStore([]);

    const first = await upsertWithHead(store, HEAD_A, STARTED_AT);
    assert.equal(first.outcome.outcome, "created");
    assert.match(store.comments[0].body, /head=a{40}/, "the head is recorded in the marker");
    const writesAfterFirst = store.calls.length;

    // The subject moved to HEAD_B and a concurrent run recorded it first.
    const second = await upsertWithHead(store, HEAD_B, STARTED_AT);
    assert.equal(second.outcome.outcome, "abandoned");
    assert.equal(store.calls.length, writesAfterFirst, "no write happened in the refusing upsert");
    assert.match(
      second.logs.join("\n"),
      /a concurrent run recorded head a{40} after this one started/,
    );
    // The first run's comment stands, byte-identical.
    assert.equal(store.comments.length, 1);
  });

  it("two upserts recording the same head — the second updates, exempt by design", async () => {
    const store = commentStore([]);

    const first = await upsertWithHead(store, HEAD_A, STARTED_AT);
    assert.equal(first.outcome.outcome, "created");

    const second = await upsertWithHead(store, HEAD_A, STARTED_AT);
    assert.equal(second.outcome.outcome, "updated");
    assert.deepEqual(
      store.calls.slice(-1).map(({ op }) => op),
      ["updateComment"],
    );
  });
});

describe("triage run — a hostile marker-quoting comment on the live thread", () => {
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

  /** @param {Partial<ReturnType<typeof readInputs>>} [overrides] */
  function inputs(overrides = {}) {
    return { ...readInputs(runner), dryRun: false, ...overrides };
  }

  /** @param {{ body?: string }} [thread] */
  function issueEvent(thread = {}) {
    return {
      issue: {
        number: 7,
        title: "Import fails on Node 24",
        body: thread.body ?? "Steps to reproduce.",
        labels: [],
      },
      repository: { name: "action-agents", description: "AI GitHub Actions" },
    };
  }

  /**
   * A recording forge whose comment list starts with the hostile comment —
   * the full pipeline sees it exactly as the thread presents it.
   */
  function world(hostileBody) {
    const store = commentStore([threadComment(1, hostileBody, "alice")]);
    return {
      forge: {
        store,
        /** The live comment list — what the pipeline's upsert operates on. */
        dumpComments: () => store.comments,
        writes: store.calls,
        async getRepository() {
          return { defaultBranch: "main", name: "action-agents", description: "" };
        },
        async getPullRequest() {
          return { number: 7, state: "open", draft: false, merged: false, title: "", body: "" };
        },
        /** The live label read a mutation is judged against. */
        async getIssue() {
          return { labels: [] };
        },
        async getContents() {
          return null; // no config file -> no sheet -> the comment half
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
        async listRepositoryLabels() {
          return [];
        },
        async listRepositoryLabelsDetailed() {
          return [];
        },
        async listComments() {
          return store.listComments();
        },
        async createComment(number, body) {
          return store.createComment(number, body);
        },
        async updateComment(id, body) {
          return store.updateComment(id, body);
        },
        async deleteComment(id) {
          return store.deleteComment(id);
        },
        async whoami() {
          return { login: "github-actions[bot]" };
        },
      },
      chat: {
        async complete() {
          return {
            content: '{"classification":"bug report","rationale":"Fails on import."}',
            toolCalls: [],
          };
        },
      },
      evidence: createEvidence(() => "aaaabbbb"),
      now: () => Date.parse("2026-07-01T11:00:00Z"),
      readEvent: async () => issueEvent(),
    };
  }

  it("writes exactly one new comment under its own marker, leaving the hostile quote byte-identical", async () => {
    const worldForge = world(HOSTILE_BODY);

    await run(inputs(), readContext(runner), worldForge);

    assert.equal(worldForge.forge.dumpComments()[0].body, HOSTILE_BODY);
    assert.equal(worldForge.forge.dumpComments().length, 2, "exactly one comment was added");
    assert.match(
      worldForge.forge.dumpComments()[1].body,
      /<!-- action-agents:triage:[0-9a-f]{6,64} -->/,
    );
    assert.deepEqual(
      worldForge.forge.writes.filter(({ op }) => op !== "createComment"),
      [],
      "nothing was deleted or rewritten — the only write is the action's own new comment",
    );
  });
});
