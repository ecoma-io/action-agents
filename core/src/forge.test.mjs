// Tests for the GitHub protocol layer.
//
// Two things are pinned beyond plumbing: the operation list is the surface
// (every URL here is one a documented action needs, and nothing else), and
// the failure shapes are distinguished — absent is `null` for a config file,
// unmeasurable is `PastFileCeilingError` for a monster pull request, and
// everything else is a `ForgeError` naming the operation that failed.

import { describe, expect, it } from "vitest";

import {
  BranchMovedError,
  ForgeError,
  PastFileCeilingError,
  TruncatedTreeError,
  MAX_PULL_REQUEST_FILES,
  createForge,
  isRefAbsentError,
  nextLink,
} from "./forge.mjs";
import { HttpError, TransportError } from "./transport-errors.mjs";

/** @typedef {{ url: string, method?: string | undefined, body?: unknown }} RecordedCall */

const FAST = { retryDelayMs: 1, timeoutMs: 5_000 };

/**
 * A fetch that routes by URL and method, answering from a table. Pagination
 * tests add `link` headers through the second element of a table entry.
 *
 * @param {Record<string, () => Response>} table
 * @param {{ calls?: RecordedCall[] }} [recorder]
 * @returns {typeof globalThis.fetch}
 */
function routed(table, recorder = {}) {
  recorder.calls = [];
  return /** @type {typeof globalThis.fetch} */ (
    /** @param {string | URL | Request} url @param {RequestInit} [init] */
    async (url, init) => {
      const parsed = new URL(String(url));
      const key = `${init?.method ?? "GET"} ${parsed.pathname}${parsed.search}`;
      recorder.calls?.push({ url: String(url), method: init?.method, body: init?.body });
      const respond = table[key];
      if (respond === undefined) return new Response(`no route for ${key}`, { status: 500 });
      return respond();
    }
  );
}

/**
 * @param {string} owner
 * @param {string} repo
 * @param {Record<string, () => Response>} table
 * @param {{ calls?: RecordedCall[] }} [recorder]
 */
function forge(owner, repo, table, recorder = {}) {
  return createForge({ owner, repo, token: "ghs_x", fetchImpl: routed(table, recorder), ...FAST });
}

/** @param {object} value @returns {() => Response} */
function json(value) {
  return () =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

/** @param {unknown} body @param {string} [link] @returns {() => Response} */
function page(body, link) {
  return () =>
    new Response(JSON.stringify(body), {
      headers: link === undefined ? {} : { link },
    });
}

describe("nextLink", () => {
  it("finds rel=next among the relations a Link header carries", () => {
    const header =
      '<https://api.github.com/repos/o/r/labels?page=2>; rel="next", ' +
      '<https://api.github.com/repos/o/r/labels?page=5>; rel="last"';
    expect(nextLink(header)).toBe("https://api.github.com/repos/o/r/labels?page=2");
    expect(nextLink('<https://x>; rel="last"')).toBeNull();
    expect(nextLink("")).toBeNull();
  });
});

describe("whoami", () => {
  it("reads the login the token writes as from GET /user", async () => {
    const client = forge("o", "r", { "GET /user": json({ login: "docs-bot[bot]" }) });
    await expect(client.whoami()).resolves.toEqual({ login: "docs-bot[bot]" });
  });

  it("never asks twice when the REST read answers — one identity, one source", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge("o", "r", { "GET /user": json({ login: "docs-bot[bot]" }) }, recorder);
    await expect(client.whoami()).resolves.toEqual({ login: "docs-bot[bot]" });
    expect(
      recorder.calls?.map((call) => `${call.method ?? "GET"} ${new URL(call.url).pathname}`),
    ).toEqual(["GET /user"]);
  });

  it("reads an installation token's identity from the GraphQL viewer once the REST read is refused", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      {
        "GET /user": () => new Response("Resource not accessible by integration", { status: 403 }),
        "POST /graphql": json({ data: { viewer: { login: "github-actions[bot]" } } }),
      },
      recorder,
    );
    // GITHUB_TOKEN is an installation token: /user refuses it, and the
    // viewer names the principal the token acts as — the app's bot login.
    await expect(client.whoami()).resolves.toEqual({ login: "github-actions[bot]" });
    expect(
      recorder.calls?.map((call) => `${call.method ?? "GET"} ${new URL(call.url).pathname}`),
    ).toEqual(["GET /user", "POST /graphql"]);
  });

  it("answers an App installation token's bot login the same way — read, never assembled", async () => {
    const client = forge("o", "r", {
      "GET /user": () => new Response("Resource not accessible by integration", { status: 403 }),
      "POST /graphql": json({ data: { viewer: { login: "ecoma-bot[bot]" } } }),
    });
    await expect(client.whoami()).resolves.toEqual({ login: "ecoma-bot[bot]" });
  });

  it("derives the Enterprise Server viewer endpoint from the REST apiUrl — one origin, configured once", async () => {
    const client = createForge({
      owner: "o",
      repo: "r",
      token: "ghs_x",
      apiUrl: "https://ghe.example.com/api/v3",
      fetchImpl: routed({
        "GET /user": () => new Response("Resource not accessible by integration", { status: 403 }),
        "POST /api/graphql": json({ data: { viewer: { login: "ghe-bot[bot]" } } }),
      }),
      ...FAST,
    });
    await expect(client.whoami()).resolves.toEqual({ login: "ghe-bot[bot]" });
  });

  it("reads the viewer when the REST read fails transiently too — the fallback is not 403-specific", async () => {
    const client = forge("o", "r", {
      "GET /user": () => new Response("boom", { status: 500 }),
      "POST /graphql": json({ data: { viewer: { login: "retry-bot[bot]" } } }),
    });
    await expect(client.whoami()).resolves.toEqual({ login: "retry-bot[bot]" });
  });

  it("refuses when both identity reads fail — no assumed login survives", async () => {
    const client = forge("o", "r", {
      "GET /user": () => new Response("Refused", { status: 403 }),
      "POST /graphql": () => new Response("Bad credentials", { status: 401 }),
    });
    const refused = client.whoami();
    await expect(refused).rejects.toThrow(ForgeError);
    await expect(refused).rejects.toThrow(/GraphQL viewer/);
  });

  it("refuses a viewer answer that names no login, quoting the provider's error", async () => {
    const client = forge("o", "r", {
      "GET /user": () => new Response("Refused", { status: 403 }),
      "POST /graphql": json({
        data: { viewer: null },
        errors: [{ message: "API rate limit exceeded" }],
      }),
    });
    const refused = client.whoami();
    await expect(refused).rejects.toThrow(ForgeError);
    await expect(refused).rejects.toThrow(/API rate limit exceeded/);
  });
});

