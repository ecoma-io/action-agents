// Tests for the GitHub protocol layer.
//
// Two things are pinned beyond plumbing: the operation list is the surface
// (every URL here is one a documented action needs, and nothing else), and
// the failure shapes are distinguished — absent is `null` for a config file,
// unmeasurable is `PastFileCeilingError` for a monster pull request, and
// everything else is a `ForgeError` naming the operation that failed.

import { describe, expect, it } from "vitest";

import {
  ForgeError,
  PastFileCeilingError,
  TruncatedTreeError,
  MAX_PULL_REQUEST_FILES,
  createForge,
  nextLink,
} from "./forge.mjs";

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
  it("returns the GITHUB_ACTOR environment variable value", async () => {
    const actor = "action-agents[bot]";
    const client = createForge({
      owner: "o",
      repo: "r",
      token: "ghs_x",
      fetchImpl: routed({}),
      getActor: () => actor,
      ...FAST,
    });
    await expect(client.whoami()).resolves.toEqual({ login: actor });
  });

  it("uses default GITHUB_ACTOR when getActor is not provided", async () => {
    const originalActor = process.env.GITHUB_ACTOR;
    process.env.GITHUB_ACTOR = "github-actions[bot]";
    try {
      const client = forge("o", "r", {});
      await expect(client.whoami()).resolves.toEqual({ login: "github-actions[bot]" });
    } finally {
      process.env.GITHUB_ACTOR = originalActor;
    }
  });

  it("refuses an empty actor", async () => {
    const client = createForge({
      owner: "o",
      repo: "r",
      token: "ghs_x",
      fetchImpl: routed({}),
      getActor: () => "",
      ...FAST,
    });
    await expect(client.whoami()).rejects.toThrow(ForgeError);
  });

  it("falls back to default when GITHUB_ACTOR is not set", async () => {
    const originalActor = process.env.GITHUB_ACTOR;
    delete process.env.GITHUB_ACTOR;
    try {
      const client = forge("o", "r", {});
      await expect(client.whoami()).resolves.toEqual({ login: "github-actions[bot]" });
    } finally {
      process.env.GITHUB_ACTOR = originalActor;
    }
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
      { "GET /repos/o/r/contents/.github/action-agents/triage/triage.json5": json(PAYLOAD) },
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
      "GET /repos/o/r": json({ default_branch: "main" }),
    });

    await expect(client.getRepository()).resolves.toEqual({ defaultBranch: "main" });
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
