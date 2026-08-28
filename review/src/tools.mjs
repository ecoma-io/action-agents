/**
 * The fixed tool registry — `read_file`, `list_files`, `search` — and
 * nothing else. No input and no config key adds one: a tool an author cannot
 * add is a tool an attacker cannot aim.
 *
 * Every call is validated against its schema before anything executes, and
 * the two failure kinds stay distinct but both model-visible:
 *
 *   - a manners defect — unknown tool name, missing or wrong-typed or extra
 *     properties, an oversized query — comes back as an error result; the
 *     turn still counts, nothing is repaired or coerced;
 *   - a policy refusal — outside the workspace, inside `.git`, a symlink,
 *     an ignored path, binary content — names the ceiling that fired;
 *   - a protocol defect — arguments that are not valid JSON at all — comes
 *     back flagged `fatal`: the conversation's wire format is broken, which
 *     is the provider failing, not a turn to hand back. The loop maps it to
 *     a red run.
 *
 * Every successful result enters the transcript through the evidence
 * wrapper: file content is data about the change, never instruction. The
 * caps are the spec's: 64 KiB per wrapped block (the wrapper's own), 500
 * entries per listing, 200 matches and 8 MiB scanned per search — matches
 * cap the output, the scan cap caps the work.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import * as p from "node:path";

import { matchGlob } from "#core/glob.mjs";
import { MissingPathError, WorkspaceRefusal } from "#core/workspace.mjs";

import { utf8Compare } from "./order.mjs";

/** @typedef {import("node:fs").Dirent} Dirent */
/** @typedef {import("#core/workspace.mjs").Workspace} Workspace */
/** @typedef {ReturnType<typeof import("#core/untrusted.mjs").createEvidence>} Evidence */
/** @typedef {import("#core/chat.mjs").ChatTool} ChatTool */
/** @typedef {import("#core/workspace.mjs").ResolvedEntry} ResolvedEntry */

export const MAX_QUERY_BYTES = 512;
export const MAX_LIST_ENTRIES = 500;
export const MAX_SEARCH_MATCHES = 200;
export const MAX_SCAN_BYTES = 8 * 2 ** 20;
export const BINARY_SNIFF_BYTES = 8192;
/** The most one read_file pulls off disk before the evidence cap takes over. */
export const MAX_READ_BYTES = 2 ** 20;

/**
 * The registry, in the shape the chat-completions request carries. This list
 * is the whole surface the model can ever see.
 *
 * @type {ChatTool[]}
 */
export const TOOL_SPECS = [
  {
    name: "read_file",
    description:
      "Read one text file's content, by repository-relative path. Refuses directories, " +
      "symlinks, binary files and ignored paths.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string", description: "repository-relative path" } },
    },
  },
  {
    name: "list_files",
    description:
      "List every regular file beneath a directory, recursively, sorted by path. " +
      "Symlinks never appear.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string", description: "repository-relative directory" } },
    },
  },
  {
    name: "search",
    description:
      "Find lines containing a fixed substring (case-sensitive), with file and line number.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "the exact substring to find" },
        path: { type: "string", description: "optional repository-relative directory to scan" },
      },
    },
  },
];

/**
 * @typedef {object} ToolLimits the caps, injectable so tests can exercise a cut without building a giant tree
 * @property {number} [listEntries]
 * @property {number} [searchMatches]
 * @property {number} [scanBytes]
 */

/**
 * @typedef {object} ToolResult
 * @property {boolean} ok
 * @property {string} output the evidence-wrapped result when ok, the error text when not
 * @property {true} [fatal] set only for wire-contract defects — the run fails red, the turn does not continue
 */

/**
 * @param {object} input
 * @param {Workspace} input.workspace the confined resolver every path goes through
 * @param {Evidence} input.evidence the wrapper every result enters through
 * @param {string[]} input.ignore the config's universe filter, glob patterns
 * @param {ToolLimits} [input.limits]
 * @param {Map<string, string>} [input.recordedReads] the verification ledger: every successful
 *   read_file's raw bytes, keyed by the normalised requested path. The pass
 *   verifies findings only against bytes the reviewer actually captured.
 */