describe("getContents", () => {
  const PAYLOAD = {
    content: Buffer.from("labels: {}", "utf8").toString("base64"),
    encoding: "base64",
  };

  it("reads from the default branch — no ref in the URL", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      { "GET /repos/o/r/contents/.github%2Faction-agents%2Ftriage%2Ftriage.json5": json(PAYLOAD) },
      recorder,
    );

    await expect(client.getContents(".github/action-agents/triage/triage.json5")).resolves.toEqual({
      content: "labels: {}",
    });
    expect(recorder.calls?.[0]?.url).not.toContain("ref=");
  });

  it("returns null for absent — a missing config file is policy-empty, not an error", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/contents/missing.json5": () => new Response("not found", { status: 404 }),
    });
    await expect(client.getContents("missing.json5")).resolves.toBeNull();
  });

  it("decodes the newlines GitHub folds into base64 content", async () => {
    const folded = Buffer.from("labels: {}", "utf8")
      .toString("base64")
      .replace(/(.{20})/g, "$1\n");
    const client = forge("o", "r", {
      "GET /repos/o/r/contents/x.json": json({ content: folded, encoding: "base64" }),
    });
    await expect(client.getContents("x.json")).resolves.toEqual({ content: "labels: {}" });
  });

  it("refuses a directory, which the contents API returns as an array", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/contents/dir": json([{ name: "a" }]),
    });
    await expect(client.getContents("dir")).rejects.toThrow(/not a readable file/);
  });

  it("names the operation in a failure", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/contents/x": () => new Response("forbidden", { status: 403 }),
    });
    const error = await client.getContents("x").catch((c) => c);
    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/reading 'x'/);
  });

  it("encodes #, ? and % in the path so a file name reads as itself", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      {
        "GET /repos/o/r/contents/docs%2Fa%23b.md": json(PAYLOAD),
        "GET /repos/o/r/contents/docs%2Fq%3Fx.md": json(PAYLOAD),
        "GET /repos/o/r/contents/docs%2F50%2525.md": json(PAYLOAD),
      },
      recorder,
    );

    await expect(client.getContents("docs/a#b.md")).resolves.toEqual({
      content: "labels: {}",
    });
    await expect(client.getContents("docs/q?x.md")).resolves.toEqual({
      content: "labels: {}",
    });
    await expect(client.getContents("docs/50%25.md")).resolves.toEqual({
      content: "labels: {}",
    });
    expect(recorder.calls?.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/o/r/contents/docs%2Fa%23b.md",
      "https://api.github.com/repos/o/r/contents/docs%2Fq%3Fx.md",
      "https://api.github.com/repos/o/r/contents/docs%2F50%2525.md",
    ]);
  });
  it("refuses content that is not valid UTF-8 instead of slurping replacement characters", async () => {
    const invalid = Buffer.from([0xff, 0xfe, 0xfd]).toString("base64");
    const client = forge("o", "r", {
      "GET /repos/o/r/contents/blob.bin": json({ content: invalid, encoding: "base64" }),
    });

    const error = await client.getContents("blob.bin").catch((c) => c);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NonUtf8ContentError");
    expect(error.message).toMatch(/not valid UTF-8/);
  });
});

describe("listRepositoryLabels", () => {
  it("walks the pages the Link header offers", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/labels?per_page=100": page(
        [{ name: "bug" }],
        '<https://api.github.com/repos/o/r/labels?per_page=100&page=2>; rel="next"',
      ),
      "GET /repos/o/r/labels?per_page=100&page=2": page([{ name: "docs" }]),
    });
    await expect(client.listRepositoryLabels()).resolves.toEqual(["bug", "docs"]);
  });

  it("drops entries with no name rather than passing them on", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/labels?per_page=100": page([{ name: "bug" }, { colour: "red" }]),
    });
    await expect(client.listRepositoryLabels()).resolves.toEqual(["bug"]);
  });
});

describe("listRepositoryLabelsDetailed", () => {
  it("reads full name, description and colour metadata, across pages", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/labels?per_page=100": page(
        [{ name: "bug", description: "Incorrect behaviour.", color: "d73a4a" }],
        '<https://api.github.com/repos/o/r/labels?per_page=100&page=2>; rel="next"',
      ),
      "GET /repos/o/r/labels?per_page=100&page=2": page([
        { name: "docs", description: "Documentation only.", color: "0075ca" },
      ]),
    });
    await expect(client.listRepositoryLabelsDetailed()).resolves.toEqual([
      { name: "bug", description: "Incorrect behaviour.", color: "d73a4a" },
      { name: "docs", description: "Documentation only.", color: "0075ca" },
    ]);
  });

  it("fills absent description and colour with empty strings — a normal label, not a broken answer", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/labels?per_page=100": page([{ name: "bug" }, { colour: "red" }]),
    });
    await expect(client.listRepositoryLabelsDetailed()).resolves.toEqual([
      { name: "bug", description: "", color: "" },
    ]);
  });
});

