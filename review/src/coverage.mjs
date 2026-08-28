/**
 * Coverage accounting — which changed files the review actually examined,
 * decided by code. The expected set is derived from the pull request's diff
 * by `parseDiffPaths`, never from anything the model said; the read set is
 * the ledger's `read_file` record; the verdict that lets a review conclude
 * is a pure comparison of the two. Model text can move neither side.
 *
 * A diff is untrusted *data*, but parsing it is pure computation: malformed
 * headers are skipped, never interpreted, and nothing here reaches the
 * network, the filesystem or the model.
 */

import * as p from "node:path";

import { sortByUtf8 } from "./order.mjs";

/** @typedef {import("./inventory.mjs").ChangedFile} ChangedFile */
/** @typedef {import("./config.mjs").Strictness} Strictness */

/**
 * The deterministic read-coverage report over one expected set.
 *
 * @typedef {object} CoverageReport
 * @property {string[]} covered expected paths the ledger shows read, byte-wise sorted
 * @property {string[]} uncovered expected paths with no read on record, byte-wise sorted
 * @property {number} total the expected set's size
 */

/**
 * The deterministic set of repository paths a unified diff touches, one per
 * changed file, deduplicated and byte-wise sorted.
 *
 * Per file section (opened by `diff --git`, or a bare `---`/`+++` pair):
 *
 * - the path counted is the file's path at the reviewed head — the `+++`
 *   path, except that a deletion (`+++ /dev/null`) counts the `---` path.
 *   A rename or copy therefore counts only the NEW path: that is where the
 *   content to review lives, the old path's content is unchanged, and the
 *   inventory makes the same choice ("the old path of a rename is never
 *   consulted"). A pure rename with no content hunk counts its
 *   `rename to`/`copy to` path.
 * - git's synthetic `a/` (on `---`) and `b/` (on `+++`) prefixes are
 *   stripped, then any leading `./`; quoted headers are unquoted and their
 *   C-style escapes resolved; an unquoted token ends at a tab (the classic
 *   timestamp separator); `/dev/null` counts nothing on its side.
 * - hunk bodies are tracked by line count: an added line whose content
 *   happens to look like a header (`+++ b/x`) is content, never a header.
 * - binary files count — by their `---`/`+++` headers when present, or by
 *   the `Binary files a/x and b/y differ` line real git emits in their
 *   place. Sections with no content headers at all
 *   (a mode-only change) contribute no path: there is nothing to read.
 * - a combined-diff `@@@` hunk is not a supported shape; its section
 *   commits nothing rather than a misread name.
 *
 * @param {string} diffText the unified diff, or any concatenation of unified-diff fragments
 * @returns {string[]} repository-relative paths, byte-wise sorted
 */
export function parseDiffPaths(diffText) {
  /** @type {Set<string>} */
  const paths = new Set();
  /** @type {string | undefined} */
  let oldPath = undefined;
  /** @type {string | undefined} */
  let newPath = undefined;
  /** @type {boolean} */
  let poisoned = false;
  /** @type {string | undefined} */
  let renamePath = undefined;
  /** @type {boolean} */
  let inHunk = false;
  let oldLeft = 0;
  let newLeft = 0;

  /** Clears one section's state: a new section begins empty. */
  const resetSection = () => {
    oldPath = undefined;
    newPath = undefined;
    renamePath = undefined;
    inHunk = false;
    oldLeft = 0;
    newLeft = 0;
  };
  /** A `diff --git` line: even an unsupported section's state ends here. */
  const reset = () => {
    resetSection();
    poisoned = false;
  };
  /**
   * Records the section's one path — the head path, by the rules above. A
   * section this parser does not support (`@@@` combined-diff hunks)
   * commits nothing rather than a misread name.
   */
  const commit = () => {
    if (poisoned) return;
    const chosen = newPath ?? oldPath ?? renamePath;
    if (chosen !== undefined && chosen !== "" && chosen !== ".") paths.add(chosen);
  };

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      commit();
      reset();
      continue;
    }
    if (inHunk) {
      const first = line[0];
      if (first === "\\") continue; // "\ No newline at end of file" — counts nothing
      if (first === "+" || first === "-" || first === " ") {
        if (first !== "+" && oldLeft > 0) oldLeft--;
        if (first !== "-" && newLeft > 0) newLeft--;
        if (oldLeft <= 0 && newLeft <= 0) inHunk = false;
        continue;
      }
      const counts = hunkCounts(line);
      if (counts !== undefined) {
        oldLeft = counts.old;
        newLeft = counts.new;
        continue;
      }
      // An unprefixed line inside a spent hunk ends it; anything else is
      // malformed body noise — skipped, never interpreted.
      if (oldLeft <= 0 && newLeft <= 0) inHunk = false;
      continue;
    }
    const counts = hunkCounts(line);
    if (counts !== undefined) {
      oldLeft = counts.old;
      newLeft = counts.new;
      inHunk = true;
      continue;
    }
    if (line.startsWith("@@@")) {
      // A combined-diff hunk: this parser does not read merge columns, so
      // the section is dropped rather than its body misread as headers.
      poisoned = true;
      continue;
    }
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      // The shape real git emits for a binary: no content headers, the
      // two names on one line. Sides the headers already named are kept.
      const body = line.slice("Binary files ".length, -" differ".length);
      const cut = body.lastIndexOf(" and ");
      if (cut !== -1) {
        const from = headerPath(body.slice(0, cut), "a/");
        const to = headerPath(body.slice(cut + " and ".length), "b/");
        if (oldPath === undefined && from !== undefined) oldPath = from;
        if (newPath === undefined && to !== undefined) newPath = to;
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      // Concatenated fragments (GitHub hands out bare patches) have no
      // `diff --git` between files: a fresh `---` over existing section
      // state closes the previous section here.
      if (oldPath !== undefined || newPath !== undefined || renamePath !== undefined) {
        commit();
        // Not resetSection's poison: once an @@@ line appears, the
        // fragment's remaining headers are suspect until a real
        // `diff --git` delimiter arrives.
        resetSection();
      }
      oldPath = headerPath(line.slice(4), "a/");
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = headerPath(line.slice(4), "b/");
      continue;
    }
    if (line.startsWith("rename to ")) {
      renamePath = barePath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("copy to ")) {
      renamePath = barePath(line.slice("copy to ".length));
      continue;
    }
    // Every other line — `index …`, `similarity index …`, prose, garbage —
    // is data this parser does not need.
  }
  commit();

  return sortByUtf8([...paths]);
}