export function createTools({ workspace, evidence, ignore, limits = {}, recordedReads }) {
  const listEntries = limits.listEntries ?? MAX_LIST_ENTRIES;
  const searchMatches = limits.searchMatches ?? MAX_SEARCH_MATCHES;
  const scanBytes = limits.scanBytes ?? MAX_SCAN_BYTES;

  return {
    /**
     * Executes one validated tool call. Never throws at a model mistake —
     * errors are results the loop hands back.
     *
     * @param {string} name
     * @param {string} argumentsJson
     * @returns {ToolResult}
     */
    execute(name, argumentsJson) {
      if (name !== "read_file" && name !== "list_files" && name !== "search") {
        return fail(
          `unknown tool '${flatten(name)}' — the fixed registry offers read_file, list_files, search`,
        );
      }

      /** @type {Record<string, unknown>} */
      let args;
      try {
        const parsed = JSON.parse(argumentsJson);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          // A scalar or array where the schema promises an object is the
          // model fumbling one call — manners, not wire damage.
          return fail("arguments must be a JSON object");
        }
        args = /** @type {Record<string, unknown>} */ (parsed);
      } catch {
        // The chat-completions contract says `arguments` IS a string of
        // JSON. Unparsable means the conversation itself broke: fatal, red.
        return { ok: false, output: "arguments are not valid JSON", fatal: true };
      }

      if (name === "read_file") {
        const keys = expectKeys(args, ["path"]);
        if (keys !== "") return fail(keys);
        return expectPath(args["path"]).match((path) =>
          readFile(workspace, evidence, ignore, recordedReads, path),
        );
      }

      if (name === "list_files") {
        const keys = expectKeys(args, ["path"]);
        if (keys !== "") return fail(keys);
        return expectPath(args["path"]).match((path) =>
          listFiles(workspace, evidence, ignore, path, listEntries),
        );
      }

      const keys = expectKeys(args, ["query"], ["path"]);
      if (keys !== "") return fail(keys);
      const query = expectQuery(args["query"]);
      if (query.refusal !== "") return fail(query.refusal);
      const scanLimits = { searchMatches, scanBytes };
      if (args["path"] === undefined) {
        return searchFrom(workspace, evidence, ignore, query.value, workspace.root, scanLimits);
      }
      return expectPath(args["path"]).match((path) => {
        const resolved = resolveDirOrRefuse(workspace, path);
        if ("refusal" in resolved) return fail(resolved.refusal);
        return searchFrom(
          workspace,
          evidence,
          ignore,
          query.value,
          resolved.entry.absolute,
          scanLimits,
        );
      });
    },
  };
}

/**
 * @param {string} message
 * @returns {ToolResult}
 */
function fail(message) {
  return { ok: false, output: message };
}

/**
 * @param {string} text
 * @returns {string}
 */
function flatten(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Exact keys only: extra properties are a manners defect, not noise to skip.
 *
 * @param {Record<string, unknown>} args
 * @param {string[]} required
 * @param {string[]} [optional]
 * @returns {string} "" when the keys are exactly right
 */
function expectKeys(args, required, optional = []) {
  for (const key of required) {
    if (!(key in args)) return `missing argument '${key}'`;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) return `unknown argument '${key}'`;
  }
  return "";
}

/**
 * @typedef {object} PendingPath
 * @property {string} value the requested path, when valid
 * @property {string} refusal the error text, when not
 */

/**
 * A small two-way value so argument checks read as guards, not ladders.
 *
 * @param {unknown} value
 * @returns {{ value: string, refusal: string } & { match: (run: (path: string) => ToolResult) => ToolResult }}
 */
function expectPath(value) {
  const valid = typeof value === "string" && value !== "";
  const core = valid
    ? { value: /** @type {string} */ (value), refusal: "" }
    : { value: "", refusal: "'path' must be a non-empty string" };
  return {
    ...core,
    /** @param {(path: string) => ToolResult} run */
    match(run) {
      return valid ? run(core.value) : fail(core.refusal);
    },
  };
}

/**
 * @param {unknown} value
 * @returns {{ value: string, refusal: string }}
 */
function expectQuery(value) {
  if (typeof value !== "string" || value === "") {
    return { value: "", refusal: "'query' must be a non-empty string" };
  }
  if (Buffer.byteLength(value, "utf8") > MAX_QUERY_BYTES) {
    return { value: "", refusal: `'query' is longer than ${String(MAX_QUERY_BYTES)} bytes` };
  }
  return { value, refusal: "" };
}

/**
 * Resolves a requested directory, where the empty string and "." mean the
 * workspace root itself — policy-trivially inside, no resolution needed.
 * Both error kinds map onto model-visible failures.
 *
 * @param {Workspace} workspace
 * @param {string} requested
 * @returns {{ entry: ResolvedEntry } | { refusal: string }}
 */
