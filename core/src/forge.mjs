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

import { createHttpClient } from "#core-transport/http.mjs";

import { HttpError } from "./transport-errors.mjs";

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
 * @property {string} [previousFilename] a rename's old path, when the entry is a rename
 * @property {string} [patch] the file's unified diff, when GitHub supplies one — absent for binaries, submodule bumps and diffs past GitHub's own size ceiling
 * @property {string} [sha] the blob SHA of the file at the pull request's head commit
 */

/**
 * What one `GET /pulls/{number}` read fixes about a pull request: its state,
 * its two commits, and the prose a human wrote about it. A snapshot policy —
 * what pins a run to these values, and when they are re-read — lives above
 * this module, in the action that reads twice around its own work.
 *
 * @typedef {object} PullRequestSnapshot
 * @property {number} number
 * @property {string} state "open", "closed", or whatever the forge answers
 * @property {boolean} draft
 * @property {boolean} merged
 * @property {string} title an absent title is normalised to ""
 * @property {string} body an absent description is normalised to ""
 * @property {{ ref: string, sha: string }} head
 * @property {{ ref: string, sha: string }} base
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
 * The branch a run was building on moved between its first read and its ref
 * update — another writer mutated it mid-run. Refused loudly: overwriting a
 * concurrent change silently is exactly the failure optimistic locking
 * exists to prevent. The next run starts from a fresh HEAD anyway.
 */
export class BranchMovedError extends Error {
  /** @param {string} branch @param {string} expected @param {string} found */
  constructor(branch, expected, found) {
    super(
      `branch '${branch}' moved while the run worked — it read ${expected.slice(0, 12)} and ` +
        `found ${found.slice(0, 12)} at update time. Nothing was merged or lost; re-run to ` +
        `build on the current HEAD`,
    );
    this.name = "BranchMovedError";
  }
}

/**
 * @typedef {object} TreeEntry
 * @property {string} path
 * @property {string} type `blob` (a file), `tree` (a directory), or `commit` (a submodule)
 */

/**
 * One file entry handed to {@linkcode createTree}: a path this run already
 * turned into a blob.
 * @typedef {object} TreeChange
 * @property {string} path
 * @property {string} blobSha
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

/**
 * Whether a forge failure is the ref endpoint's "not found" answer — the one
 * failure a caller may read as "the branch is absent". Matched by the typed
 * HTTP status, never by error-message text: the message is prose assembled
 * from operation names, branch names and provider body text, so a branch or
 * refusal whose text embeds "HTTP 404" must not read as absent.
 *
 * @param {unknown} cause anything a rejected forge call may throw
 * @returns {boolean}
 */
export function isRefAbsentError(cause) {
  return (
    cause instanceof ForgeError && cause.cause instanceof HttpError && cause.cause.status === 404
  );
}

/** The most pages one listing follows before refusing: a hostile or broken
 * `Link` header cannot walk the client forever, and every listing the
 * actions read is a bounded surface. 100 pages at the 100-entry page size
 * is 10 000 entries — far past any thread or tree these actions answer. */
export const MAX_PAGES_PER_LISTING = 100;

/**
 * Refuses a listing that still offers a next page at the page cap — a
 * self-looping or endless `Link` header, read as the broken answer it is.
 *
 * @param {string} operation the listing's name, for the refusal text
 * @param {number} hops pages already fetched
 */
function assertPagesBounded(operation, hops) {
  if (hops >= MAX_PAGES_PER_LISTING) {
    throw new ForgeError(
      operation,
      new Error(
        `the listing still offers a next page after ${String(MAX_PAGES_PER_LISTING)} pages — ` +
          `refusing to keep following pages`,
      ),
    );
  }
}

/**
 * Whether a forge failure is GitHub's 404 — read as "already absent" by the
 * label removal, and matched by the typed HTTP status, never by error text.
 *
 * @param {unknown} cause anything a rejected forge call may throw
 * @returns {boolean}
 */
