/**
 * Path resolution confined to the checkout — the ceiling every touch of the
 * working tree goes through, tool or not.
 *
 * The policy, from the security policy at the repository root and
 * `docs/development/review.md`:
 *
 *   - a requested path is repository-relative; an absolute one is not a
 *     mistake to reinterpret but a request to refuse;
 *   - the parent chain resolves through `realpath`, so intermediate symlinks
 *     cannot smuggle the destination across the boundary;
 *   - the final component is never followed: `lstat` decides what it is, and
 *     a symlink there is refused by type — nothing ever reads *through* a
 *     link, so a link aimed outside the workspace cannot leak what it points
 *     at;
 *   - the resolved location must land inside the root, and no component of
 *     the resolved path may be `.git` — the checkout's credentials live
 *     there;
 *   - only regular files and directories come back; devices, sockets and
 *     whatever else a filesystem offers do not exist for the caller.
 *
 * Resolution and opening are two steps, and this module does not pretend
 * otherwise: the threat model covers untrusted content, not a concurrent
 * local attacker rewriting the runner's own checkout between the two. The
 * runner is ours; the bytes under review are not.
 *
 * Paths are POSIX by assumption — these actions run on Linux runners, where
 * a backslash is an ordinary character in a filename and is treated as one.
 */

import { lstatSync, realpathSync } from "node:fs";
import * as p from "node:path";

/** The longest repository-relative path this module will even look at. */
export const MAX_PATH_BYTES = 4096;

/** A path this module refuses — outside the root, inside `.git`, a symlink, not a file or directory. */
export class WorkspaceRefusal extends Error {
  /**
   * @param {string} requested
   * @param {string} reason
   */
  constructor(requested, reason) {
    super(`refusing '${requested}': ${reason}`);
    this.name = "WorkspaceRefusal";
  }
}

/**
 * The path does not name something that exists. Distinct from a refusal:
 * callers decide whether absence is an answer or an error.
 */
export class MissingPathError extends Error {
  /** @param {string} requested */
  constructor(requested) {
    super(`'${requested}' does not exist in the workspace`);
    this.name = "MissingPathError";
  }
}

/**
 * @typedef {object} ResolvedEntry
 * @property {string} absolute the resolved location, root included
 * @property {string} relative the resolved path relative to the root, POSIX-separated
 * @property {"file" | "directory"} kind
 */

/**
 * The client `createWorkspace` returns, named so an action's JSDoc can say
 * `import("#core/workspace.mjs").Workspace`.
 *
 * @typedef {ReturnType<typeof createWorkspace>} Workspace
 */

/**
 * @param {{ root: string }} options `root` is the checkout, typically `GITHUB_WORKSPACE`
 * @returns {{ root: string, resolve: (relativePath: string) => ResolvedEntry }}
 */
