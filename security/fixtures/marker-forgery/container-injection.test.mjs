// Container injection — the "no raw HTML renders" rule, through the
// sanitiser and both render paths.
//
// Attack: model text carries `<details><summary>`, `</summary>`,
// `</details>`, `<img src=x onerror=…>`, `<script>…</script>` and a
// `[link](javascript:…)` markdown link — the shapes that would open a live
// HTML container, close a collapsed block early, or attach an event
// handler if they reached the thread as markup.
//
// Bounded outcome: rule 2 of `core/sanitise.mjs` entity-escapes every
// tag-shaped `<` outside a code span (`<` before a letter or slash-letter
// becomes `&lt;`), so model text carries structure only as Markdown the
// comment's scaffolding already chose. No element can open, therefore no
// event handler can attach and no container can close early. A
// `javascript:` markdown link is not HTML — the sanitiser leaves it as
// written, and the rule-2 guarantee means it can never become the href of
// an element this comment can open; the platform's renderer decides what a
// rendered link may reach. `review`'s one real `<details>` collapse is
// code-owned scaffolding, and the fixtures prove model text cannot add a
// second one.
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

describe("container injection stays bounded", () => {
  it("rule 2 escapes every tag-shaped < — openers, closers and handlers alike", () => {
    const hostile =
      "<details><summary>Proof</summary><img src=x onerror=alert(1)><script>alert(1)</script>" +
      "<a href=javascript:alert(1)>x</a></details>";
    const { text } = sanitiseCommentText(hostile);

    // Nothing a browser or GitHub would parse as a tag survives.
    assert.ok(!/<(?=\/?[A-Za-z])/.test(text), "a tag-shaped < survived rule 2");
    for (const token of ["<details", "<summary", "<img", "<script", "</"]) {
      assert.ok(!text.includes(token), `a live ${token} survived in the sanitised text`);
    }
    // No tag survives that could carry an event handler — the onerror text
    // staying behind is inert because no element it could attach to opens.
    assert.ok(!/<[A-Za-z][^>]*onerror/i.test(text), "a handler-bearing tag survived");
    // The attack text survives only escaped — readable, never markup.
    assert.ok(text.includes("&lt;details>"));
    assert.ok(text.includes("&lt;img src=x onerror=alert(1)>"));
  });

  it("model text cannot close the action's container early — the whole triage comment stays inert", async () => {
    const hostile =
      '{"classification":"alpha","rationale":"<details><summary>Sneak</summary>The real close: ' +
      '</details> plus <img src=x onerror=alert(1)> and <script>alert(1)</script>"}';
    const { body } = await triageCommentBody(hostile);

    assert.ok(!/<(?=\/?[A-Za-z])/.test(body), "a tag-shaped < reached the triage comment");
    assert.ok(!body.includes("</details>"), "a closing container tag reached the comment");
    // The hostile material survives only as escaped, inert text inside the
    // action's one block.
    assert.ok(body.includes("&lt;details>"));
    assert.ok(body.includes("&lt;script>"));
  });

  it("the review comment's own collapse is the only container; model text cannot open another", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "<details><summary>hijack</summary>",
      findings: [
        {
          severity: "nit",
          file: "x.mjs",
          line: 1,
          message: "<img src=x onerror=alert(1)> followed by </details>",
        },
        { severity: "nit", file: "y.mjs", line: 2, message: "<script>alert(1)</script>" },
      ],
      strictness: "medium",
    });

    // Exactly one collapse — the renderer's own, for nits at medium
    // strictness — and it is balanced.
    assert.equal(
      (body.match(/<details>/g) ?? []).length,
      1,
      "model text opened a second <details>",
    );
    assert.equal(
      (body.match(/<\/details>/g) ?? []).length,
      1,
      "a second </details> reached the body",
    );

    // Strip the code-owned collapse; everything left must be model-derived
    // and therefore free of any tag-shaped <.
    const codeOwned = body
      .replace("<details>", "")
      .replace("<summary>Nits (2)</summary>", "")
      .replace("</details>", "");
    assert.ok(!/<(?=\/?[A-Za-z])/.test(codeOwned), "model text added a tag to the review comment");
    assert.ok(!codeOwned.includes("<img"), "a live <img survived the review render");
    assert.ok(!codeOwned.includes("<script"), "a live <script survived the review render");
  });

  it("a javascript: markdown link stays inert text — no element it could attach to opens", async () => {
    const link = "[click](javascript:alert(1))";
    // Markdown links are not HTML: rule 2 has nothing to escape. Kept as
    // written — the property that holds is that no tag-shaped < survives,
    // so the URL can never become the attribute of a live element.
    assert.equal(sanitiseCommentText(link).text, link);
    assert.ok(!/<(?=\/?[A-Za-z])/.test(sanitiseCommentText(link).text));

    const { body } = await triageCommentBody(`{"classification":"see ${link}","rationale":"r"}`);
    assert.ok(body.includes(link), "the markdown link text was dropped");
    assert.ok(!/<(?=\/?[A-Za-z])/.test(body), "the link entered a live element");
  });
});
