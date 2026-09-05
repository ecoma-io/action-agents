/**
 * The comment's body — rendered by code, from validated data. The model
 * wrote none of the structure: statuses, sections, ordering and anchors are
 * decided here, deterministically, so two runs over one answer produce byte-
 * identical bodies.
 *
 * Everything model-supplied passes the sanitiser before it lands here;
 * inventory-derived paths get their own defanging, because filenames are
 * chosen on the attacking branch just as much as messages are. Backticks,
 * angle brackets and HTML-comment delimiters are stripped from the displayed
 * path — matching happened on the exact name; rendering happens on the
 * defanged copy.
 *
 * The one cross-run decoration is code-owned too: when the previous
 * published record was recovered from the thread's marker comment, every
 * finding carries its reconciliation label (`[new]`, `[persisting]`,
 * `[moved]`), a count line compares the two runs, and a section lists what
 * resolved — prose only, never a consequence (ADR 004 decision 3). Without
 * a recovered record the body renders exactly as a first run always has.
 */

import { sanitiseCommentText } from "#core/sanitise.mjs";

import { evidenceRef } from "./provenance.mjs";
/** @typedef {import("./answer.mjs").Finding} Finding */
/** @typedef {import("./verify.mjs").VerifiedFinding} VerifiedFinding */
/** @typedef {VerifiedFinding & { provenance?: Provenance, reconciliation?: import("./vocabulary.mjs").Reconciliation }} RenderableFinding */
/** @typedef {import("./provenance.mjs").Provenance} Provenance */

export const SUMMARY_CHARS = 300;
export const MESSAGE_CHARS = 1000;

/**
 * @typedef {object} RenderInput
 * @property {"Complete" | "Partial"} status
 * @property {string} headSha the reviewed head, full 40 hex chars
 * @property {string} summary
 * @property {RenderableFinding[]} findings already validated, ordered, capped — each carrying its verification state iff the pass scheduled it
 * @property {import("./config.mjs").Strictness} strictness decides collapsing, never inclusion — filtering happened earlier
 * @property {string} [partialReason] required when status is Partial
 * @property {import("./coverage.mjs").CoverageReport} [coverage] the deterministic read-coverage report; rendered as a count line when the expected set is non-empty
 * @property {number} [quarantinedCount] findings withheld as unanchored before publication — rendered when nothing published, so a withheld review never reads as clean
 * @property {import("#core/policy.mjs").PolicySource} [policySource] the resolved policy source — the comment's provenance line, so the verdict names the branch and commit that governed it
 * @property {readonly import("./reconcile.mjs").ReconciledFinding[]} [resolvedFindings] the previous run's findings this run retired — present only when the previous published record was recovered, which turns on the cross-run labels, the count line and the resolved section
 */

/**
 * @param {RenderInput} input
 * @returns {string}
 */