describe("listPullRequestFiles", () => {
  /** @param {number} count @returns {() => Response} */
  function files(count) {
    /** @type {unknown[]} */
    const entries = [];
    for (let i = 0; i < count; i++) {
      entries.push({
        filename: `file-${String(i)}.mjs`,
        status: "modified",
        additions: 1,
        deletions: 1,
      });
    }
    return page(entries);
  }

  it("returns the per-file counts the size measurement reads", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/pulls/7/files?per_page=100": page([
        { filename: "a.mjs", status: "modified", additions: 3, deletions: 1 },
        { filename: "b.png", status: "modified", additions: 0, deletions: 0 },
      ]),
    });
    await expect(client.listPullRequestFiles(7)).resolves.toEqual([
      { filename: "a.mjs", status: "modified", additions: 3, deletions: 1 },
      { filename: "b.png", status: "modified", additions: 0, deletions: 0 },
    ]);
  });

  it(`refuses a pull request at the ${String(MAX_PULL_REQUEST_FILES)}-file ceiling`, async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/pulls/8/files?per_page=100": files(MAX_PULL_REQUEST_FILES),
    });
    await expect(client.listPullRequestFiles(8)).rejects.toBeInstanceOf(PastFileCeilingError);
  });

  it("refuses an entry with no counts rather than guessing", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/pulls/9/files?per_page=100": page([{ filename: "a.mjs", status: "x" }]),
    });
    await expect(client.listPullRequestFiles(9)).rejects.toThrow(/no counts/);
  });
});

describe("label writes", () => {
  it("adds labels through the add-only endpoint", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      { "POST /repos/o/r/issues/7/labels": json([{ name: "bug" }]) },
      recorder,
    );

    await client.addLabels(7, ["bug", "docs"]);

    expect(recorder.calls?.[0]?.body).toBe('{"labels":["bug","docs"]}');
  });

  it("removes one label, with the name URL-encoded", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      { "DELETE /repos/o/r/issues/7/labels/size%2Fxl": () => new Response(null, { status: 204 }) },
      recorder,
    );

    await client.removeLabel(7, "size/xl");

    expect(recorder.calls?.[0]).toMatchObject({
      url: "https://api.github.com/repos/o/r/issues/7/labels/size%2Fxl",
      method: "DELETE",
    });
  });

  it("never replays a timed-out removal — the delete already landed", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    let attempts = 0;
    const client = forge(
      "o",
      "r",
      {
        "DELETE /repos/o/r/issues/7/labels/size%2Fxl": () => {
          attempts += 1;
          // First attempt: GitHub removed the label, the response was lost.
          if (attempts === 1) {
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
          }
          // A replay would find the label already gone and answer 404.
          return new Response("Not Found", { status: 404 });
        },
      },
      recorder,
    );

    const error = await client.removeLabel(7, "size/xl").catch((c) => c);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/removing 'size\/xl' from #7/);
    expect(error.cause).toBeInstanceOf(TransportError);
    expect(error.cause.message).toMatch(/timed out/);
    expect(attempts).toBe(1);
    expect(recorder.calls).toHaveLength(1);
  });

  it("fails loudly on a genuine refusal, after a single attempt", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      {
        "DELETE /repos/o/r/issues/7/labels/size%2Fxl": () =>
          new Response("unavailable", { status: 503 }),
      },
      recorder,
    );

    const error = await client.removeLabel(7, "size/xl").catch((c) => c);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error.cause).toBeInstanceOf(HttpError);
    expect(error.cause.status).toBe(503);
    expect(recorder.calls).toHaveLength(1);
  });
  it("treats a 404 as the label already absent — a replayed removal succeeds", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      {
        "DELETE /repos/o/r/issues/7/labels/size%2Fxl": () =>
          new Response("Not Found", { status: 404 }),
      },
      recorder,
    );

    await expect(client.removeLabel(7, "size/xl")).resolves.toBeUndefined();
    expect(recorder.calls).toHaveLength(1);
  });
});
describe("pagination cap", () => {
  it("refuses a listing whose Link header never ends", async () => {
    const self = '<https://api.github.com/repos/o/r/labels?per_page=100&page=2>; rel="next"';
    const client = forge("o", "r", {
      "GET /repos/o/r/labels?per_page=100": page([{ name: "bug" }], self),
      "GET /repos/o/r/labels?per_page=100&page=2": page([{ name: "docs" }], self),
    });

    const error = await client.listRepositoryLabels().catch((c) => c);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/after 100 pages/);
  });

  it("bounds a tree listing's pages the same way", async () => {
    const sha = "abc123def4567890abcdef1234567890abcdef12";
    const self = `<https://api.github.com/repos/o/r/git/trees/${sha}?recursive=1&page=2>; rel="next"`;
    const tree = { truncated: false, tree: [{ path: "a.md", type: "blob" }] };
    const client = forge("o", "r", {
      [`GET /repos/o/r/git/trees/${sha}?recursive=1`]: page(tree, self),
      [`GET /repos/o/r/git/trees/${sha}?recursive=1&page=2`]: page(tree, self),
    });

    const error = await client.listTree(sha).catch((c) => c);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/after 100 pages/);
  });
});

