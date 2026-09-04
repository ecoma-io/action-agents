// The U-6 measurement, pinned as a test: can the prior bodies of an
// upserted API-authored comment be read back? Measured 2026-09-04 against
// this repository: REST revisions 404s; GraphQL userContentEdits works,
// each edit carrying editedAt plus a diff holding the full prior body.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const COMMENT_DB_ID = 5528240709;
const OWNER = "ecoma-io";
const REPO = "action-agents";
const PR_NUMBER = 257;
const MARKER_PREFIX = "action-agents:review:";
const EDITED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** @param {string} path */
function restPath(path) {
  return `https://api.github.com${path}`;
}

/**
 * @param {string} token
 * @returns {Promise<Response>}
 */
function probeRevisions(token) {
  return fetch(
    restPath(`/repos/${OWNER}/${REPO}/issues/comments/${String(COMMENT_DB_ID)}/revisions`),
    {
      headers: { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
    },
  );
}

/**
 * @param {string} token
 * @returns {Promise<{ status: number, edits: { editedAt: string, diff: string | null, deletedAt: string | null }[] }>}
 */
async function probeEdits(token) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query:
        "query($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner, name:$name) { " +
        "pullRequest(number:$number) { comments(first: 30) { nodes { databaseId " +
        "userContentEdits(first: 10) { totalCount nodes { editedAt diff deletedAt } } } } } } }",
      variables: { owner: OWNER, name: REPO, number: PR_NUMBER },
    }),
  });
  const payload =
    /** @type {{ data?: { repository?: { pullRequest?: { comments?: { nodes?: { databaseId: number, userContentEdits?: { totalCount: number, nodes: { editedAt: string, diff: string | null, deletedAt: string | null }[] } | null }[] } } } } }} */ (
      await response.json()
    );
  const comments = payload.data?.repository?.pullRequest?.comments?.nodes;
  const target = comments?.find((comment) => comment.databaseId === COMMENT_DB_ID);
  const edits = target?.userContentEdits;
  return {
    status: response.status,
    edits: edits === null || edits === undefined ? [] : edits.nodes,
  };
}

describe("comment revision history (U-6, live API)", { skip: !process.env.U6_LIVE }, () => {
  it("the REST revisions surface answers the measured 404", async () => {
    const token = process.env.U6_TOKEN ?? process.env.GITHUB_TOKEN;
    assert.ok(token, "a readable token is required for the live probe");
    const response = await probeRevisions(token);
    assert.equal(
      response.status,
      404,
      "the REST revisions endpoint answered something other than the measured 404 — re-measure U-6",
    );
  });

  it("GraphQL userContentEdits reconstructs the prior bodies of an edited bot comment", async () => {
    const token = process.env.U6_LIVE
      ? (process.env.U6_TOKEN ?? process.env.GITHUB_TOKEN)
      : undefined;
    assert.ok(token, "a readable token is required for the live probe");
    const { status, edits } = await probeEdits(token);
    assert.equal(status, 200, "the GraphQL probe itself failed");
    assert.ok(edits.length >= 1, "the pinned comment has lost its edit history");
    for (const edit of edits) {
      assert.match(edit.editedAt, EDITED_AT_PATTERN);
      assert.equal(edit.deletedAt, null);
      assert.ok(
        typeof edit.diff === "string" && edit.diff.length > 0,
        "an edit carries no diff — prior bodies are no longer reconstructable",
      );
    }
    assert.ok(
      edits.some((edit) => typeof edit.diff === "string" && edit.diff.includes(MARKER_PREFIX)),
      "the prior body no longer carries the review marker — the record type changed, re-measure",
    );
  });
});
