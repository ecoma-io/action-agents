// Capture refusal — the evidence boundary holds at the span gate.
//
// Attack: a compromised or hallucinating model anchors a finding on a line
// the checked-out tree does not spell — or the tree moves under the run
// after validation saw the old bytes (a rebase, a forced push re-checkout,
// a concurrent `git clean`). Since #479 the capture rides the span gate,
// synchronously after anchor validation and behind a one-read-per-anchor
// memo: validation and capture read the same bytes, so a finding the tree
// cannot spell is rejected upstream, and a tree that shrinks mid-run can
// no longer graft its movement onto the record. What this fixture pins is
// the containment that replaced the old mid-run red refusal: the verdict
// turn moves the tree, and the published finding still carries the digest
// of the bytes the gate held — evidence bound by code before any verdict
// could move the tree, never by the model's claim. A finding without a
// digest is not confirmed by anything; a digest of gate-held bytes is
// confirmed by the checkout exactly as it was read.
//
// The red refusal itself stays law for anchors no read can honour; its
// reachable matrix — absent path, binary, empty, out-of-range — is pinned
// in review/src/capture.test.mjs.
//
// Deterministic and offline: a temp workspace, a scripted model, a
// recording forge.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { reviewPullRequest } from "../../../review/src/run.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const INPUTS = {
  model: "review",
  maxTurns: 5,
  contextWindow: 128_000,
  dryRun: false,
  configPath: "",
};

const CONTEXT = { owner: "acme", repo: "widgets", workspace: "" }; // set per world

const EVENT = {
  action: "synchronize",
  pull_request: { number: 7, base: { ref: "main", sha: "8".repeat(40) } },
};

/** One temp root per world; every run's workspace has somewhere to land. */
const roots = [];

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A workspace whose reviewed file spells three lines — as validation saw it. */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "capture-refusal-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.mjs"), "line1\nline2\nline3\n");
  CONTEXT.workspace = root;
  return root;
}

/** A forge stub covering the reads a full happy-path run makes. */
function forgeStub() {
  const calls = {
    /** @type {Array<{ id?: number, body?: string }>} */
    upserts: [],
  };
  return {
    calls,
    async getPullRequest() {
      return {
        number: 7,
        state: "open",
        draft: false,
        merged: false,
        title: "the change",
        body: "",
        mergeable: true,
        mergeableState: "clean",
        labels: [],
        head: { ref: "feature", sha: HEAD },
        base: { ref: "main", sha: BASE },
      };
    },
    async getRepository() {
      return { defaultBranch: "main", name: "widgets", description: "" };
    },
    async getRef(branch) {
      assert.equal(branch, "main");
      return { sha: "7".repeat(40) };
    },
    async getContents(path) {
      if (path.endsWith("review.json5") || path.endsWith("review.json")) return null;
      return null;
    },
    async listPullRequestFiles() {
      return [
        {
          filename: "src/a.mjs",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1 +1,2 @@\n+x",
        },
      ];
    },
    async listComments() {
      return [];
    },
    async whoami() {
      return { login: "github-actions[bot]" };
    },
    async createComment(_number, body) {
      calls.upserts.push({ body });
      return { id: 101 };
    },
    async updateComment() {},
    async deleteComment() {},
  };
}

describe("the capture boundary holds the bytes the span gate read", () => {
  it("a checkout that shrinks under the run publishes the gate-held bytes — never the moved tree", async () => {
    const workspace = makeWorkspace();
    const forge = forgeStub();
    let turn = 0;
    const chat = {
      async complete() {
        turn++;
        if (turn === 1) {
          return {
            content: "",
            toolCalls: [{ id: "r1", name: "read_file", arguments: '{"path":"src/a.mjs"}' }],
            finishReason: "tool_calls",
          };
        }
        if (turn === 2) {
          return {
            content:
              '{"findings":[{"severity":"concern","kind":"correctness","file":"src/a.mjs","line":2,"message":"off-by-one"}],"summary":"one concern"}',
            toolCalls: [],
            finishReason: "stop",
          };
        }
        // The verdict turn moves the tree — after the span gate has
        // already held the anchor's bytes (#479): the capture is one
        // bounded read per anchor, taken synchronously with validation.
        writeFileSync(join(workspace, "src", "a.mjs"), "line1\n");
        return {
          content: '{"verdict":"confirmed","kind":"correctness","reason":"the guard is real"}',
          toolCalls: [],
          finishReason: "stop",
        };
      },
    };
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      eventName: "pull_request",
      event: EVENT,
      io: { forge, chat, now: () => 0, info: () => undefined },
    });
    // The record carries the gate's capture, not the moved tree: the
    // subject is the line exactly as the gate read it, digest-bound.
    assert.equal(result.outcome, "published");
    assert.equal(result.canonical?.run.state, "published");
    assert.deepEqual(result.canonical?.findings[0]?.subject, "line2");
    // The comment stands — the containment is evidence binding, not silence.
    assert.equal(forge.calls.upserts.length, 1);
  });
});