function isNotFound(cause) {
  return (
    cause instanceof ForgeError && cause.cause instanceof HttpError && cause.cause.status === 404
  );
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
 *   getRepository: () => Promise<{ defaultBranch: string, name: string, description: string }>,
 *   getRef: (branch: string) => Promise<{ sha: string }>,
 *   readRef: (branch: string) => Promise<{ sha: string } | null>,
 *   listTree: (sha: string) => Promise<TreeEntry[]>,
 *   getContents: (path: string, options?: { ref?: string }) => Promise<{ content: string } | null>,
 *   listRepositoryLabels: () => Promise<string[]>,
 *   getPullRequest: (number: number) => Promise<PullRequestSnapshot>,
 *   listPullRequestFiles: (number: number) => Promise<PullRequestFile[]>,
 *   addLabels: (number: number, names: string[]) => Promise<void>,
 *   removeLabel: (number: number, name: string) => Promise<void>,
 *   listComments: (number: number) => Promise<CommentEntry[]>,
 *   createComment: (number: number, body: string) => Promise<{ id: number }>,
 *   updateComment: (id: number, body: string) => Promise<void>,
 *   deleteComment: (id: number) => Promise<void>,
 *   createBlob: (content: string) => Promise<{ sha: string }>,
 *   createTree: (baseTreeSha: string, changes: TreeChange[]) => Promise<{ sha: string }>,
 *   createCommit: (message: string, treeSha: string, parentCommitSha: string) => Promise<{ sha: string }>,
 *   upsertBranch: (branch: string, commitSha: string, expectedCurrentSha: string | null) => Promise<void>,
 *   upsertPullRequest: (input: { base: string, head: string, title: string, body: string }) => Promise<{ number: number, created: boolean }>,
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
    /**
     * The login the token writes as — the marker upsert finds its own
     * comments by it. `GET /user` answers with the token's authenticated
     * principal: `github-actions[bot]` under the workflow's GITHUB_TOKEN,
     * the app's bot login under an App installation token, the user under a
     * PAT — the same identity that authors whatever the token writes.
     */
    async whoami() {
      const operation = "reading the token's identity";
      const record = asRecord(await call(operation, () => http.request("/user")));
      const login = record?.["login"];
      if (typeof login !== "string" || login === "") {
        throw new ForgeError(operation, new Error("the response names no login"));
      }
      return { login };
    },

    /** The repository's own facts — the default branch name is what a run reads first. */
    async getRepository() {
      const operation = "reading the repository";
      const json = await call(operation, () => http.request(root));
      const record = asRecord(json);
      const defaultBranch = record?.["default_branch"];
      if (typeof defaultBranch !== "string" || defaultBranch === "") {
        throw new ForgeError(operation, new Error("the response names no default branch"));
      }
      // Name and description feed prompts; absent description is normal.
      const name = typeof record?.["name"] === "string" ? record["name"] : "";
      const description = typeof record?.["description"] === "string" ? record["description"] : "";
      return { defaultBranch, name, description };
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
     * A branch's current commit SHA, or `null` when the branch does not
     * exist. Absence is the typed 404 status — never message text — so a
     * branch named `HTTP 404`, or a provider body quoting it, cannot read
     * as absent; every other failure propagates unchanged. Callers that
     * must distinguish absence from failure read through here instead of
     * re-deriving the check.
     *
     * @param {string} branch
     * @returns {Promise<{ sha: string } | null>}
     */
    async readRef(branch) {
      return this.getRef(branch).catch((cause) => {
        if (isRefAbsentError(cause)) return null;
        throw cause;
      });
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
      let hops = 0;
      for (;;) {
        assertPagesBounded(operation, hops);
        hops += 1;
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
     * pull request can edit the policy that governs it. A `ref` pins the read
     * to one exact commit instead: harmonise anchors every document read to
     * the tip its inventory was built from, so one run describes one instant.
     * Absent is `null`, not an error.
     *
     * @param {string} path
     * @param {{ ref?: string }} [options]
     */
    async getContents(path, options = {}) {
      const where = options.ref === undefined ? "the default branch" : `'${options.ref}'`;
      const operation = `reading '${path}' from ${where}`;
      const suffix = options.ref === undefined ? "" : `?ref=${encodeURIComponent(options.ref)}`;
      let response;
      try {
        response = await http.request(`${root}/contents/${encodeURIComponent(path)}${suffix}`);
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
     * The pull request itself, read in one call: state, draft and merged
     * flags, title, body, and both commits. This is the read a snapshot is
     * built from and the read repeated immediately before publication — the
     * pair of reads that makes reviewing commit A while the thread sits at
     * commit B unreachable in practice.
     *
     * @param {number} number
     */
    async getPullRequest(number) {
      const operation = `reading pull request #${String(number)}`;
      const json = await call(operation, () => http.request(`${root}/pulls/${String(number)}`));
      const record = asRecord(json);
      const head = asRecord(record?.["head"]);
      const base = asRecord(record?.["base"]);
      const state = record?.["state"];
      const draft = record?.["draft"];
      const merged = record?.["merged"];
      const title = record?.["title"];
      const headRef = head?.["ref"];
      const headSha = head?.["sha"];
      const baseRef = base?.["ref"];
      const baseSha = base?.["sha"];
      if (
        typeof state !== "string" ||
        typeof draft !== "boolean" ||
        typeof merged !== "boolean" ||
        typeof title !== "string" ||
        typeof headRef !== "string" ||
        typeof headSha !== "string" ||
        !/^[0-9a-f]{7,40}$/i.test(headSha) ||
        typeof baseRef !== "string" ||
        typeof baseSha !== "string" ||
        !/^[0-9a-f]{7,40}$/i.test(baseSha)
      ) {
        throw new ForgeError(
          operation,
          new Error("the response is not shaped like a pull request"),
        );
      }
      // An absent description is a normal pull request, not a broken answer.
      const body = typeof record?.["body"] === "string" ? record["body"] : "";
      return {
        number,
        state,
        draft,
        merged,
        title,
        body,
        head: { ref: headRef, sha: headSha },
        base: { ref: baseRef, sha: baseSha },
      };
    },

    /**
     * The pull request's files with per-file counts. Renamed, binary and
     * submodule entries arrive with zero counts by GitHub's own accounting of
     * them, and a pull request at the listing's ceiling is refused. When an
     * entry carries GitHub's optional extras — a rename's old path, the file's
     * diff, its blob SHA at the head — they are kept: a reviewer needs the
     * diff to show the model and the SHA to know what it is looking at.
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
          const previousFilename = entry?.["previous_filename"];
          const patch = entry?.["patch"];
          const sha = entry?.["sha"];
          files.push({
            filename,
            status,
            additions,
            deletions,
            ...(typeof previousFilename === "string" ? { previousFilename } : {}),
            ...(typeof patch === "string" ? { patch } : {}),
            ...(typeof sha === "string" ? { sha } : {}),
          });
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
      // The removal lands even when the response is lost; replaying a
      // timed-out delete would 404 on the now-absent label and fail the run.
      // A 404 is the end state already reached: a replayed event or a
      // concurrent run can remove the label between the run's snapshot and
      // this call, and GitHub answers that with 404. The thread existing is
      // never in doubt here — every removal in these actions is preceded by
      // an addLabels call on the same thread that would have failed first —
      // so a 404 can only mean the label is already gone.
      try {
        await call(`removing '${name}' from #${String(number)}`, () =>
          http.request(`${root}/issues/${String(number)}/labels/${encodeURIComponent(name)}`, {
            method: "DELETE",
            maxAttempts: 1,
          }),
        );
      } catch (cause) {
        if (isNotFound(cause)) return;
        throw cause;
      }
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
      // Same single attempt as label removal: a replayed timed-out delete
      // would 404 on the comment it already removed.
      await call(`deleting comment ${String(id)}`, () =>
        http.request(`${root}/issues/comments/${String(id)}`, {
          method: "DELETE",
          maxAttempts: 1,
        }),
      );
    },

    /** One file's content, stored — the first step of every commit this action builds. */
    async createBlob(content) {
      const operation = "creating a blob";
      const json = await call(operation, () =>
        http.request(`${root}/git/blobs`, {
          method: "POST",
          body: { content, encoding: "utf-8" },
        }),
      );
      const sha = asRecord(json)?.["sha"];
      if (typeof sha !== "string" || sha === "") {
        throw new ForgeError(operation, new Error("the response carries no blob sha"));
      }
      return { sha };
    },

    /**
     * One tree layered over a base: only the changed paths are named, and
     * everything else is inherited from the base tree verbatim. This is what
     * keeps a harmonise branch free of stale files — the tree is the base's,
     * plus exactly this run's files.
     *
     * @param {string} baseTreeSha the commit (or tree) SHA the changes sit on
     * @param {TreeChange[]} changes path → blob pairs, all of one run's proposals
     */
    async createTree(baseTreeSha, changes) {
      const operation = "creating a tree";
      const json = await call(operation, () =>
        http.request(`${root}/git/trees`, {
          method: "POST",
          body: {
            base_tree: baseTreeSha,
            tree: changes.map((change) => ({
              path: change.path,
              mode: "100644",
              type: "blob",
              sha: change.blobSha,
            })),
          },
        }),
      );
      const sha = asRecord(json)?.["sha"];
      if (typeof sha !== "string" || sha === "") {
        throw new ForgeError(operation, new Error("the response carries no tree sha"));
      }
      return { sha };
    },

    /**
     * One commit on top of one parent, holding one whole tree.
     *
     * @param {string} message
     * @param {string} treeSha
     * @param {string} parentCommitSha
     */
    async createCommit(message, treeSha, parentCommitSha) {
      const operation = "creating a commit";
      const json = await call(operation, () =>
        http.request(`${root}/git/commits`, {
          method: "POST",
          body: { message, tree: treeSha, parents: [parentCommitSha] },
        }),
      );
      const sha = asRecord(json)?.["sha"];
      if (typeof sha !== "string" || sha === "") {
        throw new ForgeError(operation, new Error("the response carries no commit sha"));
      }
      return { sha };
    },

    /**
     * Points the run's own branch at the freshly built commit — creating it
     * when absent, force-updating it when present. The optimistic lock is the
     * caller's `expectedCurrentSha`: the tip the run read when it started. A
     * branch found elsewhere moved under the run, which is refused rather
     * than overwritten. The ref API has no compare-and-swap, so the expected
     * tip cannot ride on the PATCH itself: the update path re-reads the tip
     * immediately before the force-write, leaving a window one round trip
     * wide in which another writer's move could still slip through — and a
     * tip caught moving in it is refused all the same.
     *
     * @param {string} branch the action's own branch; every documented caller names exactly `harmonise/<language>`
     * @param {string} commitSha
     * @param {string | null} expectedCurrentSha null when creating fresh (the ref read as absent moments ago)
     */
    async upsertBranch(branch, commitSha, expectedCurrentSha) {
      // One read decides create vs update; a ref that appeared or moved under
      // the run is another writer's move and is refused, never overwritten.
      const current = await this.readRef(branch);

      const found = current === null ? "(absent)" : current.sha;
      const expected = expectedCurrentSha ?? "(absent)";
      if (found !== expected) {
        throw new BranchMovedError(branch, expected, found);
      }

      if (current === null) {
        // Creating a ref is not idempotent; one attempt, like PR creation.
        await call(`creating the branch '${branch}'`, () =>
          http.request(`${root}/git/refs`, {
            method: "POST",
            maxAttempts: 1,
            body: { ref: `refs/heads/${branch}`, sha: commitSha },
          }),
        );
        return;
      }

      // The PATCH is a force-write and the ref API has no compare-and-swap,
      // so the expected tip cannot ride on the request itself. Re-reading
      // the tip immediately before the write shrinks the window in which
      // another writer's move goes unnoticed to one round trip, and a tip
      // caught moving is refused here rather than force-overwritten.
      const reread = await this.getRef(branch);
      if (reread.sha !== expectedCurrentSha) {
        throw new BranchMovedError(branch, expected, reread.sha);
      }

      await call(`updating the branch '${branch}'`, () =>
        http.request(`${root}/git/refs/heads/${encodeURIComponent(branch)}`, {
          method: "PATCH",
          body: { sha: commitSha, force: true },
        }),
      );
    },

    /**
     * The pull request for one base/head pair, created once and updated in
     * place forever after — never searched by title, never duplicated. A
     * closed or merged twin does not block a fresh one: history stays
     * history, and the open channel is what gets maintained.
     *
     * @param {object} input
     * @param {string} input.base
     * @param {string} input.head the branch name in THIS repository
     * @param {string} input.title
     * @param {string} input.body
     * @returns {Promise<{ number: number, created: boolean }>}
     */
    async upsertPullRequest({ base, head, title, body }) {
      const searchOperation = "searching for the run's pull request";
      const pages = await paginate(
        searchOperation,
        `${root}/pulls?base=${encodeURIComponent(base)}&head=` +
          `${encodeURIComponent(`${config.owner}:${head}`)}&state=all`,
      );
      /** @type {{ number: number } | undefined} */
      let existing;
      for (const page of pages) {
        if (!Array.isArray(page)) continue;
        for (const raw of page) {
          const entry = asRecord(raw);
          const number = entry?.["number"];
          const state = entry?.["state"];
          if (typeof number === "number" && state === "open") existing = { number };
        }
      }

      if (existing === undefined) {
        // Creating is not idempotent — a retried 503 would open two pull
        // requests — so it makes a single attempt, like comment creation.
        const created = await call("opening the run's pull request", () =>
          http.request(`${root}/pulls`, {
            method: "POST",
            maxAttempts: 1,
            body: { title, head, base, body },
          }),
        );
        const number = asRecord(created)?.["number"];
        if (typeof number !== "number") {
          throw new ForgeError(
            "opening the run's pull request",
            new Error("the response carries no pull request number"),
          );
        }
        return { number, created: true };
      }

      await call(`updating pull request #${String(existing.number)}`, () =>
        http.request(`${root}/pulls/${String(existing.number)}`, {
          method: "PATCH",
          body: { title, body, state: "open" },
        }),
      );
      return { number: existing.number, created: false };
    },
  };

  /**
   * One request whose body is JSON, with the operation named in the failure.
   *
   * @template T
   * @param {string} operation
   * @param {() => Promise<import("#core-transport/http.mjs").HttpResponse>} run
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
    const joiner = first.includes("?") ? "&" : "?";
    let url = `${first}${joiner}per_page=${String(PER_PAGE)}`;
    let hops = 0;
    for (;;) {
      assertPagesBounded(operation, hops);
      hops += 1;
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
