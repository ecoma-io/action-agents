/**
 * The GitHub calls these actions make, as an explicit list rather than a
 * general client.
 *
 * Every operation here exists because a documented action needs it, and the
 * list is the surface: reading a thread's comments, reading a default-branch
 * file, labels on and labels off, the files of a pull request. Nothing here
 * closes a thread, assigns anyone, merges, pushes or writes a permission —
 * not because the REST API refuses, but because this module is where the
 * boundary is visible, and an operation that is not listed does not exist
 * for an action to reach for.
 *
 * All reads go through the API rather than the working tree, which is what
 * keeps "the default branch, not the working tree" a property of the read
 * itself: `getContents` with no ref reads the repository's default branch,
 * so a pull request cannot edit the policy that governs it.
 *
 * The files listing carries the 3 000-file ceiling GitHub puts on it. A pull
 * request at or past that ceiling cannot be measured — the listing stops at
 * 3 000 entries and says nothing about what lies beyond — so it is refused
 * rather than guessed at, as `triage`'s design page requires.
 */

import { createHttpClient, HttpError } from "./http.mjs";

/**
 * @typedef {object} ForgeConfig
 * @property {string} owner
 * @property {string} repo
 * @property {string} token
 * @property {string} [apiUrl] the runner's `GITHUB_API_URL`, for Enterprise
 * @property {typeof globalThis.fetch} [fetchImpl]
 * @property {number} [timeoutMs]
 * @property {number} [maxAttempts]
 * @property {number} [retryDelayMs]
 * @property {() => string} [getActor] Function to get the current actor (default: reads GITHUB_ACTOR env var)
 */

/**
 * @typedef {object} CommentEntry
 * @property {number} id
 * @property {string} body
 * @property {{ login: string } | null} user null when the author account is gone
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {object} PullRequestFile
 * @property {string} filename
 * @property {string} status added, removed, modified, renamed, …
 * @property {number} additions zero for binary, submodule and pure-rename entries
 * @property {number} deletions zero for the same entries
 */

/** The listing's own ceiling; a pull request at or past it is unmeasurable. */
export const MAX_PULL_REQUEST_FILES = 3000;

/** A pull request whose files listing sits at GitHub's own ceiling. */
export class PastFileCeilingError extends Error {
  /**
   * @param {number} number
   * @param {number} collected
   */
  constructor(number, collected) {
    super(
      `pull request #${String(number)} has ${String(collected)} changed files, at the ` +
        `listing's ${String(MAX_PULL_REQUEST_FILES)}-file ceiling — it cannot be measured, ` +
        `and is refused rather than guessed at`,
    );
    this.name = "PastFileCeilingError";
  }
}

/**
 * The most one recursive tree response may carry. GitHub's own ceiling on the
 * endpoint sits below this — its answers are cut and flagged `truncated`
 * before they grow this large — so hitting this cap means the answer was not
 * readable, which is refused like any other unreadable answer.
 */
export const MAX_TREE_RESPONSE_BYTES = 16 * 2 ** 20;

/**
 * A recursive tree listing came back flagged `truncated`: the entries beyond
 * GitHub's ceiling are absent, and an inventory built from it would look
 * complete while knowing less than the repository holds. Refused — never
 * processed as if it were the whole tree.
 */
export class TruncatedTreeError extends Error {
  /** @param {string} ref @param {number} collected */
  constructor(ref, collected) {
    super(
      `the tree of '${ref}' lists ${String(collected)} entries and is truncated at ` +
        `GitHub's ceiling — an inventory from it would be incomplete, so the run is ` +
        `refused rather than guessed`,
    );
    this.name = "TruncatedTreeError";
  }
}

/**
 * @typedef {object} TreeEntry
 * @property {string} path
 * @property {string} type `blob` (a file), `tree` (a directory), or `commit` (a submodule)
 */

/** A GitHub call failed, naming the operation that failed. */
export class ForgeError extends Error {
  /** @param {string} operation @param {Error} cause */
  constructor(operation, cause) {
    super(`${operation} failed: ${cause.message}`);
    this.name = "ForgeError";
    this.cause = cause;
  }
}

const PER_PAGE = 100;

/**
 * The client `createForge` returns, named so an action's JSDoc can say
 * `import("#core/forge.mjs").Forge` instead of restating the shape.
 *
 * @typedef {ReturnType<typeof createForge>} Forge
 */