/**
 * Renders the forge's per-file entries — the same read that builds the
 * inventory — as one unified-diff text, so the expected coverage set is
 * derived by parsing a diff, the same way it will be derived if the forge
 * one day hands over a whole-repo diff text. Each entry becomes a standard
 * section: `diff --git`, the rename/copy extended headers when the entry is
 * one, the `---`/`+++` pair (with `/dev/null` on the empty side), then the
 * entry's own patch when GitHub supplied one. A filename whose characters
 * would end the token early (tab, newline, quote, backslash) is emitted in
 * git's quoted form — the whole prefixed token quoted, as git itself does —
 * so the parser reads back the exact name.
 *
 * @param {ChangedFile[]} files the inventory's reviewed entries
 * @returns {string} the unified-diff text, possibly empty
 */
export function unifiedDiff(files) {
  /** @type {string[]} */
  const sections = [];
  for (const file of files) {
    const from = file.previousFilename ?? file.filename;
    /** @type {string[]} */
    const lines = [`diff --git a/${from} b/${file.filename}`];
    if (file.previousFilename !== undefined) {
      const verb = file.status === "copied" ? "copy" : "rename";
      lines.push(`${verb} from ${from}`, `${verb} to ${file.filename}`);
    }
    lines.push(
      file.status === "added" ? "--- /dev/null" : `--- ${diffSafe(`a/${from}`)}`,
      file.status === "removed" ? "+++ /dev/null" : `+++ ${diffSafe(`b/${file.filename}`)}`,
    );
    if (file.patch !== undefined) lines.push(file.patch);
    sections.push(lines.join("\n"));
  }
  return sections.length === 0 ? "" : `${sections.join("\n")}\n`;
}
/**
 * The set accounting: which expected paths appear in the read record, which
 * do not. Both inputs are plain path arrays; membership, not order, is what
 * is compared, and every output list is byte-wise sorted so two runs agree.
 *
 * @param {string[]} expectedPaths the diff-derived set
 * @param {string[]} readPaths the paths on record as read
 * @returns {CoverageReport}
 */
export function coverageReport(expectedPaths, readPaths) {
  const read = new Set(readPaths);
  /** @type {string[]} */
  const covered = [];
  /** @type {string[]} */
  const uncovered = [];
  for (const path of new Set(expectedPaths)) {
    (read.has(path) ? covered : uncovered).push(path);
  }
  return {
    covered: sortByUtf8(covered),
    uncovered: sortByUtf8(uncovered),
    total: covered.length + uncovered.length,
  };
}

/**
 * Whether the review may conclude with a "Complete" posture. `high`
 * strictness is the strict arm: its mode paragraph states reading every
 * changed file as the expectation, so the code holds the review to exactly
 * that — any uncovered path keeps the concluding state partial. `low` and
 * `medium` are the standard arm: the review may conclude, and the report
 * rides along in the comment instead. The verdict is computed here; no
 * model output can widen the expected set, mark a file read, or flip it.
 *
 * @param {CoverageReport} report
 * @param {Strictness} policy the review's strictness — the review policy
 * @returns {boolean}
 */
export function canConcludeReview(report, policy) {
  return policy !== "high" || report.uncovered.length === 0;
}