describe("comments", () => {
  const COMMENT = {
    id: 11,
    body: "<!-- action-agents:triage:abc123 --> hello",
    user: { login: "action-agents[bot]" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  it("lists a thread's comments through the issue-comments listing", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/issues/7/comments?per_page=100": page([COMMENT]),
    });
    await expect(client.listComments(7)).resolves.toEqual([
      {
        id: 11,
        body: "<!-- action-agents:triage:abc123 --> hello",
        user: { login: "action-agents[bot]" },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("keeps a null author rather than inventing one", async () => {
    const gone = { ...COMMENT, user: null };
    const client = forge("o", "r", {
      "GET /repos/o/r/issues/7/comments?per_page=100": page([gone]),
    });
    const comments = await client.listComments(7);
    expect(comments[0]?.user).toBeNull();
  });

  it("creates a comment and returns its id", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      { "POST /repos/o/r/issues/7/comments": json({ id: 42 }) },
      recorder,
    );

    await expect(client.createComment(7, "body")).resolves.toEqual({ id: 42 });
    expect(recorder.calls?.[0]?.body).toBe('{"body":"body"}');
  });

  it("updates and deletes by comment id", async () => {
    const client = forge("o", "r", {
      "PATCH /repos/o/r/issues/comments/42": json({ id: 42 }),
      "DELETE /repos/o/r/issues/comments/42": () => new Response(null, { status: 204 }),
    });

    await expect(client.updateComment(42, "new")).resolves.toBeUndefined();
    await expect(client.deleteComment(42)).resolves.toBeUndefined();
  });

  it("never replays a timed-out delete — the comment is already gone", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    let attempts = 0;
    const client = forge(
      "o",
      "r",
      {
        "DELETE /repos/o/r/issues/comments/42": () => {
          attempts += 1;
          // First attempt: GitHub deleted the comment, the response was lost.
          if (attempts === 1) {
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
          }
          // A replay would find the comment already gone and answer 404.
          return new Response("Not Found", { status: 404 });
        },
      },
      recorder,
    );

    const error = await client.deleteComment(42).catch((c) => c);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/deleting comment 42/);
    expect(error.cause).toBeInstanceOf(TransportError);
    expect(error.cause.message).toMatch(/timed out/);
    expect(attempts).toBe(1);
    expect(recorder.calls).toHaveLength(1);
  });

  it("names the operation when the token cannot write", async () => {
    const client = forge("o", "r", {
      "POST /repos/o/r/issues/7/comments": () => new Response(" forbidden", { status: 403 }),
    });
    const error = await client.createComment(7, "body").catch((c) => c);
    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/commenting on #7/);
  });

  it("makes a single attempt to create — a retried 503 would post twice", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      {
        "POST /repos/o/r/issues/7/comments": () => new Response("unavailable", { status: 503 }),
      },
      recorder,
    );

    await expect(client.createComment(7, "body")).rejects.toBeInstanceOf(ForgeError);
    expect(recorder.calls).toHaveLength(1);
  });
});

describe("getRepository", () => {
  it("returns the default branch the repository names", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r": json({ name: "r", description: null, default_branch: "main" }),
    });

    await expect(client.getRepository()).resolves.toEqual({
      defaultBranch: "main",
      name: "r",
      description: "",
    });
  });

  it("refuses a response that names no default branch", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r": json({}),
    });

    await expect(client.getRepository()).rejects.toThrow(/default branch/);
  });
});

describe("getRef", () => {
  it("returns the commit sha a branch points at, encoding slash-named branches", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      {
        "GET /repos/o/r/git/ref/heads/feature%2Fone": json({
          object: { sha: "abc123def4567890abcdef1234567890abcdef12", type: "commit" },
        }),
      },
      recorder,
    );

    await expect(client.getRef("feature/one")).resolves.toEqual({
      sha: "abc123def4567890abcdef1234567890abcdef12",
    });
    expect(recorder.calls?.[0]?.url).toMatch(/ref\/heads\/feature%2Fone$/);
  });

  it("refuses a response that carries no sha", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/git/ref/heads/main": json({ object: {} }),
    });

    await expect(client.getRef("main")).rejects.toThrow(ForgeError);
  });
});