function resolveDirOrRefuse(workspace, requested) {
  const normalised = p.posix.normalize(requested);
  if (requested === "" || normalised === ".") {
    return { entry: { absolute: workspace.root, relative: "", kind: "directory" } };
  }
  const resolved = resolveOrRefuse(workspace, requested);
  if ("refusal" in resolved) return resolved;
  return resolved.entry.kind === "directory"
    ? resolved
    : { refusal: `refusing '${requested}': it names a file, not a directory` };
}

/**
 * Resolves a requested path under the workspace policy, mapping every error
 * kind onto a model-visible failure that names only what was asked for —
 * never an absolute path from the runner's filesystem, which Node's own
 * error texts would otherwise carry.
 *
 * @param {Workspace} workspace
 * @param {string} requested
 * @returns {{ entry: ResolvedEntry } | { refusal: string }}
 */
function resolveOrRefuse(workspace, requested) {
  try {
    return { entry: workspace.resolve(requested) };
  } catch (cause) {
    return { refusal: resolutionRefusal(requested, cause) };
  }
}

/**
 * @param {string} requested
 * @param {unknown} cause
 * @returns {string}
 */
function resolutionRefusal(requested, cause) {
  if (cause instanceof MissingPathError) return `'${requested}' does not exist`;
  if (cause instanceof WorkspaceRefusal) return cause.message;
  // ELOOP, EACCES, ENAMETOOLONG…: the OS refused, and its message names
  // resolved absolute paths. The model learns that the path cannot be
  // resolved safely; nothing more about where it landed.
  return `refusing '${requested}': it cannot be resolved safely on this filesystem`;
}

/**
 * @param {Workspace} workspace
 * @param {Evidence} evidence
 * @param {string[]} ignore
 * @param {Map<string, string> | undefined} recordedReads when present, every successful text read is recorded here
 * @param {string} requestedPath
 * @returns {ToolResult}
 */
function readFile(workspace, evidence, ignore, recordedReads, requestedPath) {
  if (matchGlob(ignore, p.posix.normalize(requestedPath))) {
    // Ignore matching happens on the canonical spelling, so ./dist/x.js is
    // refused exactly when dist/x.js is.
    return fail(`refusing '${requestedPath}': the config ignores this path`);
  }
  const resolved = resolveOrRefuse(workspace, requestedPath);
  if ("refusal" in resolved) return fail(resolved.refusal);
  const { entry } = resolved;
  if (entry.kind !== "file") {
    return fail(`refusing '${requestedPath}': it names a directory`);
  }

  /** @type {number} */
  let size;
  /** @type {Buffer} */
  let buffer;
  try {
    size = statSync(entry.absolute).size;
    buffer = readUpTo(entry.absolute, MAX_READ_BYTES);
  } catch {
    // Same discipline as refusals: the OS error text stays out of the
    // transcript. What failed and where it sits are ours to log, not to say.
    return fail(`could not read '${requestedPath}'`);
  }
  if (isBinary(buffer)) {
    return fail(`refusing '${requestedPath}': binary content — findings cannot anchor here`);
  }
  // The verification pass judges findings only against bytes this loop
  // actually captured, so the successful read is recorded before it is
  // framed: raw UTF-8, keyed by the normalised requested path — the same
  // spelling the coverage ledger matches findings against.
  recordedReads?.set(p.posix.normalize(requestedPath), buffer.toString("utf8"));
  const header =
    `${entry.relative}\n` +
    (buffer.length < size
      ? `(showing the first ${String(buffer.length)} of ${String(size)} bytes)\n`
      : "");
  return { ok: true, output: evidence.wrap("read-file", `${header}${buffer.toString("utf8")}`) };
}

/**
 * @param {Workspace} workspace
 * @param {Evidence} evidence
 * @param {string[]} ignore
 * @param {string} requestedPath
 * @param {number} cap
 * @returns {ToolResult}
 */
function listFiles(workspace, evidence, ignore, requestedPath, cap) {
  const resolved = resolveDirOrRefuse(workspace, requestedPath);
  if ("refusal" in resolved) return fail(resolved.refusal);
  const { entry } = resolved;

  /** @type {string[]} */
  const found = [];
  collectFiles(entry.absolute, workspace.root, ignore, found);
  found.sort(utf8Compare);

  const cut = found.length > cap;
  const listed = cut ? found.slice(0, cap) : found;
  const marker = cut ? `\n(listing cut at ${String(cap)} entries)` : "";
  const body = listed.length === 0 && !cut ? "(no files)" : `${listed.join("\n")}${marker}`;
  return { ok: true, output: evidence.wrap("listing", body) };
}

