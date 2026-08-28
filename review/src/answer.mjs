/**
 * The model's final answer — parsed tolerantly, anchored intolerantly.
 *
 * Parsing tolerates provider drift: one wrapping fence stripped, the
 * outermost brace-balanced object located by a string-aware scanner that
 * tracks BOTH quote styles (a message like `'it{ breaks'` must not corrupt
 * the balance), then the same JSON5 parser the config file uses. Shaping
 * tolerates none of it: exactly `findings` and `summary`, each finding
 * exactly `severity`, `file`, `line`, `message`.
 *
 * Anchoring is where the snapshot speaks: a finding's file must belong to
 * the non-ignored changed inventory, be present at head, readable as text in
 * the verified workspace copy; its line must sit between 1 and that copy's
 * line count. Invalid findings are dropped individually and logged with the
 * finding that produced them — never coerced, never fatal to the run. What
 * survives is deduplicated on `(file, line, severity, trimmed message)`,
 * ordered deterministically (severity, file bytes, line number, message
 * bytes), and capped at 50 with the overflow named in the log. Whatever
 * order the model produced is discarded.
 */

import { closeSync, openSync, readSync } from "node:fs";

import { json5Parse } from "#core/json5-parse.mjs";

import { utf8Compare } from "./order.mjs";
import { MAX_READ_BYTES } from "./tools.mjs";

/** @typedef {import("./inventory.mjs").ChangedFile} ChangedFile */
/** @typedef {import("#core/workspace.mjs").Workspace} Workspace */

export const SEVERITIES = /** @type {const} */ (["concern", "nit"]);
export const MAX_FINDINGS = 50;

/** Anchors must not exceed the model's own read cap — a finding for a line
 *  the model could never have inspected is a false verification claim. */
const MAX_ANCHOR_READ_BYTES = MAX_READ_BYTES;

/** A NUL byte within this window marks binary content — the tools' own rule. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * @typedef {object} Finding
 * @property {"concern" | "nit"} severity
 * @property {string} file repository-relative path, as the inventory spells it
 * @property {number} line 1-based line in the new file
 * @property {string} message
 */

/**
 * @typedef {object} ValidatedAnswer
 * @property {Finding[]} findings deduplicated, ordered, capped
 * @property {string} summary as answered, unsanitised — the sanitiser runs at rendering
 * @property {string[]} rejections human-readable reasons, one per dropped finding
 */

/**
 * Parses the answer's text into its strict shape. Structural failure here is
 * what the loop's re-ask rule reacts to.
 *
 * @param {string} content what the model answered
 * @returns {{ ok: true, summary: string, rawFindings: unknown[] } | { ok: false, defect: string }}
 */
export function parseAnswer(content) {
  const attempt = extractObject(stripFences(content.trim()));
  if (attempt === null) return { ok: false, defect: "the answer holds no JSON object" };

  /** @type {unknown} */
  let value;
  try {
    value = json5Parse(attempt);
  } catch {
    return { ok: false, defect: "the answer does not parse as JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, defect: "the answer is not a JSON object" };
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(record)) {
    if (key !== "findings" && key !== "summary") {
      return { ok: false, defect: `the answer holds unknown key '${key}'` };
    }
  }
  if (!Array.isArray(record["findings"])) {
    return { ok: false, defect: "the answer has no findings array" };
  }
  if (typeof record["summary"] !== "string") {
    return { ok: false, defect: "the answer has no summary string" };
  }
  for (const raw of record["findings"]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, defect: "a finding is not an object" };
    }
    const finding = /** @type {Record<string, unknown>} */ (raw);
    for (const key of Object.keys(finding)) {
      if (key !== "severity" && key !== "file" && key !== "line" && key !== "message") {
        return { ok: false, defect: `a finding holds unknown key '${key}'` };
      }
    }
    if (
      typeof finding["severity"] !== "string" ||
      typeof finding["file"] !== "string" ||
      typeof finding["message"] !== "string" ||
      !Number.isInteger(finding["line"])
    ) {
      return { ok: false, defect: "a finding is missing severity, file, line or message" };
    }
  }
  return {
    ok: true,
    summary: record["summary"],
    rawFindings: /** @type {unknown[]} */ (record["findings"]),
  };
}

/**
 * Validates every finding against the reviewed snapshot and produces the
 * deterministic final list.
 *
 * @param {object} input
 * @param {unknown[]} input.rawFindings
 * @param {string} input.summary
 * @param {ChangedFile[]} input.reviewed the non-ignored inventory, budget survivors
 * @param {Workspace} input.workspace the verified checkout resolver
 * @returns {ValidatedAnswer}
 */
