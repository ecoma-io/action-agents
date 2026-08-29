/**
 * Evidence provenance — the code's own bookkeeping over what the loop
 * captured. The doctrine it enforces: what the model claims is publishable
 * only where the loop's recorded reads already went. A finding may carry any
 * file and line the answer contract allows; whether it reaches publication
 * is decided here, against the ledger of reads the loop actually recorded —
 * never against the claim itself.
 *
 * A finding with no covering read is quarantined: it leaves the publication
 * set with its identity attached and the reason `unanchored`, before
 * verification planning ever sees it. It is never silently discarded and
 * never published. An anchored finding keeps its content byte-identical —
 * provenance attaches as metadata naming the resolved read, which rendering
 * later turns into a short `evidence:` line from ledger data alone.
 *
 * The resolution is a pure function of the findings' order and the ledger's
 * order: when several recorded reads cover one anchor, the read that
 * recorded a covering range first wins. The same inputs always resolve the
 * same way. Malformed entries are refused, not coerced — a shape this
 * module did not specify is a code bug, not data to repair. No model text
 * enters any decision here.
 */

import { normaliseReadPath } from "./coverage.mjs";

/** @typedef {import("./answer.mjs").Finding} Finding */

/**
 * One recorded read the loop captured, reduced to the span that matters for
 * anchoring: the repository-relative path and the 1-based, inclusive line
 * range the capture reached.
 *
 * @typedef {object} LedgerRead
 * @property {string} path normalised repository-relative path
 * @property {number} startLine first captured line, 1-based
 * @property {number} endLine last captured line, inclusive
 */

/**
 * The resolved read reference attached to an anchored finding — ledger data
 * only, never model text.
 *
 * @typedef {object} Provenance
 * @property {string} path the covering read's normalised path
 * @property {number} startLine the covering read's first captured line
 * @property {number} endLine the covering read's last captured line, inclusive
 */

/**
 * A finding that may not publish because no recorded read reaches its
 * anchor. The finding object itself rides along so the caller can log its
 * identity; the reason is fixed — quarantine has exactly one cause here.
 *
 * @typedef {object} QuarantinedFinding
 * @property {Finding} finding the refused finding, untouched
 * @property {"unanchored"} reason no recorded read covers the finding's path and line
 */

/**
 * A finding that may publish, with the resolved read reference attached as
 * metadata. Every field the finding already carried is byte-identical; only
 * `provenance` is added.
 *
 * @typedef {Finding & { provenance: Provenance }} AnchoredFinding
 */

/**
 * @typedef {object} ProvenanceResult
 * @property {AnchoredFinding[]} published anchored findings, in findings order
 * @property {QuarantinedFinding[]} quarantined unanchored findings, in findings order
 */

/**
 * Resolves every finding against the ledger's recorded reads: a read covers
 * a finding when its path matches (normalised, the same spelling rule the
 * coverage ledger applies) and its captured range reaches the finding's
 * line. The first covering read in ledger order wins, so several qualifying
 * reads resolve deterministically to one. Findings with no covering read
 * are quarantined, not dropped. Inputs are never mutated.
 *
 * @param {Finding[]} findings the validated findings, in publication order
 * @param {LedgerRead[]} ledger the loop's recorded reads, in recording order
 * @returns {ProvenanceResult}
 */
export function attachProvenance(findings, ledger) {
  if (!Array.isArray(findings)) throw new TypeError("findings must be an array");
  const reads = validatedLedger(ledger);
  /** @type {AnchoredFinding[]} */
  const published = [];
  /** @type {QuarantinedFinding[]} */
  const quarantined = [];
  for (const finding of findings) {
    const anchor = validatedFinding(finding);
    const read = reads.find(
      (entry) =>
        entry.path === normaliseReadPath(anchor.file) &&
        anchor.line >= entry.startLine &&
        anchor.line <= entry.endLine,
    );
    if (read === undefined) {
      quarantined.push({ finding, reason: "unanchored" });
      continue;
    }
    published.push({
      ...finding,
      provenance: { path: read.path, startLine: read.startLine, endLine: read.endLine },
    });
  }
  return { published, quarantined };
}