/**
 * The read-record side of the comparison: the loop's ledger stores the raw
 * `read_file` argument (JSON-encoded), and the model may spell a path
 * `./src/a.mjs` or `sub/../src/a.mjs` where the diff says `src/a.mjs`.
 * This normalises a recorded path to the diff's canonical form — the same
 * `./`-stripping normalisation `parseDiffPaths` applies — so the set
 * difference answers "was this file read", not "was it spelled identically".
 *
 * @param {string} path a path as recorded from a tool call
 * @returns {string} the normalised repository-relative form
 */
export function normaliseReadPath(path) {
  return p.posix.normalize(path);
}

/**
 * Parses one `---`/`+++` header's path token. Git wraps the whole prefixed
 * token in quotes when the name needs it (`"a/name with space.mjs"`), so
 * the token is unquoted first, then the synthetic prefix is stripped, then
 * `/dev/null` is refused (it names no file) and the result normalised. A
 * token that strips or normalises to nothing is malformed and refused.
 *
 * @param {string} token everything after the `--- ` or `+++ `
 * @param {string} prefix the header's synthetic prefix, `a/` or `b/`
 * @returns {string | undefined} the path, or undefined for `/dev/null` and malformed tokens
 */
function headerPath(token, prefix) {
  const raw = barePath(token);
  if (raw === undefined || raw === "/dev/null") return undefined;
  const stripped = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  const normalised = p.posix.normalize(stripped);
  return normalised === "" || normalised === "." ? undefined : normalised;
}

/**
 * Strips one path token's quoting and trailing timestamp: a git-quoted
 * token is unquoted with its C-style escapes resolved; an unquoted token
 * ends at the first tab (GNU diff's timestamp separator — git quotes
 * instead of ever emitting a raw tab). A token cut to nothing is malformed
 * and reported as such.
 *
 * @param {string} token the raw text after the header verb
 * @returns {string | undefined}
 */
function barePath(token) {
  const trimmed = token.endsWith("\r") ? token.slice(0, -1) : token;
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeC(trimmed.slice(1, -1));
  }
  const tabbed = trimmed.indexOf("\t");
  const cut = tabbed === -1 ? trimmed : trimmed.slice(0, tabbed);
  return cut === "" ? undefined : cut;
}

/**
 * Resolves the C-style escapes git's quoted paths use — `\t`, `\n`, `\r`,
 * `\"`, `\\`, the control escapes and `\NNN` octal bytes — collecting
 * bytes so multi-byte UTF-8 spelled as octal escapes round-trips. An
 * unknown escape is taken literally: malformed, but data, not instruction.
 *
 * @param {string} body the inside of a quoted path
 * @returns {string}
 */
function unescapeC(body) {
  /** @type {number[]} */
  const bytes = [];
  const push = (/** @type {string} */ text) => {
    for (const byte of Buffer.from(text, "utf8")) bytes.push(byte);
  };
  for (let i = 0; i < body.length; i++) {
    const char = body.charAt(i);
    if (char !== "\\") {
      push(char);
      continue;
    }
    const next = body.charAt(i + 1);
    i++;
    if (next === "") {
      push("\\");
      continue;
    }
    if (next >= "0" && next <= "7") {
      let octal = next;
      while (octal.length < 3 && body.charAt(i + 1) >= "0" && body.charAt(i + 1) <= "7") {
        octal += body.charAt(i + 1);
        i++;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    const control = CONTROL_ESCAPES[next];
    if (control !== undefined) bytes.push(control);
    else push(`\\${next}`);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** @type {Record<string, number>} */
const CONTROL_ESCAPES = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * Reads a hunk header's line counts, the count defaulting to 1 when
 * omitted, per the unified-diff format.
 * Anything else — prose, a `@@@` combined-diff header, a hunk-like line
 * inside quoted content — is not a hunk header.
 *
 * @param {string} line
 * @returns {{ old: number, new: number } | undefined}
 */
function hunkCounts(line) {
  const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
  if (match === null) return undefined;
  return {
    old: match[1] === undefined ? 1 : Number.parseInt(match[1], 10),
    new: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
  };
}

/**
 * Git quotes a filename containing special characters; emitted raw, a tab
 * would end the token at the parser's timestamp rule and a newline would
 * end the line. Names carrying one of those characters are emitted in git's
 * quoted form so `parseDiffPaths` reads back the exact name. The order of
 * escapes matches git's own quoting.
 *
 * @param {string} name a repository path from the forge
 * @returns {string} the header token, quoted when the name demands it
 */
function diffSafe(name) {
  if (!/[\t\r\n"\\]/.test(name)) return name;
  let out = '"';
  for (const char of name) {
    if (char === '"' || char === "\\") out += `\\${char}`;
    else if (char === "\t") out += "\\t";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else out += char;
  }
  return `${out}"`;
}
