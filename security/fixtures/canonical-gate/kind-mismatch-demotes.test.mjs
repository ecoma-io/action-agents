// Kind mismatch — a claimed kind the verification does not confirm demotes.
//
// Attack: a model's answer claims a finding is a `correctness` defect — the
// kind a maintainer is likeliest to treat as merge-blocking — and hopes the
// claim is rubber-stamped. The answer contract requires `kind` from the
// closed vocabulary, and the verification pass binds the kind from its own
// evidence the way it binds the verdict; a verdict that names a different
// kind than the answer claimed is refused as a mapping — the run never
// confirms a claim the evidence does not spell. The bounded outcome, pinned
// end to end through a real run: the finding publishes `unresolved` under
// the kind the verification bound (`style`), the gate BLOCKS on it under
// the all-kinds default policy, and the reason names the demoted state —
// the model's severity theatre decides nothing.
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

const roots = [];

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

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
    async createCheckRun() {
      return { id: 501 };
    },
  };
}

describe("a verified kind that contradicts the claimed kind demotes the finding", () => {
  it("publishes unresolved under the verified kind, and the gate blocks on it", async () => {
    const root = mkdtempSync(join(tmpdir(), "kind-mismatch-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.mjs"), "line1\nline2\nline3\n");
    CONTEXT.workspace = root;
    const forge = forgeStub();
    /** @type {string[]} */
    const logged = [];
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
          // The answer claims the scariest kind on the sheet.
          return {
            content:
              '{"findings":[{"severity":"concern","kind":"correctness","file":"src/a.mjs","line":2,"message":"off-by-one"}],"summary":"one concern"}',
            toolCalls: [],
            finishReason: "stop",
          };
        }
        // The verification pass answers its own kind from evidence — and it
        // is not the kind the answer claimed.
        return {
          content: '{"verdict":"confirmed","kind":"style","reason":"the span is a style miss"}',
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
      io: { forge, chat, now: () => 0, info: (m) => logged.push(m) },
    });
    assert.equal(result.outcome, "published");
    const row = /** @type {any} */ (result).canonical?.findings[0];
    // Bound from the verification's answer, not the claim's: `style`, and
    // unconfirmed — a mismatch is never mapped onto the claim.
    assert.equal(row?.kind, "style");
    assert.equal(row?.lifecycle, "unresolved");
    assert.ok(
      logged.some((line) => line.includes("names kind 'style' where the answer claimed")),
      "the demotion is named on the log",
    );
    // The gate reads the demoted record: BLOCK — the pass law's verdict
    // reason first (this run is a partial review: the demotion fails the
    // verification gate), then the unresolved style finding.
    assert.equal(/** @type {any} */ (result).gate?.verdict, "BLOCK");
    assert.deepEqual(/** @type {any} */ (result).gate?.reasons, [
      "run verdict 'fail' never passes — an incomplete review is no pass.",
      "unresolved style finding at src/a.mjs:2.",
    ]);
  });
});