export function validateAnswer({ rawFindings, summary, reviewed, workspace }) {
  const byPath = new Map(reviewed.map((file) => [file.filename, file]));
  /** @type {Finding[]} */
  const kept = [];
  /** @type {string[]} */
  const rejections = [];

  for (const raw of rawFindings) {
    const finding = /** @type {Record<string, unknown>} */ (raw);
    const describe = JSON.stringify(finding);

    const severity = finding["severity"];
    if (severity !== "concern" && severity !== "nit") {
      rejections.push(
        `severity '${flatten(String(severity))}' is outside the vocabulary: ${describe}`,
      );
      continue;
    }
    const file = finding["file"];
    if (typeof file !== "string") continue; // unreachable past parse; kept type-safe
    const entry = byPath.get(file);
    if (entry === undefined) {
      rejections.push(`'${file}' is not in the changed inventory: ${describe}`);
      continue;
    }
    if (entry.status === "removed") {
      rejections.push(`'${file}' is deleted by this pull request: ${describe}`);
      continue;
    }
    const line = finding["line"];
    if (typeof line !== "number") continue; // unreachable past parse
    const counted = countLines(workspace, file);
    if (counted === null) {
      rejections.push(`'${file}' cannot carry anchors in this checkout: ${describe}`);
      continue;
    }
    if (line < 1 || line > counted) {
      rejections.push(
        `'${file}' has ${String(counted)} lines; line ${String(line)} does not exist: ${describe}`,
      );
      continue;
    }
    const message = finding["message"];
    if (typeof message !== "string" || message.trim() === "") {
      rejections.push(`the message is empty: ${describe}`);
      continue;
    }
    kept.push({ severity, file, line, message });
  }
  // Only exact logical duplicates collapse — identity includes the message,
  // so two genuine findings sharing a line both survive. The same identity
  // function keys `applyVerdicts`'s drop map, so a removal hits exactly one
  // finding.
  /** @type {Set<string>} */
  const seen = new Set();
  const unique = kept.filter((finding) => {
    const identity = findingIdentity(finding);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });

  unique.sort(orderFindings);

  const overflow = unique.length - MAX_FINDINGS;
  const findings = overflow > 0 ? unique.slice(0, MAX_FINDINGS) : unique;
  if (overflow > 0) {
    rejections.push(
      `${String(overflow)} findings past the ${String(MAX_FINDINGS)} cap were dropped`,
    );
  }

  return { findings, summary, rejections };
}

/**
 * The exact logical identity two findings must share to collapse — the same
 * anchor and the same trimmed message. `applyVerdicts` keys drops by it, so
 * a removal hits exactly one finding.
 *
 * @param {Finding} finding
 * @returns {string}
 */
export function findingIdentity(finding) {
  return `${finding.file}\u0000${String(finding.line)}\u0000${finding.severity}\u0000${finding.message.trim()}`;
}

/**
 * Severity first, then file bytes, then line number, then message bytes.
 *
 * @param {Finding} a
 * @param {Finding} b
 * @returns {number}
 */
function orderFindings(a, b) {
  const severityRank = (/** @type {Finding["severity"]} */ s) => (s === "concern" ? 0 : 1);
  const bySeverity = severityRank(a.severity) - severityRank(b.severity);
  if (bySeverity !== 0) return bySeverity;
  const byFile = utf8Compare(a.file, b.file);
  if (byFile !== 0) return byFile;
  if (a.line !== b.line) return a.line - b.line;
  return utf8Compare(a.message, b.message);
}

/**
 * Counts the newline-terminated lines of the workspace copy — the same copy
 * the anchor claims to point into. A file too large to read honestly cannot
 * carry verified anchors; null marks that.
 *
 * @param {Workspace} workspace
 * @param {string} relativePath
 * @returns {number | null}
 */
function countLines(workspace, relativePath) {
  let entry;
  try {
    entry = workspace.resolve(relativePath);
  } catch {
    return null;
  }
  if (entry.kind !== "file") return null;
  try {
    // Line counting needs the whole file; bounded so a giant blob cannot
    // make the run spend forever verifying one anchor.
    const fd = openSync(entry.absolute, "r");
    try {
      const buffer = Buffer.alloc(MAX_ANCHOR_READ_BYTES);
      const read = readSync(fd, buffer, 0, MAX_ANCHOR_READ_BYTES, 0);
      // The rule the tools enforce is the rule anchors obey: binary content
      // carries no lines to point at.
      if (buffer.subarray(0, Math.min(read, BINARY_SNIFF_BYTES)).includes(0)) return null;
      const content = buffer.subarray(0, read).toString("utf8");
      const lines = content.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      return lines.length;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Strips one fenced block wrapping the whole answer.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripFences(text) {
  const match = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return match?.[1] === undefined ? text : match[1];
}

/**
 * The outermost `{…}`, string-aware across both quote styles.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function extractObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  /** @type {string | undefined} */
  let quote;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * @param {string} text
 * @returns {string}
 */
function flatten(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}