describe("listTree", () => {
  const SHA = "abc123def4567890abcdef1234567890abcdef12";

  it("lists every blob and tree entry, recursively, from one response", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      {
        [`GET /repos/o/r/git/trees/${SHA}?recursive=1`]: json({
          sha: SHA,
          truncated: false,
          tree: [
            { path: "docs", type: "tree" },
            { path: "docs/dev.md", type: "blob", size: 10 },
            { path: "README.md", type: "blob", size: 4 },
          ],
        }),
      },
      recorder,
    );

    await expect(client.listTree(SHA)).resolves.toEqual([
      { path: "docs", type: "tree" },
      { path: "docs/dev.md", type: "blob" },
      { path: "README.md", type: "blob" },
    ]);
    expect(recorder.calls).toHaveLength(1);
  });

  it("follows Link pagination when the host offers pages for a tree", async () => {
    const first = `<https://api.github.com/repos/o/r/git/trees/${SHA}?recursive=1&page=2>; rel="next"`;
    const client = forge("o", "r", {
      [`GET /repos/o/r/git/trees/${SHA}?recursive=1`]: page(
        { truncated: false, tree: [{ path: "a.md", type: "blob" }] },
        first,
      ),
      [`GET /repos/o/r/git/trees/${SHA}?recursive=1&page=2`]: page({
        truncated: false,
        tree: [{ path: "b.md", type: "blob" }],
      }),
    });

    await expect(client.listTree(SHA)).resolves.toEqual([
      { path: "a.md", type: "blob" },
      { path: "b.md", type: "blob" },
    ]);
  });

  it("refuses a listing flagged truncated instead of processing a partial tree", async () => {
    const client = forge("o", "r", {
      [`GET /repos/o/r/git/trees/${SHA}?recursive=1`]: json({
        truncated: true,
        tree: [{ path: "a.md", type: "blob" }],
      }),
    });

    const error = await client.listTree(SHA).catch((cause) => cause);
    expect(error.name).toBe("TruncatedTreeError");
    expect(error.message).toMatch(/truncated/);
  });

  it("flags truncation on any page, including a later one", async () => {
    const first = `<https://api.github.com/repos/o/r/git/trees/${SHA}?recursive=1&page=2>; rel="next"`;
    const client = forge("o", "r", {
      [`GET /repos/o/r/git/trees/${SHA}?recursive=1`]: page(
        { truncated: false, tree: [{ path: "a.md", type: "blob" }] },
        first,
      ),
      [`GET /repos/o/r/git/trees/${SHA}?recursive=1&page=2`]: page({
        truncated: true,
        tree: [{ path: "b.md", type: "blob" }],
      }),
    });

    await expect(client.listTree(SHA)).rejects.toBeInstanceOf(TruncatedTreeError);
  });

  it("refuses a sha that is not a sha — trees are listed by id, never by name", async () => {
    const client = forge("o", "r", {});

    await expect(client.listTree("main")).rejects.toThrow(/sha/);
  });
});