/**
 * @param {ForgeConfig} config
 * @returns {{
 *   whoami: () => Promise<{ login: string }>,
 *   getRepository: () => Promise<{ defaultBranch: string }>,
 *   getRef: (branch: string) => Promise<{ sha: string }>,
 *   listTree: (sha: string) => Promise<TreeEntry[]>,
 *   getContents: (path: string) => Promise<{ content: string } | null>,
 *   listRepositoryLabels: () => Promise<string[]>,
 *   listPullRequestFiles: (number: number) => Promise<PullRequestFile[]>,
 *   addLabels: (number: number, names: string[]) => Promise<void>,
 *   removeLabel: (number: number, name: string) => Promise<void>,
 *   listComments: (number: number) => Promise<CommentEntry[]>,
 *   createComment: (number: number, body: string) => Promise<{ id: number }>,
 *   updateComment: (id: number, body: string) => Promise<void>,
 *   deleteComment: (id: number) => Promise<void>,
 * }}
 */
export function createForge(config) {
  const http = createHttpClient({
    baseUrl: config.apiUrl ?? "https://api.github.com",
    authorization: `Bearer ${config.token}`,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    // The contents API returns up to 1 MiB of file, base64-inflated by a
    // third inside its JSON envelope — 2 MiB covers it and still caps.
    maxBodyBytes: 2 * 2 ** 20,
    fetchImpl: config.fetchImpl,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    retryDelayMs: config.retryDelayMs,
  });
  const root = `/repos/${config.owner}/${config.repo}`;

  return {
    /** The login the token writes as — the marker upsert finds its own comments by it. */
    async whoami() {
      // Use GITHUB_ACTOR environment variable instead of calling /user API
      // This avoids permission issues with pull_request events from forks
      const getActor = config.getActor ?? (() => process.env.GITHUB_ACTOR ?? "github-actions[bot]");
      const login = getActor();
      if (typeof login !== "string" || login === "") {
        throw new ForgeError(
          "reading the token's identity",
          new Error("GITHUB_ACTOR is not set or empty"),
        );
      }
      return { login };
    },

    /** The repository's own facts — the default branch name is what a run reads first. */
    async getRepository() {
      const operation = "reading the repository";
      const json = await call(operation, () => http.request(root));
      const defaultBranch = asRecord(json)?.["default_branch"];
      if (typeof defaultBranch !== "string" || defaultBranch === "") {
        throw new ForgeError(operation, new Error("the response names no default branch"));
      }
      return { defaultBranch };
    },

    /**
     * A branch's current commit SHA — the tip a tree listing or a new commit
     * builds on.
     *
     * @param {string} branch
     */
    async getRef(branch) {
      const operation = `reading the ref of branch '${branch}'`;
      const json = await call(operation, () =>
        http.request(`${root}/git/ref/heads/${encodeURIComponent(branch)}`),
      );
      const object = asRecord(asRecord(json)?.["object"]);
      const sha = object?.["sha"];
      if (typeof sha !== "string" || sha === "") {
        throw new ForgeError(operation, new Error("the response carries no commit sha"));
      }
      return { sha };
    },

    /**
     * Every entry of one tree, recursively — the whole default-branch file
     * list in one call. The endpoint answers in a single response and flags
     * overflow itself: a `truncated` answer is refused rather than processed,
     * because an inventory that looks complete while entries are missing is
     * the one failure mode worse than an error. `Link` pagination is followed
     * when the host offers it, for forges whose answers do come in pages.
     *
     * @param {string} sha commit or tree SHA to list
     */
    async listTree(sha) {
      const operation = `listing the tree of ${sha}`;
      if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
        throw new ForgeError(operation, new Error("a tree is listed by its sha"));
      }
      /** @type {unknown[]} */
      const pages = [];
      let url = `${root}/git/trees/${encodeURIComponent(sha)}?recursive=1`;
      for (;;) {
        let response;
        try {
          response = await http.request(url, { maxBodyBytes: MAX_TREE_RESPONSE_BYTES });
        } catch (cause) {
          throw new ForgeError(
            operation,
            cause instanceof Error ? cause : new Error(String(cause)),
          );
        }
        pages.push(parse(operation, response.text));
        const next = nextLink(response.headers["link"] ?? "");
        if (next === null) break;
        url = next;
      }

      /** @type {TreeEntry[]} */
      const entries = [];
      for (const page of pages) {
        const record = asRecord(page);
        if (record === null) {
          throw new ForgeError(operation, new Error("the response is not a tree object"));
        }
        const rawEntries = record["tree"];
        if (!Array.isArray(rawEntries)) {
          throw new ForgeError(operation, new Error("the response carries no tree array"));
        }
        if (record["truncated"] === true) {
          throw new TruncatedTreeError(sha, entries.length + rawEntries.length);
        }
        for (const raw of rawEntries) {
          const entry = asRecord(raw);
          const path = entry?.["path"];
          const type = entry?.["type"];
          if (typeof path !== "string" || typeof type !== "string") {
            throw new ForgeError(operation, new Error("a tree entry has no path or type"));
          }
          entries.push({ path, type });
        }
      }
      return entries;
    },

    /**
     * Reads one file from the repository's **default branch** — no ref, so no
     * pull request can edit the policy that governs it. Absent is `null`, not
     * an error: a missing config file is policy-empty.
     *
     * @param {string} path
     */
    async getContents(path) {
      const operation = `reading '${path}' from the default branch`;
      let response;
      try {
        response = await http.request(`${root}/contents/${path}`);
      } catch (cause) {
        if (cause instanceof HttpError && cause.status === 404) return null;
        throw new ForgeError(operation, cause instanceof Error ? cause : new Error(String(cause)));
      }
      const entry = asRecord(parse(operation, response.text));
      const encoding = entry?.["encoding"];
      const content = entry?.["content"];
      if (encoding !== "base64" || typeof content !== "string") {
        throw new ForgeError(operation, new Error(`'${path}' is not a readable file`));
      }
      return { content: decodeBase64(content) };
    },

    /** Every label the repository declares — the set a sheet's names must exist in. */
    async listRepositoryLabels() {
      const pages = await paginate(`listing the repository's labels`, `${root}/labels`);
      /** @type {string[]} */
      const names = [];
      for (const page of pages) {
        if (!Array.isArray(page)) continue;
        for (const label of page) {
          const name = asRecord(label)?.["name"];
          if (typeof name === "string") names.push(name);
        }
      }
      return names;
    },

    /**
     * The pull request's files with per-file counts. Renamed, binary and
     * submodule entries arrive with zero counts by GitHub's own accounting of
     * them, and a pull request at the listing's ceiling is refused.
     *
     * @param {number} number
     */
    async listPullRequestFiles(number) {
      const operation = `listing the files of pull request #${String(number)}`;
      const pages = await paginate(operation, `${root}/pulls/${String(number)}/files`);
      /** @type {PullRequestFile[]} */
      const files = [];
      for (const page of pages) {
        if (!Array.isArray(page)) continue;
        for (const raw of page) {
          const entry = asRecord(raw);
          const filename = entry?.["filename"];
          const status = entry?.["status"];
          const additions = entry?.["additions"];
          const deletions = entry?.["deletions"];
          if (
            typeof filename !== "string" ||
            typeof status !== "string" ||
            typeof additions !== "number" ||
            typeof deletions !== "number"
          ) {
            throw new ForgeError(operation, new Error("a file entry has no counts"));
          }
          files.push({ filename, status, additions, deletions });
        }
      }
      if (files.length >= MAX_PULL_REQUEST_FILES) {
        throw new PastFileCeilingError(number, files.length);
      }
      return files;
    },

    /**
     * Adds labels to a thread. GitHub's endpoint adds rather than replaces,
     * which is the add-only semantics `triage`'s sheet half is built on.
     *
     * @param {number} number
     * @param {string[]} names
     */
    async addLabels(number, names) {
      await call(`adding labels to #${String(number)}`, () =>
        http.request(`${root}/issues/${String(number)}/labels`, {
          method: "POST",
          body: { labels: names },
        }),
      );
    },

    /**
     * Removes one label from a thread — `triage`'s size half, where one size
     * label is meaningful at a time.
     *
     * @param {number} number
     * @param {string} name
     */
    async removeLabel(number, name) {
      await call(`removing '${name}' from #${String(number)}`, () =>
        http.request(`${root}/issues/${String(number)}/labels/${encodeURIComponent(name)}`, {
          method: "DELETE",
        }),
      );
    },

    /**
     * A thread's comments, oldest first — the marker upsert's search space.
     * Works for pull requests too: a pull request's number is its issue's
     * number, and this is the issue-comments listing.
     *
     * @param {number} number
     */
    async listComments(number) {
      const pages = await paginate(
        `listing the comments on #${String(number)}`,
        `${root}/issues/${String(number)}/comments`,
      );
      /** @type {CommentEntry[]} */
      const comments = [];
      for (const page of pages) {
        if (!Array.isArray(page)) continue;
        for (const raw of page) {
          const entry = asRecord(raw);
          const id = entry?.["id"];
          const body = entry?.["body"];
          const user = asRecord(entry?.["user"]);
          const login = user?.["login"];
          const createdAt = entry?.["created_at"];
          const updatedAt = entry?.["updated_at"];
          if (
            typeof id !== "number" ||
            typeof body !== "string" ||
            typeof createdAt !== "string" ||
            typeof updatedAt !== "string"
          ) {
            throw new ForgeError(
              `listing the comments on #${String(number)}`,
              new Error("a comment entry is not shaped like a comment"),
            );
          }
          comments.push({
            id,
            body,
            user: typeof login === "string" ? { login } : null,
            created_at: createdAt,
            updated_at: updatedAt,
          });
        }
      }
      return comments;
    },

    /**
     * Creating a comment is the one write that is not idempotent, so it makes
     * a single attempt: a 503 that landed the comment anyway must not be
     * retried into a second copy. The upsert tolerates duplicates from
     * elsewhere; it should not be a source of them.
     *
     * @param {number} number
     * @param {string} body
     */
    async createComment(number, body) {
      const json = await call(`commenting on #${String(number)}`, () =>
        http.request(`${root}/issues/${String(number)}/comments`, {
          method: "POST",
          body: { body },
          maxAttempts: 1,
        }),
      );
      const id = asRecord(json)?.["id"];
      if (typeof id !== "number") {
        throw new ForgeError(
          `commenting on #${String(number)}`,
          new Error("the response has no comment id"),
        );
      }
      return { id };
    },

    /**
     * @param {number} id
     * @param {string} body
     */
    async updateComment(id, body) {
      await call(`updating comment ${String(id)}`, () =>
        http.request(`${root}/issues/comments/${String(id)}`, {
          method: "PATCH",
          body: { body },
        }),
      );
    },

    /**
     * @param {number} id
     */
    async deleteComment(id) {
      await call(`deleting comment ${String(id)}`, () =>
        http.request(`${root}/issues/comments/${String(id)}`, { method: "DELETE" }),
      );
    },
  };

  /**
   * One request whose body is JSON, with the operation named in the failure.
   *
   * @template T
   * @param {string} operation
   * @param {() => Promise<import("./http.mjs").HttpResponse>} run
   * @returns {Promise<T>}
   */
  async function call(operation, run) {
    let response;
    try {
      response = await run();
    } catch (cause) {
      throw new ForgeError(operation, cause instanceof Error ? cause : new Error(String(cause)));
    }
    if (response.text === "") return /** @type {T} */ (undefined);
    return /** @type {T} */ (parse(operation, response.text));
  }

  /**
   * Walks the `Link` header's `rel="next"` until it ends.
   *
   * @param {string} operation
   * @param {string} first
   * @returns {Promise<unknown[]>}
   */
  async function paginate(operation, first) {
    /** @type {unknown[]} */
    const pages = [];
    let url = `${first}?per_page=${String(PER_PAGE)}`;
    for (;;) {
      let response;
      try {
        response = await http.request(url);
      } catch (cause) {
        throw new ForgeError(operation, cause instanceof Error ? cause : new Error(String(cause)));
      }
      pages.push(parse(operation, response.text));
      const next = nextLink(response.headers["link"] ?? "");
      if (next === null) return pages;
      url = next;
    }
  }
}

/**
 * `<url>; rel="next"` from a Link header, or null when there is no next page.
 *
 * @param {string} link
 * @returns {string | null}
 */
export function nextLink(link) {
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/**
 * @param {string} operation
 * @param {string} text
 * @returns {unknown}
 */
function parse(operation, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ForgeError(operation, new Error("the response body is not JSON"));
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * The contents API's `content` is base64 with the newlines GitHub inserts —
 * `atob` tolerates them in Node, but stripping first is cheaper than hoping.
 *
 * @param {string} encoded
 * @returns {string}
 */
function decodeBase64(encoded) {
  return Buffer.from(encoded.replace(/\n/g, ""), "base64").toString("utf8");
}