/**
 * Adapts the loop's read ledger — resolved-relative path → the raw bytes one
 * successful `read_file` captured — to this module's read list. A capture
 * starts at line 1 and reaches the line count of the captured content,
 * counted the same way the verification excerpt counts: splitting on
 * newlines, so a capture and its verdicts agree on where content ends.
 * Insertion order is recording order, so the map's one-read-per-path shape
 * keeps the resolution deterministic.
 *
 * @param {ReadonlyMap<string, string>} recordedReads resolved-relative path → captured content
 * @returns {LedgerRead[]}
 */
export function readsFromRecordedReads(recordedReads) {
  if (!(recordedReads instanceof Map)) throw new TypeError("recordedReads must be a Map");
  /** @type {LedgerRead[]} */
  const reads = [];
  for (const [path, content] of recordedReads) {
    if (typeof path !== "string" || path === "") {
      throw new TypeError("a recorded read's path must be a non-empty string");
    }
    if (typeof content !== "string") {
      throw new TypeError(`the recorded read of '${path}' must carry its captured content`);
    }
    reads.push({
      path: normaliseReadPath(path),
      startLine: 1,
      endLine: content.split("\n").length,
    });
  }
  return reads;
}

/**
 * The short reference a published finding's evidence line names: the
 * covering read's path and captured range, one line collapsed to a single
 * number. Ledger data only.
 *
 * @param {Provenance} provenance
 * @returns {string}
 */
export function evidenceRef(provenance) {
  const path = validatedProvenance(provenance).path;
  return provenance.startLine === provenance.endLine
    ? `${path}:${String(provenance.startLine)}`
    : `${path}:${String(provenance.startLine)}-${String(provenance.endLine)}`;
}

/**
 * Fail-closed ledger validation: every entry is checked, whether or not a
 * finding ever consults it — a malformed entry is a code bug, and a repair
 * guess here would invent evidence. Shared with the provenance gate, which
 * re-derives its verdicts from the same validated reads.
 *
 * @param {LedgerRead[]} ledger
 * @returns {LedgerRead[]}
 */
export function validatedLedger(ledger) {
  if (!Array.isArray(ledger)) throw new TypeError("the read ledger must be an array");
  return ledger.map((read, index) => {
    if (read === null || typeof read !== "object") {
      throw new TypeError(`ledger read ${String(index)} is not an object`);
    }
    const entry = /** @type {Record<string, unknown>} */ (read);
    const where = `ledger read ${String(index)}`;
    if (typeof entry["path"] !== "string" || entry["path"] === "") {
      throw new TypeError(`${where} has no path`);
    }
    if (!isLine(entry["startLine"]) || !isLine(entry["endLine"])) {
      throw new TypeError(`${where} has a non-integer or out-of-range line bound`);
    }
    const startLine = /** @type {number} */ (entry["startLine"]);
    const endLine = /** @type {number} */ (entry["endLine"]);
    if (startLine > endLine) {
      throw new TypeError(`${where} records an empty or inverted line range`);
    }
    return { path: normaliseReadPath(entry["path"]), startLine, endLine };
  });
}

/**
 * @param {Finding} finding
 * @returns {Finding}
 */
function validatedFinding(finding) {
  if (finding === null || typeof finding !== "object") {
    throw new TypeError("a finding is not an object");
  }
  const entry = /** @type {Record<string, unknown>} */ (finding);
  if (typeof entry["file"] !== "string" || entry["file"] === "") {
    throw new TypeError("a finding has no file");
  }
  if (!isLine(entry["line"]))
    throw new TypeError(`a finding for '${entry["file"]}' has no anchor line`);
  return /** @type {Finding} */ (finding);
}

/**
 * @param {Provenance} provenance
 * @returns {Provenance}
 */
function validatedProvenance(provenance) {
  if (provenance === null || typeof provenance !== "object") {
    throw new TypeError("provenance is not an object");
  }
  const entry = /** @type {Record<string, unknown>} */ (provenance);
  if (typeof entry["path"] !== "string" || entry["path"] === "") {
    throw new TypeError("provenance has no path");
  }
  if (!isLine(entry["startLine"]) || !isLine(entry["endLine"])) {
    throw new TypeError("provenance has a non-integer or out-of-range line bound");
  }
  return /** @type {Provenance} */ (provenance);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isLine(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