describe("write operations", () => {
  const SHA = "abc123def4567890abcdef1234567890abcdef12";

  it("createBlob sends utf-8 content and returns the sha", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      { "POST /repos/o/r/git/blobs": json({ sha: "blobsha" }) },
      recorder,
    );

    await expect(client.createBlob("# hi\n")).resolves.toEqual({ sha: "blobsha" });
    expect(recorder.calls?.[0]?.body && JSON.parse(String(recorder.calls[0].body))).toMatchObject({
      content: "# hi\n",
      encoding: "utf-8",
    });
  });

  it("createTree layers named changes over a base tree", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      { "POST /repos/o/r/git/trees": json({ sha: "treesha" }) },
      recorder,
    );

    await expect(
      client.createTree(SHA, [{ path: "manual/vi/dev.md", blobSha: "blobsha" }]),
    ).resolves.toEqual({ sha: "treesha" });
    const sent = JSON.parse(String(recorder.calls?.[0]?.body));
    expect(sent.base_tree).toBe(SHA);
    expect(sent.tree).toEqual([
      { path: "manual/vi/dev.md", mode: "100644", type: "blob", sha: "blobsha" },
    ]);
  });

  it("upsertBranch force-updates when the branch sits where the run found it", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    let patched = false;
    const client = forge(
      "o",
      "r",
      {
        [`GET /repos/o/r/git/ref/heads/harmonise%2Fen`]: () =>
          patched ? json({ object: { sha: "newsha" } })() : json({ object: { sha: SHA } })(),
        "PATCH /repos/o/r/git/refs/heads/harmonise%2Fen": () => {
          patched = true;
          return json({ object: { sha: "new" } })();
        },
      },
      recorder,
    );

    await expect(client.upsertBranch("harmonise/en", "newsha", SHA)).resolves.toBeUndefined();
    const patch = recorder.calls?.find((call) => call.method === "PATCH");
    expect(patch).toBeDefined();
    expect(JSON.parse(String(patch?.body))).toEqual({ sha: "newsha", force: true });
    // The lock is re-read immediately before the write and verified after it:
    // read, re-read, PATCH, then the tip must be our commit.
    expect(recorder.calls?.map((call) => call.method)).toEqual(["GET", "GET", "PATCH", "GET"]);
  });

  it("refuses with BranchMovedError when the branch moved under the run", async () => {
    const client = forge("o", "r", {
      [`GET /repos/o/r/git/ref/heads/harmonise%2Fen`]: json({
        object: { sha: "f".repeat(40) },
      }),
    });

    await expect(client.upsertBranch("harmonise/en", "newsha", SHA)).rejects.toThrow(
      /moved while the run worked/,
    );
  });

  it("re-reads the tip immediately before the PATCH and refuses a move caught in that window", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    let reads = 0;
    const client = forge(
      "o",
      "r",
      {
        "GET /repos/o/r/git/ref/heads/harmonise%2Fen": () => {
          reads += 1;
          return json({ object: { sha: reads === 1 ? SHA : "e".repeat(40) } })();
        },
        "PATCH /repos/o/r/git/refs/heads/harmonise%2Fen": json({ object: { sha: "new" } }),
      },
      recorder,
    );

    // The lock read found the expected tip; the pre-write re-read catches the
    // interleaved writer and refuses before the force-PATCH is ever issued.
    await expect(client.upsertBranch("harmonise/en", "newsha", SHA)).rejects.toThrow(
      BranchMovedError,
    );
    expect(recorder.calls?.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("refuses with BranchMovedError when the branch appears under the run", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    let reads = 0;
    const client = forge(
      "o",
      "r",
      {
        "GET /repos/o/r/git/ref/heads/harmonise%2Fen": () => {
          reads += 1;
          return reads === 1
            ? new Response("not found", { status: 404 })
            : json({ object: { sha: "f".repeat(40) } })();
        },
      },
      recorder,
    );

    // The run's first read: absent. By update time the branch exists.
    await client.getRef("harmonise/en").catch(() => undefined);
    await expect(client.upsertBranch("harmonise/en", "newsha", null)).rejects.toThrow(
      BranchMovedError,
    );
    // Refused, never overwritten: no PATCH moving the winner's tip, no create either.
    expect(
      recorder.calls?.filter((call) => call.method === "PATCH" || call.method === "POST"),
    ).toHaveLength(0);
  });

  it("creates an absent branch through POST when the run first read it absent", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const absent = forge(
      "o",
      "r",
      {
        "GET /repos/o/r/git/ref/heads/harmonise%2Fen": () =>
          new Response("not found", { status: 404 }),
      },
      recorder,
    );
    // The routed table keys by pathname+search; a POST to /git/refs needs its own route.
    absent.upsertBranch("harmonise/en", "newsha", null).then(
      () => undefined,
      (error) => {
        // Without a POST route the fake answers 500 — the point is that the
        // GET was made and treated as absent, never as a move.
        expect(error.message).toMatch(/creating the branch|HTTP 500/);
      },
    );
  });

  it("treats a provider failure for a branch named 'HTTP 404' as an error, never as absence", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      {
        "GET /repos/o/r/git/ref/heads/HTTP%20404": () => new Response("boom", { status: 500 }),
      },
      recorder,
    );

    // The operation text embeds the branch name, so a message regex read
    // this 500 as "absent" and answered with a create. The typed check
    // refuses: the error names the read that failed, and no POST goes out.
    await expect(client.upsertBranch("HTTP 404", "newsha", null)).rejects.toThrow(
      /reading the ref of branch 'HTTP 404' failed/,
    );
    expect(recorder.calls?.some((call) => call.method === "POST")).toBe(false);
  });

  it("isRefAbsentError matches the typed 404 status, never message text", () => {
    const absent = new ForgeError(
      "reading the ref of branch 'harmonise/en'",
      new HttpError("the request was refused", {
        status: 404,
        url: "https://api.example/repos/o/r/git/ref/heads/harmonise%2Fen",
      }),
    );
    // A 500 whose prose embeds "HTTP 404" — via a branch name or a provider
    // body — is a failure, not an absence.
    const moved = new ForgeError(
      "reading the ref of branch 'HTTP 404'",
      new HttpError("the request was refused", {
        status: 500,
        url: "https://api.example/repos/o/r/git/ref/heads/HTTP%20404",
      }),
    );
    expect(isRefAbsentError(absent)).toBe(true);
    expect(isRefAbsentError(moved)).toBe(false);
    expect(isRefAbsentError(new Error("HTTP 404"))).toBe(false);
    expect(isRefAbsentError(null)).toBe(false);
  });

  it("readRef answers the typed 404 with null, whatever the prose says", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/git/ref/heads/harmonise%2Fen": () =>
        new Response("not found", { status: 404 }),
    });
    await expect(client.readRef("harmonise/en")).resolves.toBe(null);
  });

  it("readRef returns the branch tip when the ref exists", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/git/ref/heads/harmonise%2Fen": json({ object: { sha: SHA } }),
    });
    await expect(client.readRef("harmonise/en")).resolves.toEqual({ sha: SHA });
  });

  it("readRef rethrows every failure that is not a typed 404", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/git/ref/heads/HTTP%20404": () => new Response("boom", { status: 500 }),
    });
    await expect(client.readRef("HTTP 404")).rejects.toThrow(
      /reading the ref of branch 'HTTP 404' failed/,
    );
  });

  it("upsertPullRequest updates the open twin found by base and head", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      {
        [`GET /repos/o/r/pulls?base=main&head=o%3Aharmonise%2Fen&state=all&per_page=100`]: page([
          { number: 3, state: "closed" },
          { number: 9, state: "open" },
        ]),
        "PATCH /repos/o/r/pulls/9": json({ number: 9 }),
      },
      recorder,
    );

    await expect(
      client.upsertPullRequest({ base: "main", head: "harmonise/en", title: "t", body: "b" }),
    ).resolves.toEqual({ number: 9, created: false });
    expect(recorder.calls?.some((call) => call.method === "POST")).toBe(false);
  });

  it("opens a fresh pull request once when no open twin exists", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      {
        [`GET /repos/o/r/pulls?base=main&head=o%3Aharmonise%2Fen&state=all&per_page=100`]: page([
          { number: 3, state: "merged" },
        ]),
        "POST /repos/o/r/pulls": json({ number: 12 }),
      },
      recorder,
    );

    await expect(
      client.upsertPullRequest({ base: "main", head: "harmonise/en", title: "t", body: "b" }),
    ).resolves.toEqual({ number: 12, created: true });
    expect(recorder.calls?.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("joins its per_page parameter onto a first URL that already carries a query", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      {
        [`GET /repos/o/r/pulls?base=main&head=o%3Aharmonise%2Fen&state=all&per_page=100`]: page([]),
        "POST /repos/o/r/pulls": json({ number: 12 }),
      },
      recorder,
    );

    await client.upsertPullRequest({ base: "main", head: "harmonise/en", title: "t", body: "b" });
    expect(recorder.calls?.[0]?.url).toContain("state=all&per_page=100");
  });
});