export function renderComment({
  status,
  headSha,
  summary,
  findings,
  strictness,
  partialReason,
  coverage,
  quarantinedCount,
  policySource,
  resolvedFindings,
}) {
  /** @type {string[]} */
  const lines = [];
  if (status === "Partial") {
    lines.push(
      `> ⚠️ This review is partial: ${sanitised(partialReason ?? "a reading bound fired", 300)}`,
      "",
    );
  }
  const header = [`**Review** — ${status}`, `Reviewed head \`${headSha}\``];
  if (policySource !== undefined) {
    header.push(
      `Policy source \`${defang(policySource.branch)}\` at \`${policySource.sha}\` (${policySource.basis})`,
    );
  }
  lines.push(...header, "");
  lines.push(sanitised(summary === "" ? "(no summary)" : summary, SUMMARY_CHARS));

  if (resolvedFindings !== undefined) {
    const persisting = findings.filter((finding) => finding.reconciliation === "persisting").length;
    const moved = findings.filter((finding) => finding.reconciliation === "moved").length;
    const fresh = findings.filter((finding) => finding.reconciliation === "new").length;
    const resolved = resolvedFindings.filter(
      (finding) => finding.reconciliation === "resolved",
    ).length;
    /** @type {Array<[import("./vocabulary.mjs").Reconciliation, number]>} */
    const compared = [
      ["persisting", persisting],
      ["moved", moved],
      ["new", fresh],
      ["resolved", resolved],
    ];
    const parts = compared
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${String(count)} ${label}`);
    if (parts.length > 0) {
      lines.push("", `Compared with the previous review: ${parts.join(", ")}.`);
    }
  }

  if (coverage !== undefined && coverage.total > 0) {
    // Numbers only — no paths, so nothing to defang or sanitise.
    lines.push(
      "",
      `Changed files examined: ${String(coverage.covered.length)}/${String(coverage.total)}.`,
    );
  }

  if (findings.length === 0 && status === "Complete") {
    // A clean re-review must clear whatever an earlier push left behind.
    // "No findings." is for none at all: findings the run withheld as
    // unanchored are counted, never flattened into a clean bill.
    if (quarantinedCount !== undefined && quarantinedCount > 0) {
      const one = quarantinedCount === 1;
      lines.push(
        "",
        `No published findings — ${String(quarantinedCount)} ${one ? "finding" : "findings"} withheld: ` +
          `no recorded read reaches ${one ? "its" : "their"} anchor line${one ? "" : "s"}.`,
      );
    } else {
      lines.push("", "No findings.");
    }
  }
  const concerns = findings.filter(
    (finding) => finding.severity === "concern" && finding.lifecycle !== "refuted",
  );
  const nits = findings.filter(
    (finding) => finding.severity === "nit" && finding.lifecycle !== "refuted",
  );

  if (concerns.length > 0) {
    lines.push("", `### Concerns (${String(concerns.length)})`, "");
    for (const finding of concerns) lines.push(listingOf(finding));
  }

  if (nits.length > 0 && strictness !== "low") {
    const collapse = strictness === "medium";
    if (collapse) {
      // One click away, individually anchored — collapsed, not hidden.
      lines.push("", `<details>`, `<summary>Nits (${String(nits.length)})</summary>`, "");
      for (const finding of nits) lines.push(listingOf(finding));
      lines.push("", `</details>`);
    } else {
      lines.push("", `### Nits (${String(nits.length)})`, "");
      for (const finding of nits) lines.push(listingOf(finding));
    }
  }
  const refuted = findings.filter((finding) => finding.lifecycle === "refuted");
  if (refuted.length > 0) {
    lines.push("", `### Refuted during verification (${String(refuted.length)})`, "");
    for (const finding of refuted) lines.push(listingOf(finding));
  }
  const retired = (resolvedFindings ?? []).filter(
    (finding) => finding.reconciliation === "resolved",
  );
  if (retired.length > 0) {
    lines.push("", `### Resolved since the last review (${String(retired.length)})`, "");
    for (const finding of retired) lines.push(resolvedListing(finding));
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

/**
 * The nothing-to-review body for a pull request whose universe emptied.
 *
 * @param {string} headSha
 * @returns {string}
 */
export function renderNothingToReview(headSha) {
  return [
    "**Review** — Nothing to review",
    `Reviewed head \`${headSha}\``,
    "",
    "Every changed file is outside this review's universe: ignored by config, or gone.",
    "",
  ].join("\n");
}

/**
 * One finding's listing. An anchored finding carries its provenance as
 * metadata and gains one short evidence line beneath — the covering read
 * the loop recorded, ledger data only, never model-composed text. A finding
 * the pass resolved to a non-confirmed state gains one state line beneath:
 * `unverified:` with why the pass could not decide, or `refuted:` with why
 * the verifier contradicted the claim — code-owned labels around a
 * sanitised reason, never the model's framing. A confirmed or unscheduled
 * finding renders exactly as it always did. When the run reconciles against
 * a recovered previous record, the first line ends in the code-owned
 * cross-run label — `[new]`, `[persisting]` or `[moved]`.
 *
 * @param {RenderableFinding} finding
 */
function listingOf(finding) {
  const label = finding.reconciliation === undefined ? "" : ` [${finding.reconciliation}]`;
  const listing = `- \`${defang(finding.file)}:${String(finding.line)}\` — ${sanitised(finding.message, MESSAGE_CHARS)}${label}`;
  const evidence =
    finding.provenance === undefined
      ? listing
      : `${listing}\n  evidence: \`${defang(evidenceRef(finding.provenance))}\``;
  if (finding.lifecycle === "unresolved") {
    return `${evidence}\n  unverified: ${sanitised(finding.reason ?? "", MESSAGE_CHARS)}`;
  }
  if (finding.lifecycle === "refuted") {
    return `${evidence}\n  refuted: ${sanitised(finding.reason ?? "", MESSAGE_CHARS)}`;
  }
  return evidence;
}

/**
 * One resolved finding's listing — the previous run's anchor and its claim,
 * the anchor this run no longer holds. The previous lifecycle is
 * deliberately ignored: a finding the last run could not verify still
 * resolved when its identity is gone.
 *
 * @param {import("./reconcile.mjs").ReconciledFinding} finding
 * @returns {string}
 */
function resolvedListing(finding) {
  return `- \`${defang(finding.file)}:${String(finding.line)}\` — ${sanitised(finding.message, MESSAGE_CHARS)}`;
}

/**
 * Structural characters out of displayed paths. The exact name did the
 * matching; this copy does the rendering.
 *
 * @param {string} path
 * @returns {string}
 */
function defang(path) {
  return (
    path
      .replace(/`/g, "'")
      .replace(/<!--/g, "<-")
      // Browsers close comments on --!> as well as -->; both closers go, so
      // no displayed path can end a comment anywhere.
      .replace(/--!?>/g, "->")
      .replace(/</g, "&lt;")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "")
  );
}

/**
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function sanitised(text, maxChars) {
  const { text: clean } = sanitiseCommentText(text, { maxChars });
  // A sanitiser note about removed markers is information for a log line,
  // not for a rendered comment body; the notes are dropped here on purpose.
  return clean.replace(/\n+/g, " ").trim();
}