export function createWorkspace(options) {
  // The root itself is resolved once, so a symlinked GITHUB_WORKSPACE does
  // not turn every comparison into a false escape.
  const root = realpathSync(options.root);

  return {
    root,

    /**
     * Resolves one repository-relative path inside the checkout, refusing
     * anything the policy above forbids.
     *
     * @param {string} relativePath
     * @returns {ResolvedEntry}
     */
    resolve(relativePath) {
      if (typeof relativePath !== "string" || relativePath === "") {
        throw new WorkspaceRefusal(String(relativePath), "a path must be a non-empty string");
      }
      if (Buffer.byteLength(relativePath, "utf8") > MAX_PATH_BYTES) {
        throw new WorkspaceRefusal(relativePath, `longer than ${String(MAX_PATH_BYTES)} bytes`);
      }
      if (relativePath.includes("\0")) {
        throw new WorkspaceRefusal(relativePath, "contains a NUL byte");
      }
      if (p.posix.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
        throw new WorkspaceRefusal(
          relativePath,
          "an absolute path is asked for relatively or not at all",
        );
      }

      const normalised = p.posix.normalize(relativePath);
      if (normalised === "." || normalised === "..") {
        throw new WorkspaceRefusal(relativePath, "names no file");
      }
      const base = p.posix.basename(normalised);
      if (base === "" || base === "." || base === "..") {
        throw new WorkspaceRefusal(relativePath, "ends where no entry begins");
      }

      let realParent;
      try {
        // Intermediate symlinks are resolved here, physically, so whatever
        // they point at is judged where it lands, not where it claims to be.
        realParent = realpathSync(p.resolve(root, p.posix.dirname(normalised)));
      } catch (cause) {
        if (isMissing(cause)) {
          // The parent chain does not exist — but a lexical climb may already
          // have left the root, and that is the refusal to name first: an
          // escape is an escape whether or not the destination exists, and
          // absence must not become the softer error by accident of spelling.
          const lexical = p.resolve(root, p.posix.dirname(normalised));
          if (escapesRoot(root, lexical)) {
            throw new WorkspaceRefusal(relativePath, "it resolves outside the workspace");
          }
          throw new MissingPathError(relativePath);
        }
        throw new WorkspaceRefusal(
          relativePath,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
      assertInside(root, relativePath, realParent, true);
      assertNoDotGit(relativePath, p.relative(root, realParent));

      const target = p.join(realParent, base);
      /** @type {import("node:fs").Stats} */
      let stats;
      try {
        stats = lstatSync(target);
      } catch (cause) {
        if (isMissing(cause)) throw new MissingPathError(relativePath);
        throw new WorkspaceRefusal(
          relativePath,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
      // The final component is never followed. A symlink is refused by type,
      // whichever way it points — inward links gain nothing and outward ones
      // would be reads this module was written to make impossible.
      if (stats.isSymbolicLink()) {
        throw new WorkspaceRefusal(
          relativePath,
          "its last component is a symlink, and links are never followed",
        );
      }
      if (!stats.isFile() && !stats.isDirectory()) {
        throw new WorkspaceRefusal(relativePath, "names neither a regular file nor a directory");
      }

      const relative = p.relative(root, target);
      // The entry itself must sit strictly inside — the resolved parent may
      // be the root, but a path that resolves to the root names no entry.
      assertInside(root, relativePath, realParent, true);
      assertInside(root, relativePath, target, false);
      assertNoDotGit(relativePath, relative);
      return {
        absolute: target,
        relative: relative.split(p.sep).join("/"),
        kind: stats.isDirectory() ? "directory" : "file",
      };
    },
  };
}

/**
 * Whether `inside` truly sits under `root`. String-prefix comparisons lie
 * (`/w/root-evil` starts with `/w/root`); component-wise relative paths do
 * not. The root itself counts as inside only where the caller says so — the
 * parent of a root-level entry is the root, an entry never is.
 *
 * @param {string} root
 * @param {string} requested
 * @param {string} inside
 * @param {boolean} allowRoot
 */
function assertInside(root, requested, inside, allowRoot) {
  if (inside === root) {
    if (!allowRoot)
      throw new WorkspaceRefusal(requested, "it resolves to the workspace root itself");
    return;
  }
  if (escapesRoot(root, inside)) {
    throw new WorkspaceRefusal(requested, "it resolves outside the workspace");
  }
}

/**
 * Whether `inside` truly sits under `root`. String-prefix comparisons lie
 * twice over — `/w/root-evil` starts with `/w/root`, and a file legitimately
 * named `..foo` starts with `..` — so the judgement is component-wise: only
 * a relative that is exactly `..` or begins with the `..` segment escapes.
 *
 * @param {string} root
 * @param {string} inside
 * @returns {boolean}
 */
function escapesRoot(root, inside) {
  const rel = p.relative(root, inside);
  return rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel);
}

/**
 * No component of the resolved path may be `.git` — compared
 * case-insensitively so the ceiling does not depend on the runner's
 * filesystem being case-sensitive — and `.github` sails through while the
 * checkout's credential store does not.
 *
 * @param {string} requested
 * @param {string} relativeToRoot
 */
function assertNoDotGit(requested, relativeToRoot) {
  const components = relativeToRoot.split(p.sep);
  if (components.some((component) => component.toLowerCase() === ".git")) {
    throw new WorkspaceRefusal(requested, "it resolves inside .git");
  }
}

/**
 * @param {unknown} cause
 * @returns {boolean}
 */
function isMissing(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    /** @type {Record<string, unknown>} */ (cause)["code"] === "ENOENT"
  );
}