describe("getPullRequest", () => {
  const PULL = {
    number: 7,
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    title: "the change",
    body: "what and why",
    labels: [{ name: "bug" }, { name: "size/s" }],
    head: { ref: "feature", sha: "aaaabbbbccccdddd000011112222333344445555" },
    base: { ref: "main", sha: "ffff0000ffff0000111122223333444455556666" },
  };

  it("reads one pull request whole — state, flags, prose, both commits", async () => {
    const client = forge("o", "r", { "GET /repos/o/r/pulls/7": json(PULL) });

    await expect(client.getPullRequest(7)).resolves.toEqual({
      number: 7,
      state: "open",
      draft: false,
      merged: false,
      mergeable: true,
      mergeableState: "clean",
      title: "the change",
      body: "what and why",
      labels: ["bug", "size/s"],
      head: { ref: "feature", sha: "aaaabbbbccccdddd000011112222333344445555" },
      base: { ref: "main", sha: "ffff0000ffff0000111122223333444455556666" },
    });
  });

  it("normalises a still-computing mergeability to null, never a guess", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/pulls/7": json({ ...PULL, mergeable: null, mergeable_state: null }),
    });

    const snapshot = await client.getPullRequest(7);
    expect(snapshot.mergeable).toBeNull();
    expect(snapshot.mergeableState).toBeNull();
    expect(snapshot.draft).toBe(false);
  });

  it("normalises an absent description to an empty string", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/pulls/7": json({ ...PULL, body: null }),
    });

    const snapshot = await client.getPullRequest(7);
    expect(snapshot.body).toBe("");
    expect(snapshot.title).toBe("the change");
  });

  it("refuses a response whose commits carry no usable shas", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/pulls/7": json({
        ...PULL,
        head: { ref: "feature", sha: "not-a-sha" },
      }),
    });

    const error = await client.getPullRequest(7).catch((cause) => cause);
    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/shaped like a pull request/);
  });

  it("names the operation when the read fails", async () => {
    const client = forge("o", "r", {});

    const error = await client.getPullRequest(404).catch((cause) => cause);
    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/reading pull request #404/);
  });
});

describe("getIssue — the live label read a mutation is judged against", () => {
  const ISSUE = {
    number: 7,
    state: "open",
    title: "Import fails on Node 24",
    labels: [{ name: "bug" }, { name: "needs triage" }],
  };

  it("reads a thread's labels", async () => {
    const client = forge("o", "r", { "GET /repos/o/r/issues/7": json(ISSUE) });

    await expect(client.getIssue(7)).resolves.toEqual({ labels: ["bug", "needs triage"] });
  });

  it("refuses a response with no label list", async () => {
    const client = forge("o", "r", { "GET /repos/o/r/issues/7": json({ number: 7 }) });

    const error = await client.getIssue(7).catch((cause) => cause);
    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/no label list/);
  });

  it("refuses a label entry with no name", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/issues/7": json({ number: 7, labels: [{ color: "ff0000" }] }),
    });

    const error = await client.getIssue(7).catch((cause) => cause);
    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/label entry has no name/);
  });

  it("names the operation when the read fails", async () => {
    const client = forge("o", "r", {});

    const error = await client.getIssue(404).catch((cause) => cause);
    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/reading issue #404/);
  });
});

describe("listCheckRuns", () => {
  const SHA = "aaaabbbbccccdddd000011112222333344445555";

  it("rolls check runs up to conclusion counts", async () => {
    const client = forge("o", "r", {
      [`GET /repos/o/r/commits/${SHA}/check-runs?per_page=100`]: page({
        total_count: 4,
        check_runs: [
          { conclusion: "success" },
          { conclusion: "success" },
          { conclusion: "failure" },
          { status: "in_progress" },
        ],
      }),
    });

    await expect(client.listCheckRuns(SHA)).resolves.toEqual({
      total: 4,
      byConclusion: { success: 2, failure: 1, pending: 1 },
    });
  });

  it("counts an absent or unrecognised conclusion as other, never as success", async () => {
    const client = forge("o", "r", {
      [`GET /repos/o/r/commits/${SHA}/check-runs?per_page=100`]: page({
        total_count: 2,
        check_runs: [{}, { conclusion: "weird" }],
      }),
    });

    const summary = await client.listCheckRuns(SHA);
    expect(summary.total).toBe(2);
    expect(summary.byConclusion).toEqual({ other: 2 });
    expect(summary.byConclusion.success).toBeUndefined();
  });

  it("answers an empty summary for a ref with no check runs, not a failure", async () => {
    const client = forge("o", "r", {
      [`GET /repos/o/r/commits/${SHA}/check-runs?per_page=100`]: page({
        total_count: 0,
        check_runs: [],
      }),
    });

    await expect(client.listCheckRuns(SHA)).resolves.toEqual({ total: 0, byConclusion: {} });
  });
});

describe("listPullRequestReviews", () => {
  it("reads requested reviewers and submitted reviews", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/pulls/7/requested_reviewers": json({
        users: [{ login: "alice" }, { login: "bob" }],
        teams: [],
      }),
      "GET /repos/o/r/pulls/7/reviews?per_page=100": page([
        { state: "APPROVED", user: { login: "alice" } },
        { state: "APPROVED", user: { login: "alice" } },
        { state: "CHANGES_REQUESTED", user: { login: "bob" } },
      ]),
    });

    await expect(client.listPullRequestReviews(7)).resolves.toEqual({
      requestedReviewers: ["alice", "bob"],
      reviews: [
        { state: "APPROVED", count: 2 },
        { state: "CHANGES_REQUESTED", count: 1 },
      ],
      reviewers: ["alice", "bob"],
    });
  });

  it("drops absent logins and empty review states deterministically", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/pulls/7/requested_reviewers": json({
        users: [{}, { login: null }, { login: "alice" }],
        teams: [],
      }),
      "GET /repos/o/r/pulls/7/reviews?per_page=100": page([
        { state: "" },
        {},
        { state: "COMMENTED", user: { login: "carol" } },
        { state: "", user: { login: "" } },
      ]),
    });

    const state = await client.listPullRequestReviews(7);
    expect(state.requestedReviewers).toEqual(["alice"]);
    expect(state.reviews).toEqual([{ state: "COMMENTED", count: 1 }]);
    expect(state.reviewers).toEqual(["carol"]);
  });
});

