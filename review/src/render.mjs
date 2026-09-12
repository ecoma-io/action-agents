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
 *
 * An architecture-aware run adds one code-owned section, rendered from the
 * same frozen section the artifact records — never from report bytes, never
 * from model text. A blind run renders none of it: the body is
 * byte-identical to a blind run's by the input's absence, not by a flag.
 */

import { sanitiseCommentText } from "#core/sanitise.mjs";

import { evidenceRef } from "./provenance.mjs";
/** @typedef {import("./answer.mjs").Finding} Finding */
/** @typedef {import("./verify.mjs").VerifiedFinding} VerifiedFinding */
/** @typedef {VerifiedFinding & { provenance?: Provenance, reconciliation?: import("./vocabulary.mjs").Reconciliation }} RenderableFinding */
/** @typedef {import("./provenance.mjs").Provenance} Provenance */

export const SUMMARY_CHARS = 300;
export const MESSAGE_CHARS = 1000;
/** How many identity items the comment's architecture section lists before the exact count takes over — the artifact keeps thirty-two, the workflow artifact keeps everything. */
export const ARCHITECTURE_LISTED_ITEMS = 5;

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
 * @property {number} [withheldUnspannedCount] findings withheld because their anchor line carries no span to certify — rendered beside the unanchored count when nothing published, under the same never-a-clean-bill law
 * @property {number} [withheldUnmatchedCount] findings withheld because their message's quoted evidence appears nowhere within the anchor window — rendered beside the other withheld counts when nothing published, under the same law
 * @property {import("#core/policy.mjs").PolicySource} [policySource] the resolved policy source — the comment's provenance line, so the verdict names the branch and commit that governed it
 * @property {readonly import("./reconcile.mjs").ReconciledFinding[]} [resolvedFindings] the previous run's findings this run retired — present only when the previous published record was recovered, which turns on the cross-run labels, the count line and the resolved section
 * @property {import("./artifact.mjs").ArchitectureSection} [architecture] the frozen architecture section — present only on an aware run; the body's architecture section renders from it and from nothing else
 * @property {string} [architectureNote] the cross-run waiver note, when both records carried architecture facts and one moved — an explicit note, never silent drift
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
  withheldUnspannedCount,
  withheldUnmatchedCount,
  policySource,
  resolvedFindings,
  architecture,
  architectureNote,
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

  if (architecture !== undefined) {
    lines.push(
      "",
      renderArchitectureCommentSection({ section: architecture, note: architectureNote }),
    );
  }

  if (findings.length === 0 && status === "Complete") {
    // A clean re-review must clear whatever an earlier push left behind.
    // "No findings." is for none at all: findings the run withheld — as
    // unanchored, as anchored on a line that certifies no span, or as
    // quoting evidence its anchor window does not carry — are counted,
    // never flattened into a clean bill.
    const unanchored = quarantinedCount ?? 0;
    const unspanned = withheldUnspannedCount ?? 0;
    const unmatched = withheldUnmatchedCount ?? 0;
    /** @type {Array<[number, (one: boolean) => string]>} */
    const kinds = [
      [
        unanchored,
        (one) => `no recorded read reaches ${one ? "its" : "their"} anchor line${one ? "" : "s"}`,
      ],
      [
        unspanned,
        (one) =>
          `${one ? "its" : "their"} anchor line${one ? "" : "s"} ${one ? "carries" : "carry"} no span to certify`,
      ],
      [
        unmatched,
        (one) => `${one ? "its" : "their"} quoted evidence is absent from the anchor window`,
      ],
    ];
    /** @type {string[]} */
    const clauses = [];
    for (const [count, reason] of kinds) {
      if (count === 0) continue;
      const one = count === 1;
      const lead =
        clauses.length === 0
          ? `${String(count)} ${one ? "finding" : "findings"} withheld: `
          : `${String(count)} more withheld: `;
      clauses.push(`${lead}${reason(one)}`);
    }
    if (clauses.length > 0) {
      lines.push("", `No published findings — ${clauses.join("; ")}.`);
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
 * The architecture section of the comment body — the frozen reader's facts,
 * rendered by code from the same `ArchitectureSection` the artifact records,
 * so the comment, the artifact and the run result name identical facts by
 * construction. Every displayed string is producer-derived evidence:
 * sanitised and capped here like any model text would be. The section
 * distinguishes every state of the design record's eleven-state matrix the
 * recorded facts can carry — the one pair no single envelope can (a hard
 * violation and an expired-waiver re-assertion ride the same non-waived
 * lane) is pinned there, and the comment renders it verbatim rather than
 * manufacturing a distinction. With an `unknown` verdict the detail lists
 * are withheld with the verdict — the counts stay, the details do not, and
 * nothing narrates an unestablished verdict as clean or violated.
 *
 * Recorded, never enforced: the closing line says it, no line here reads
 * like a review finding, and the section is deterministic given the section
 * object (I15) — the same bytes for the same facts, run after run.
 *
 * @param {object} input
 * @param {import("./artifact.mjs").ArchitectureSection} input.section the frozen section the artifact records
 * @param {string} [input.note] the cross-run waiver note, when the previous record's architecture facts moved
 * @returns {string}
 */
export function renderArchitectureCommentSection({ section, note }) {
  const counts = section.counts;
  /** @type {string[]} */
  const lines = ["### Architecture"];

  // The one loud signal: a law edit riding in with the pull request. It
  // leads the section, blockquoted, so no count line can bury it.
  if (section.policyChanged === true) {
    lines.push(
      "",
      "> ⚠️ The architecture policy changed between the compared sides — this verdict was judged under a moved law, not only a moved codebase.",
    );
  }

  lines.push(
    "",
    `Verdict \`${section.verdict}\` — ${String(counts.introduced)} introduced (${String(counts.introducedWaived)} waived), ${String(counts.resolved)} resolved, ${String(counts.unchanged)} unchanged.`,
  );

  if (section.verdict === "unknown") {
    lines.push(
      "",
      section.unknownReason === "stale"
        ? "The evidence is stale — it pins a head other than the one this review judged, so its verdict is withheld. The counts above describe the report's own head; the details are withheld with the verdict."
        : "The evidence is incomplete — no architecture verdict was established. The counts above describe a report that never concluded; the details are withheld with the verdict.",
    );
  } else {
    for (const item of section.introduced.slice(0, ARCHITECTURE_LISTED_ITEMS)) {
      /** @type {string[]} */
      const tails = [`${String(item.headCount)} ${item.headCount === 1 ? "site" : "sites"}`];
      if (item.waived) tails.push("waived");
      if (item.decisionRef !== null)
        tails.push(`decision ${archFact(item.decisionRef, SUMMARY_CHARS)}`);
      lines.push(
        `- ${archFact(item.messageId, MESSAGE_CHARS)}: ${archFact(item.sourceProject, MESSAGE_CHARS)} → ${archFact(item.target, MESSAGE_CHARS)} — ${tails.join(", ")}`,
      );
    }
    const moreIntroduced =
      counts.introduced - Math.min(section.introduced.length, ARCHITECTURE_LISTED_ITEMS);
    if (moreIntroduced > 0) lines.push(`- and ${String(moreIntroduced)} more`);

    if (section.resolved.length > 0) {
      const shown = section.resolved
        .slice(0, ARCHITECTURE_LISTED_ITEMS)
        .map(
          (item) =>
            `${archFact(item.messageId, MESSAGE_CHARS)}: ${archFact(item.sourceProject, MESSAGE_CHARS)} → ${archFact(item.target, MESSAGE_CHARS)}`,
        );
      const moreResolved = counts.resolved - shown.length;
      lines.push(
        "",
        `Resolved: ${shown.join("; ")}${moreResolved > 0 ? `; and ${String(moreResolved)} more` : ""}.`,
      );
    }

    if (section.renamePairs.length > 0) {
      const shown = section.renamePairs
        .slice(0, ARCHITECTURE_LISTED_ITEMS)
        .map(
          (pair) => `${archFact(pair.from, MESSAGE_CHARS)} → ${archFact(pair.to, MESSAGE_CHARS)}`,
        );
      const moreRenamed = section.renamePairs.length - shown.length;
      lines.push(
        "",
        `Renamed: ${shown.join("; ")}${moreRenamed > 0 ? `; and ${String(moreRenamed)} more` : ""} — each is one move, never an introduced/resolved wash.`,
      );
    }

    if (section.customRules !== null) {
      const findings = section.customRules.findings;
      if (
        findings.introduced.count > 0 ||
        findings.resolved.count > 0 ||
        findings.unchanged.count > 0 ||
        findings.unknown.count > 0
      ) {
        lines.push(
          "",
          `Custom rules: ${customBucket(findings.introduced)} introduced, ${customBucket(findings.resolved)} resolved, ${customBucket(findings.unchanged)} unchanged, ${customBucket(findings.unknown)} unknown.`,
        );
      }
    }

    if (section.occurrencesReduced > 0) {
      lines.push(
        "",
        `Shrinking: ${String(section.occurrencesReduced)} unchanged ${section.occurrencesReduced === 1 ? "entry" : "entries"} lost occurrences without resolving.`,
      );
    }

    /** @type {Array<[string, number]>} */
    const unresolvableBuckets = [
      ["introduced", counts.unresolvable.introduced],
      ["resolved", counts.unresolvable.resolved],
      ["unchanged", counts.unresolvable.unchanged],
      ["unknown", counts.unresolvable.unknown],
    ];
    const unresolvable = unresolvableBuckets.filter(([, count]) => count > 0);
    if (unresolvable.length > 0) {
      const parts = unresolvable
        .map(([name, count]) => `${String(count)} ${String(name)}`)
        .join(", ");
      lines.push("", `Unresolvable: ${parts} — counted, never guessed into a bucket.`);
    }
  }

  const coverage = section.coverage;
  lines.push(
    "",
    `Coverage: ${coverage.complete ? "complete" : "incomplete"} — ${String(coverage.analyzedFiles)} analyzed, ${String(coverage.notAnalyzedCount)} not analyzed, ${String(coverage.blindSpotCount)} blind spots.`,
  );

  lines.push(
    "",
    `Basis: report ${shortFact(section.reportDigest)}, head ${shortFact(section.provenance.head.commit)}, base ${shortFact(section.provenance.base.commit)}, policy fingerprints ${shortFact(section.policyFingerprints.head)}/${shortFact(section.policyFingerprints.base)}, Archkeep ${section.toolVersion === null ? "(version unknown)" : archFact(section.toolVersion, SUMMARY_CHARS)}.`,
  );

  if (note !== undefined) {
    lines.push("", `> Since the previous review: ${sanitised(note, SUMMARY_CHARS)}.`);
  }

  lines.push(
    "",
    "Architecture facts are recorded, never enforced — they are not review findings; enforcement stays the consumer's gate.",
  );

  return lines.join("\n");
}

/**
 * One producer-derived architecture fact, sanitised and capped for display —
 * the section already flattened and capped it; this copy only survives the
 * comment's own channel. A null records as the honest `(unnamed)`.
 *
 * @param {string | null} value
 * @param {number} maxChars
 * @returns {string}
 */
function archFact(value, maxChars) {
  return sanitised(value ?? "(unnamed)", maxChars);
}

/**
 * One digest-shaped fact for display — the first twelve characters stand for
 * the whole, the ellipsis says so, and an absent value names itself.
 *
 * @param {string | null} value
 * @returns {string}
 */
function shortFact(value) {
  if (value === null) return "(none)";
  return `${value.slice(0, 12)}…`;
}

/**
 * One custom-rule bucket for display — the exact count, with the capped rule
 * id list beside it only when the bucket holds anything.
 *
 * @param {{ count: number, ruleIds: string[] }} bucket
 * @returns {string}
 */
function customBucket(bucket) {
  if (bucket.count === 0) return "0";
  const ids = bucket.ruleIds.map((rule) => archFact(rule, SUMMARY_CHARS)).join(", ");
  return `${String(bucket.count)} (${ids})`;
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
