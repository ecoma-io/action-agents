// Mention defang — the "no mention parses" rule, through every render path.
//
// Attack: a model answers with `@everyone`, `@org/team`, `@user`,
// `@user with spaces`, `@@double` and `@user-name` — every shape that
// GitHub would turn into a live notification (or a broadcast) if it reached
// a comment intact.
//
// Bounded outcome: rule 3 of `core/sanitise.mjs` sits a zero-width
// non-joiner (`\u200C`) between every `@` and the identifier character it
// begins, so no re-render, re-run or copy-paste reassembles a notifying
// mention. The rule runs inside `sanitiseCommentText`, and every
// model-composed field of both shipped comment renderers passes through
// that function — `triage`'s classification and rationale, and `review`'s
// summary, finding messages and unverified/refuted reasons. The fixtures
// drive the real paths: `sanitiseCommentText` directly, the real `triage`
// `run()` pipeline, and `review`'s `renderComment`.
//
// Deterministic and offline: no network, no model, no timers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sanitiseCommentText } from "#core/sanitise.mjs";
import { createEvidence } from "#core/untrusted.mjs";

import { renderComment } from "../../../review/src/render.mjs";
import { run } from "../../../triage/src/index.mjs";

const BOT = "action-agents[bot]";
const NOW = "2026-07-01T11:00:00Z";
const ZWSP = "\u200C";
const HEAD = "a".repeat(40);

/**
 * The fake forge the no-sheet triage path touches, with a recording store.
 */
function forge() {
  const comments = [];
  /** @type {{ op: string, body?: string }[]} */
  const writes = [];
  return {
    comments,
    writes,
    async listComments() {
      return [...comments];
    },
    async createComment(_number, body) {
      writes.push({ op: "create", body });
      comments.push({ id: 1, body, user: { login: BOT }, created_at: NOW, updated_at: NOW });
      return { id: 1 };
    },
    async updateComment(_id, body) {
      writes.push({ op: "update", body });
    },
    async deleteComment(_id) {
      writes.push({ op: "delete" });
    },
    async getRepository() {
      return { defaultBranch: "main", name: "action-agents", description: "" };
    },
    async getRef(_branch) {
      return { sha: "0".repeat(40) };
    },
    async getContents(_path) {
      return null;
    },
    /** The live label read a mutation is judged against. */
    async getIssue(_number) {
      return { labels: [] };
    },
    async whoami() {
      return { login: BOT };
    },
  };
}

/**
 * @param {string} answer the model's raw answer
 * @returns {Promise<{ body: string }>} the one comment body the run wrote
 */
async function triageCommentBody(answer) {
  const world = forge();
  const io = {
    forge: world,
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
  await run({ model: "fake", labels: [], dryRun: false, configPath: "" }, context, io);
  const write = world.writes[0];
  assert.ok(write?.body !== undefined, "no comment was written");
  return { body: write.body };
}

describe("mention defang stays bounded", () => {
  it("breaks @everyone and @org/team — the broadcast handles", () => {
    const { text, notes } = sanitiseCommentText("ping @everyone in @org/team today");
    assert.equal(text, `ping @${ZWSP}everyone in @${ZWSP}org/team today`);
    // No string GitHub would turn into a notification survives anywhere.
    assert.ok(!/@[A-Za-z0-9_]/.test(text));
    // The names stay readable, never notifiable.
    assert.ok(text.includes("everyone") && text.includes("org/team"));
    assert.equal(notes.length, 0, "mention breaking is silent by design");
  });

  it("breaks handles, ambiguous spacing, doubles and hyphenated names", () => {
    const { text } = sanitiseCommentText(
      "@octocat saw @user with spaces and @@double for @user-name",
    );
    assert.equal(
      text,
      `@${ZWSP}octocat saw @${ZWSP}user with spaces and @@${ZWSP}double for @${ZWSP}user-name`,
    );
    assert.ok(!/@[A-Za-z0-9_]/.test(text));
  });

  it("leaves an @ that cannot begin a handle, and over-breaks emails the safe way", () => {
    // "@-leading" and "trailing @" cannot begin a handle: left alone.
    assert.equal(sanitiseCommentText("@-leading, trailing @").text, "@-leading, trailing @");
    // An email address is mangled — lossy on purpose, and harmless: nothing
    // the action writes can ever ping anyone.
    assert.equal(sanitiseCommentText("a@example.com").text, `a@${ZWSP}example.com`);
  });

  it("the triage comment half ships no live mention, through the real pipeline", async () => {
    const { body } = await triageCommentBody(
      '{"classification":"Ping @everyone from @org/team","rationale":"cc @octocat and @@double"}',
    );
    assert.ok(!/@[A-Za-z0-9_]/.test(body), "a live mention reached the triage comment");
    assert.ok(body.includes(`@${ZWSP}everyone`), "@everyone was not ZWSP-broken");
    assert.ok(body.includes(`@${ZWSP}org/team`), "@org/team was not ZWSP-broken");
    assert.ok(body.includes(`@@${ZWSP}double`), "@@double was not ZWSP-broken");
  });

  it("the review render path breaks mentions in every model-composed field", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "cc @everyone please",
      findings: [
        {
          severity: "concern",
          file: "x.mjs",
          line: 9,
          message: "ping @org/team on push",
        },
        {
          severity: "nit",
          file: "y.mjs",
          line: 2,
          message: "@octocat saw @user with spaces; @@double; @user-name",
          lifecycle: "unresolved",
          reason: "unverified by @audit-bot",
        },
      ],
      strictness: "high",
    });
    // The earlier "review @mention not defanged" flag resolves here: every
    // model-composed field (summary, message, reason) passes through
    // sanitiseCommentText, so no live mention can reach the review comment.
    assert.ok(!/@[A-Za-z0-9_]/.test(body), "a live mention survived the review render");
    assert.ok(body.includes(`@${ZWSP}everyone`), "the summary's @everyone was not broken");
    assert.ok(body.includes(`@${ZWSP}org/team`), "the message's @org/team was not broken");
    assert.ok(body.includes(`@${ZWSP}audit-bot`), "the reason's @audit-bot was not broken");
  });
});