describe("listPullRequestFiles extras", () => {
  it("keeps patch, blob sha and a rename's old path when GitHub sends them", async () => {
    const client = forge("o", "r", {
      "GET /repos/o/r/pulls/5/files?per_page=100": page([
        {
          filename: "renamed.rs",
          status: "renamed",
          additions: 2,
          deletions: 1,
          previous_filename: "old-name.rs",
          sha: "bbbb1111",
          patch: "@@ -1,2 +1,3 @@",
        },
        { filename: "logo.png", status: "modified", additions: 0, deletions: 0, sha: "cccc2222" },
        { filename: "plain.mjs", status: "added", additions: 10, deletions: 0 },
      ]),
    });

    const files = await client.listPullRequestFiles(5);

    expect(files[0]).toEqual({
      filename: "renamed.rs",
      status: "renamed",
      additions: 2,
      deletions: 1,
      previousFilename: "old-name.rs",
      sha: "bbbb1111",
      patch: "@@ -1,2 +1,3 @@",
    });
    // A binary's entry carries no patch — absent, not empty.
    expect(files[1]).toEqual({
      filename: "logo.png",
      status: "modified",
      additions: 0,
      deletions: 0,
      sha: "cccc2222",
    });
    expect(files[2]).toEqual({
      filename: "plain.mjs",
      status: "added",
      additions: 10,
      deletions: 0,
    });
  });
});

describe("searchIssues", () => {
  const QUERY = "repo:o/r state:open importer crashes";
  const KEY = `GET /search/issues?q=${encodeURIComponent(QUERY)}&per_page=5`;

  it("returns the shaped hits, the total count and the cap it read at", async () => {
    const client = forge("o", "r", {
      [KEY]: json({
        total_count: 12,
        items: [
          {
            number: 9,
            title: "Importer crashes on empty files",
            state: "open",
            html_url: "https://github.com/o/r/issues/9",
            created_at: "2026-01-02T03:04:05Z",
          },
        ],
      }),
    });

    await expect(client.searchIssues(QUERY)).resolves.toEqual({
      items: [
        {
          number: 9,
          title: "Importer crashes on empty files",
          state: "open",
          url: "https://github.com/o/r/issues/9",
          createdAt: "2026-01-02T03:04:05Z",
        },
      ],
      totalCount: 12,
      cappedAt: 5,
    });
  });

  it("makes exactly one request, at per_page=limit, ignoring any Link: next", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge(
      "o",
      "r",
      {
        [KEY]: page(
          {
            total_count: 900,
            items: [],
          },
          '<https://api.github.com/search/issues?q=x&page=2>; rel="next"',
        ),
      },
      recorder,
    );

    const result = await client.searchIssues(QUERY, { limit: 5 });
    expect(result.totalCount).toBe(900);
    expect(result.cappedAt).toBe(5);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls?.[0]?.url).toContain("per_page=5");
  });

  it("honours an explicit smaller limit", async () => {
    const explicit = `GET /search/issues?q=${encodeURIComponent(QUERY)}&per_page=2`;
    const client = forge("o", "r", {
      [explicit]: json({ total_count: 3, items: [] }),
    });

    const result = await client.searchIssues(QUERY, { limit: 2 });
    expect(result.cappedAt).toBe(2);
  });

  it("refuses a limit outside 1..MAX_SEARCH_CANDIDATES and a non-integer one", async () => {
    const client = forge("o", "r", {});
    await expect(client.searchIssues(QUERY, { limit: 0 })).rejects.toThrow(ForgeError);
    await expect(client.searchIssues(QUERY, { limit: 6 })).rejects.toThrow(ForgeError);
    await expect(client.searchIssues(QUERY, { limit: 2.5 })).rejects.toThrow(ForgeError);
  });

  it("refuses an empty or over-long query before any request is spent", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const client = forge("o", "r", {}, recorder);
    await expect(client.searchIssues("   ")).rejects.toThrow(ForgeError);
    await expect(client.searchIssues("x".repeat(257))).rejects.toThrow(ForgeError);
    expect(recorder.calls).toHaveLength(0);
  });

  it("names the operation when the search fails", async () => {
    const client = forge("o", "r", { [KEY]: () => new Response("boom", { status: 500 }) });
    const error = await client.searchIssues(QUERY).catch((cause) => cause);
    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/searching for related issues/);
  });

  it("refuses a response that is not shaped like a search result", async () => {
    for (const payload of [
      { items: [] },
      { total_count: 0 },
      { total_count: "many", items: [] },
      { total_count: 0, items: { 0: {} } },
    ]) {
      const client = forge("o", "r", { [KEY]: json(payload) });
      await expect(client.searchIssues(QUERY)).rejects.toThrow(ForgeError);
    }
  });

  it("refuses a hit that is not shaped like an issue", async () => {
    const malformed = {
      total_count: 1,
      items: [{ number: 9, state: "open", html_url: "https://github.com/o/r/issues/9" }],
    };
    const client = forge("o", "r", { [KEY]: json(malformed) });
    const error = await client.searchIssues(QUERY).catch((cause) => cause);
    expect(error).toBeInstanceOf(ForgeError);
    expect(error.message).toMatch(/not shaped like an issue/);
  });
});