/**
 * Scans one subtree for lines containing the exact substring. Candidate
 * files are sorted byte-wise before scanning, so which matches survive a
 * cap cannot depend on readdir's order.
 *
 * @param {Workspace} workspace
 * @param {Evidence} evidence
 * @param {string[]} ignore
 * @param {string} query
 * @param {string} absoluteRoot the already-resolved scan root
 * @param {{ searchMatches: number, scanBytes: number }} limits
 * @returns {ToolResult}
 */
function searchFrom(workspace, evidence, ignore, query, absoluteRoot, limits) {
  /** @type {string[]} */
  const candidates = [];
  collectFiles(absoluteRoot, workspace.root, ignore, candidates);
  candidates.sort(utf8Compare);

  /** @type {string[]} */
  const matches = [];
  let scanned = 0;
  let hitMatchCap = false;
  let clippedByScan = false;
  for (const relative of candidates) {
    if (hitMatchCap) break;
    const allowed = limits.scanBytes - scanned;
    if (allowed <= 0) {
      // The budget was spent by earlier files and this one goes unread.
      clippedByScan = true;
      break;
    }
    const want = Math.min(allowed, MAX_READ_BYTES);
    let buffer;
    /** @type {number} */
    let size;
    try {
      size = statSync(p.join(workspace.root, relative)).size;
      buffer = readUpTo(p.join(workspace.root, relative), want);
    } catch {
      continue; // vanished or unreadable mid-scan: skipped, not fatal
    }
    scanned += buffer.length;
    // Reading less than the file holds — the budget or the read cap stopped
    // us inside it — is a cut, and cuts are marked wherever they land in the
    // candidate list.
    if (buffer.length < size) clippedByScan = true;
    if (isBinary(buffer)) continue;

    const lines = buffer.toString("utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.includes(query)) continue;
      matches.push(`${relative}:${String(index + 1)}:${line.trim()}`);
      if (matches.length >= limits.searchMatches) {
        hitMatchCap = true;
        break;
      }
    }
  }

  /** @type {string[]} */
  const markers = [];
  if (hitMatchCap) markers.push(`\n(search stopped at ${String(limits.searchMatches)} matches)`);
  if (!hitMatchCap && clippedByScan) {
    markers.push(`\n(scan limit reached at ${String(limits.scanBytes)} bytes)`);
  }

  const body =
    matches.length === 0 && markers.length === 0
      ? "(no matches)"
      : `${matches.join("\n")}${markers.join("")}`;
  return { ok: true, output: evidence.wrap("search", body) };
}

/**
 * Collects regular files beneath a directory as root-relative paths,
 * pruning ignored paths and `.git` at every level and skipping symlinks
 * entirely — a symlink is not a regular file, so traversal cycles cannot
 * happen by construction.
 *
 * @param {string} absoluteDir
 * @param {string} root
 * @param {string[]} ignore
 * @param {string[]} out pushed unsorted; callers sort
 */
function collectFiles(absoluteDir, root, ignore, out) {
  /** @type {Dirent[]} */
  let dirents;
  try {
    dirents = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue;
    const childAbsolute = p.join(absoluteDir, dirent.name);
    const childRelative = p.relative(root, childAbsolute).split(p.sep).join("/");
    const components = childRelative.split("/");
    if (components.some((component) => component.toLowerCase() === ".git")) continue;
    if (matchGlob(ignore, childRelative)) continue;
    if (dirent.isDirectory()) {
      collectFiles(childAbsolute, root, ignore, out);
      continue;
    }
    if (dirent.isFile()) out.push(childRelative);
  }
}

/**
 * Reads at most `cap` bytes without pulling the whole blob into memory
 * first — a reviewer reads bounded slices, however large the file on disk.
 *
 * @param {string} absolute
 * @param {number} cap
 * @returns {Buffer}
 */
function readUpTo(absolute, cap) {
  const fd = openSync(absolute, "r");
  try {
    const buffer = Buffer.alloc(cap);
    const read = readSync(fd, buffer, 0, cap, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * A NUL byte within the first sniff window marks binary content — the same
 * rule everywhere, applied before any text decoding. A NUL deeper in an
 * otherwise textual file is not this tool's business.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isBinary(buffer) {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}
