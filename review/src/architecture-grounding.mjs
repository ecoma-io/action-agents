/**
 * Architecture grounding — the frozen evidence `core/architecture.mjs`
 * holds, turned into what a review run can act on. Three code-owned
 * derivations, and nothing the model has any hand in:
 *
 * 1. The prompt section — the delta's recorded facts rendered as one
 *    code-built text block, reduced deterministically to a byte budget a
 *    weak model can carry (§6.6: 8 KiB; raw envelopes run 20–138 KB, so the
 *    reduction is mandatory, never optional). Every fact is flattened and
 *    capped before it lands: report bytes are untrusted evidence, and a
 *    note that could forge this section's line structure would be evidence
 *    instructing, not describing.
 * 2. The ADR context — the `decisionRef` a constraint row names, resolved
 *    against `docs/adr/<id>.md` read at the pinned base SHA through the
 *    policy forge. A pull request cannot edit the ADRs that interpret its
 *    law, so the base pin is what makes "intentional evolution" a fact the
 *    reviewer can check rather than a claim the diff can make. An absent
 *    file is rendered as absent — never guessed, never passed.
 * 3. The risk floors — files named in introduced-violation head sites get
 *    a deterministic risk floor and the deep lane that follows from it,
 *    through `classifyRisk`'s declared second seam. The floor is a reading
 *    assignment, never a verdict: architecture violations stay outside the
 *    finding vocabulary, the SARIF projection and every gate this phase
 *    (records-never-enforces), and deep lanes consume reading budget like
 *    any lane — the bound gate is not bypassed by grounding.
 *
 * Interpretation lives here and nowhere else upstream: the
 * messageId→criticality table is review-owned (a boundary breach is review
 * judgement, not a reader fact — `core/` carries severity nowhere), frozen,
 * total over Archkeep's published ids, with an explicit unmapped default so
 * a newer producer's id grounds attention rather than silently passing.
 *
 * Everything here is additive-when-present. A run without architecture
 * evidence calls none of it, and its prompt, comment and artifact bytes are
 * identical to a run that never heard of Archkeep — the campaign's
 * architecture-blind exit criterion, pinned by tests at every layer.
 */

import { utf8Compare } from "./order.mjs";
import { normalise } from "./risk.mjs";

/** @typedef {import("#core/architecture.mjs").ArchitectureEvidence} ArchitectureEvidence */
/** @typedef {import("#core/architecture.mjs").EvidenceItem} EvidenceItem */
/** @typedef {import("./risk.mjs").RiskLevel} RiskLevel */

/**
 * The whole architecture section a prompt may carry, in UTF-8 bytes (§6.6).
 * The wrapper's 64 KiB block cap stays the universal ceiling; this is the
 * architecture evidence's tighter one, and the renderer guarantees it by
 * construction — per-fact caps first, a budget-split ADR block second, a
 * hard final cut last. A constant, not a knob: an input that could raise it
 * would make the weak-model budget a preference.
 *
 * @type {number}
 */
export const MAX_ARCHITECTURE_PROMPT_BYTES = 8 * 2 ** 10;

/** How many introduced or resolved items the section lists before naming the cut. */
const MAX_ITEMS_LISTED = 8;

/** How many rename pairs and shrinking-debt notes the section lists. */
const MAX_MOVES_LISTED = 4;

/** How many head sites one listed item shows. */
const MAX_SITES_SHOWN = 2;

/** How many distinct decision refs one run resolves and reads. */
export const MAX_ADR_REFS = 3;

/** The most ADR text one excerpt carries — the per-ref ceiling before budget split. */
export const MAX_ADR_EXCERPT_BYTES = 1536;

/** Below this per-ref share the excerpt is dropped for budget, not starved to noise. */
const MIN_ADR_EXCERPT_BYTES = 256;

/** Headroom for a truncation marker so a capped arm can never overshoot the budget. */
const MARKER_ALLOWANCE = 160;

/**
 * The frozen messageId→criticality table — review's own interpretation of
 * Archkeep's violation vocabulary, keyed on the ids the producer publishes
 * (the fifteen boundary ids, the four go-work drift ids, the tsconfig-paths
 * id). Two judgements, one line each: the declared constraint law firing
 * (`*ConstraintViolation`, the banned-import rows) or resolution itself
 * corrupt (a cycle, a phantom dependency, an alias that no longer lands on
 * workspace source) is `critical`; structural discipline and dev/CI
 * divergence are `high`. The table is total over the ids this pin knows and
 * frozen — widening it is a reviewed decision, not a config file.
 *
 * @type {Readonly<Record<string, RiskLevel>>}
 */
export const ARCHITECTURE_CRITICALITY = Object.freeze({
  // The governance law table itself fired, or the dependency graph is corrupt.
  onlyTagsConstraintViolation: "critical",
  notTagsConstraintViolation: "critical",
  emptyOnlyTagsConstraintViolation: "critical",
  projectWithoutTagsCannotHaveDependencies: "critical",
  bannedExternalImportsViolation: "critical",
  nestedBannedExternalImportsViolation: "critical",
  noCircularDependencies: "critical",
  noTransitiveDependencies: "critical",
  tsconfigDeadPathAlias: "critical",
  // Structural discipline slips and dev/CI divergence: real, more local.
  noRelativeOrAbsoluteImportsAcrossLibraries: "high",
  noRelativeOrAbsoluteExternals: "high",
  noSelfCircularDependencies: "high",
  noImportsOfApps: "high",
  noImportsOfE2e: "high",
  noImportOfNonBuildableLibraries: "high",
  noImportsOfLazyLoadedLibraries: "high",
  goWorkMissingUse: "high",
  goWorkStaleUse: "high",
  goWorkUnmodeledUse: "high",
  goWorkOutsideUse: "high",
});

/**
 * The criticality an unmapped messageId grounds at — explicit so a newer
 * Archkeep id is visible in the risk table as `high`, never silently `low`.
 *
 * @type {RiskLevel}
 */
export const UNMAPPED_ARCHITECTURE_CRITICALITY = "high";

/** The risk order the floor comparison reads — one meaning of "maximum". */
const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * The ADR id shape this resolver reads: three or more digits, then
 * dash-separated alphanumeric slug segments — exactly the stem Archkeep's
 * registry names its files by under the consumer's `docs/adr/` directory
 * (`0009-share-through-facades` is the shape in one sentence).
 * A `decisionRef` outside this shape is untrusted data naming no file this
 * run will open: it renders as unread, and cannot steer the read anywhere.
 */
const ADR_ID = /^[0-9]{3,}(?:-[A-Za-z0-9]+)*$/;

/** The longest ADR id this resolver will even test. */
const MAX_ADR_ID_LENGTH = 100;

/**
 * What one decision ref resolved to.
 *
 * @typedef {object} AdrResolution
 * @property {"found" | "absent" | "unread"} status
 * @property {string | null} excerpt the capped, frontmatter-stripped body when found, null otherwise
 */

/**
 * The distinct decision refs the evidence's introduced items name — the
 * constraints a reviewer could reach an ADR behind — sorted byte-wise and
 * capped, with the count of what the cap dropped. Only introduced items
 * contribute: an ADR behind a resolved or unchanged violation explains debt
 * this change did not touch, and the whole registry is not the prompt's to
 * carry.
 *
 * @param {ArchitectureEvidence} evidence
 * @returns {{ refs: string[], omitted: number }}
 */
export function collectDecisionRefs(evidence) {
  /** @type {Set<string>} */
  const refs = new Set();
  for (const item of evidence.introduced) {
    const ref = item.constraint?.decisionRef;
    if (typeof ref === "string" && ref !== "") refs.add(ref);
  }
  const sorted = [...refs].sort(utf8Compare);
  return {
    refs: sorted.slice(0, MAX_ADR_REFS),
    omitted: Math.max(0, sorted.length - MAX_ADR_REFS),
  };
}

/**
 * Resolves each decision ref against the ADR it names, read through the
 * pinned policy reader — `(path) => forge.getContents(path, { ref: base })`,
 * the same seam every policy document rides. The read answers three ways:
 *
 * - `found` — the file's body, frontmatter stripped and capped. ADR bytes
 *   are maintainer-set configuration at an immutable commit — the same
 *   trust as an instruction document — so the excerpt keeps its line
 *   structure; only its length is bounded.
 * - `absent` — the pinned base holds no such ADR. Rendered as absent;
 *   intentional evolution is a claim the diff makes without its record.
 * - `unread` — the ref is not an ADR id shape. Nothing is opened; the id
 *   renders defanged and unexplained.
 *
 * A reader that throws (transport, permissions) is an honest infrastructure
 * failure and propagates: the run ends red as `failed`, the same law every
 * policy read already follows. Absence is a fact; a broken read is not.
 *
 * @param {object} input
 * @param {(path: string) => Promise<{ content: string } | null>} input.reader the pinned policy read
 * @param {readonly string[]} input.refs the refs to resolve, in display order
 * @returns {Promise<Map<string, AdrResolution>>}
 */
export async function resolveAdrContext({ reader, refs }) {
  /** @type {Map<string, AdrResolution>} */
  const resolved = new Map();
  for (const ref of refs) {
    if (ref.length > MAX_ADR_ID_LENGTH || !ADR_ID.test(ref)) {
      resolved.set(ref, { status: "unread", excerpt: null });
      continue;
    }
    const file = await reader(`docs/adr/${ref}.md`);
    if (file === null) {
      resolved.set(ref, { status: "absent", excerpt: null });
      continue;
    }
    resolved.set(ref, { status: "found", excerpt: adrExcerpt(file.content) });
  }
  return resolved;
}

/**
 * One ADR file's excerpt: the frontmatter block dropped (status and date
 * are registry bookkeeping, not the decision), the body capped to
 * {@link MAX_ADR_EXCERPT_BYTES} on whole code points with the cut marked.
 *
 * @param {string} text the file's bytes as read
 * @returns {string}
 */
export function adrExcerpt(text) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return capWithMarker(body, MAX_ADR_EXCERPT_BYTES, "adr excerpt");
}

/**
 * The risk floors architecture evidence grounds: every file named in an
 * introduced item's head sites (waived introductions included — accepted
 * debt this change grows still deserves the reading), every rename pair's
 * introduced side, and every custom-rule finding's head site (waiverless by
 * construction), floored at the criticality the table maps the violation
 * to. Paths are normalised exactly as the classifier normalises the names
 * it tests, so the floor meets its file and nothing else: a path the diff
 * does not contain grounds nothing.
 *
 * @param {ArchitectureEvidence} evidence
 * @returns {ReadonlyMap<string, RiskLevel>} normalised path → floor
 */
export function architectureRiskFloors(evidence) {
  /** @type {Map<string, RiskLevel>} */
  const floors = new Map();
  /**
   * @param {readonly import("#core/architecture.mjs").EvidenceSite[]} sites
   * @param {RiskLevel} level
   */
  const ground = (sites, level) => {
    for (const site of sites) {
      const path = normalise(site.file);
      if (path === "") continue;
      if (RISK_RANK[level] > RISK_RANK[floors.get(path) ?? "low"]) floors.set(path, level);
    }
  };
  for (const item of evidence.introduced) {
    ground(item.headSites, criticalityOf(item.messageId));
  }
  for (const pair of evidence.renamePairs) {
    ground(pair.introduced.headSites, criticalityOf(pair.introduced.messageId));
  }
  if (evidence.customRules !== null) {
    // A custom finding carries no messageId in the boundary vocabulary, so
    // it grounds at the explicit default — attention, never a verdict.
    ground(evidence.customRules.findings.introduced.sites, UNMAPPED_ARCHITECTURE_CRITICALITY);
  }
  return floors;
}

/**
 * The table lookup with its explicit default.
 *
 * @param {string | null} messageId
 * @returns {RiskLevel}
 */
function criticalityOf(messageId) {
  if (messageId === null) return UNMAPPED_ARCHITECTURE_CRITICALITY;
  return ARCHITECTURE_CRITICALITY[messageId] ?? UNMAPPED_ARCHITECTURE_CRITICALITY;
}

// ── The prompt section ─────────────────────────────────────────────────────

/**
 * Renders the architecture evidence as the one text block the prompt
 * carries, deterministically reduced to {@link MAX_ARCHITECTURE_PROMPT_BYTES}
 * bytes. The same evidence and the same ADR resolutions always render the
 * same bytes: no clock, no randomness, caps in fixed priority order, the
 * ADR block spending whatever budget the facts left behind.
 *
 * The shape, top to bottom: the verdict and the pin; `policyChanged`
 * promoted to its own line when true (a law that moved between base and
 * head re-frames every fact below it — it is not a footnote); the buckets
 * (introduced with waiver disclosure, resolved, renames as one move each,
 * shrinking debt, custom findings, unattributed counts); coverage; and the
 * ADR block. An `unknown` verdict renders the withholding block instead of
 * the buckets — stale or incomplete bytes describe a head this run is not
 * reviewing, and the one thing they must never become is a clean bill the
 * model leans on.
 *
 * @param {ArchitectureEvidence} evidence
 * @param {ReadonlyMap<string, AdrResolution> | null} adr the resolved decision refs, null when none were collected
 * @param {number} [omittedRefs] how many decision refs the cap dropped, 0 when none
 * @returns {string} at most {@link MAX_ARCHITECTURE_PROMPT_BYTES} UTF-8 bytes
 */
export function renderArchitectureSection(evidence, adr, omittedRefs = 0) {
  /** @type {string[]} */
  const lines = [];
  lines.push(
    `Architecture evidence — code-built from the pinned Archkeep delta; verdict: ${evidence.verdict}` +
      `${evidence.stale ? " (stale)" : ""}.`,
  );
  lines.push(pinLine(evidence));
  if (evidence.policyChanged === true) {
    lines.push(
      "POLICY CHANGED between base and head — the fingerprints differ: the facts below may reflect " +
        "the new law, not new damage. Weigh them as that.",
    );
  }
  if (evidence.verdict === "unknown") {
    lines.push(
      evidence.incompleteness === null
        ? "Architecture was not established for this head."
        : `${evidence.incompleteness.reason}: ${flat(evidence.incompleteness.note, 240)}`,
    );
    lines.push(
      "Treat architecture as unreviewed: do not narrate it as clean or as violated, and let findings " +
        "stand on the diff alone.",
    );
  } else {
    lines.push(...introducedLines(evidence));
    lines.push(...resolvedLines(evidence));
    lines.push(...renameLines(evidence));
    lines.push(...shrinkingLines(evidence));
    lines.push(...customLines(evidence));
    lines.push(...unresolvableLine(evidence));
  }
  lines.push(coverageLine(evidence));
  const core = lines.filter((line) => line !== "").join("\n");

  const adrBlock =
    adr === null || (adr.size === 0 && omittedRefs === 0)
      ? ""
      : renderAdrBlock(adr, omittedRefs, MAX_ARCHITECTURE_PROMPT_BYTES - byteLength(core));
  return capWithMarker(
    adrBlock === "" ? core : `${core}\n${adrBlock}`,
    MAX_ARCHITECTURE_PROMPT_BYTES,
    "architecture",
  );
}

/**
 * The pin line — both provenance commits, the tool, the policy-change fact
 * and the coverage headline in one deterministic line.
 *
 * @param {ArchitectureEvidence} evidence
 * @returns {string}
 */
function pinLine(evidence) {
  const head = evidence.provenance.head.commit;
  const base = evidence.provenance.base.commit;
  const parts = [
    `Compared ${base === null ? "(no base commit)" : base} → ${head === null ? "(no head commit)" : head}`,
    `tool ${evidence.toolVersion ?? "(unrecorded)"}`,
    `policy changed: ${evidence.policyChanged === null ? "not assessed" : evidence.policyChanged ? "yes" : "no"}`,
  ];
  return parts.join("; ").concat(".");
}

/**
 * @param {ArchitectureEvidence} evidence
 * @returns {string[]}
 */
function introducedLines(evidence) {
  const total = evidence.introduced.length;
  if (total === 0) return ["Introduced violations: none."];
  const waived = evidence.introducedWaived;
  const header =
    `Introduced violations: ${String(total)}` +
    (waived > 0
      ? ` (${String(waived)} waived — accepted debt this change grows, marked below)`
      : "") +
    ":";
  const listed = evidence.introduced.slice(0, MAX_ITEMS_LISTED);
  const out = [header, ...listed.map((item) => introducedLine(item))];
  if (total > listed.length) {
    out.push(
      `(+${String(total - listed.length)} more omitted — the full detail list lives in the architecture ` +
        "workflow artifact, not the prompt.)",
    );
  }
  return out;
}

/**
 * One introduced item: identity, both counts, a site sample, and the waiver
 * row's law-time fields verbatim when the item rides the waived lane.
 *
 * @param {EvidenceItem} item
 * @returns {string}
 */
function introducedLine(item) {
  const id = item.messageId === null ? "(no rule id)" : flat(item.messageId, 120);
  const from = item.sourceProject === null ? "(unknown source)" : flat(item.sourceProject, 160);
  const to = item.target === null ? "(unknown target)" : flat(item.target, 240);
  const counts = `head ${String(item.headCount)}, was ${String(item.baseCount)} at base`;
  const shown = item.headSites.slice(0, MAX_SITES_SHOWN);
  const sites =
    shown.length === 0
      ? ""
      : ` — sites: ${shown.map((site) => `${flat(site.file)}:${String(site.line)}`).join(", ")}` +
        (item.headCount > shown.length ? ` (+${String(item.headCount - shown.length)} more)` : "");
  const waiver = item.waived
    ? item.waivedBy === null
      ? " — WAIVED (no suppression row recorded)"
      : ` — WAIVED: ${item.waivedBy.reason === null ? "no reason recorded" : flat(item.waivedBy.reason, 160)}` +
        (item.waivedBy.expiresAt === null
          ? " (no expiry)"
          : ` (expires ${flat(item.waivedBy.expiresAt, 40)})`)
    : "";
  return `- ${id} — ${from} → ${to} — ${counts}${sites}${waiver}`;
}

/**
 * @param {ArchitectureEvidence} evidence
 * @returns {string[]}
 */
function resolvedLines(evidence) {
  const total = evidence.resolved.length;
  if (total === 0) return [];
  const listed = evidence.resolved.slice(0, MAX_ITEMS_LISTED);
  const out = [
    `Resolved since base: ${String(total)}${total > listed.length ? ` (first ${String(listed.length)} listed)` : ""}:`,
    ...listed.map(
      (item) =>
        `- ${item.messageId === null ? "(no rule id)" : flat(item.messageId, 120)} — ` +
        `${item.sourceProject === null ? "(unknown source)" : flat(item.sourceProject, 160)} → ` +
        `${item.target === null ? "(unknown target)" : flat(item.target, 240)} — gone at head`,
    ),
  ];
  return out;
}

/**
 * The rename pairs — each rendered as ONE item, because a move that the raw
 * buckets state as "1 introduced, 1 resolved" is exactly the wash this fact
 * exists to prevent. Both sides stay in the recorded buckets; only the
 * rendering pairs them.
 *
 * @param {ArchitectureEvidence} evidence
 * @returns {string[]}
 */
function renameLines(evidence) {
  if (evidence.renamePairs.length === 0) return [];
  const listed = evidence.renamePairs.slice(0, MAX_MOVES_LISTED);
  const out = [
    `Rename — one move, not a wash: ${String(evidence.renamePairs.length)}${evidence.renamePairs.length > listed.length ? ` (first ${String(listed.length)} listed)` : ""}:`,
  ];
  for (const pair of listed) {
    const id = pair.introduced.messageId ?? "(no rule id)";
    const moved =
      pair.introduced.sourceProject !== pair.resolved.sourceProject
        ? `project ${flat(pair.resolved.sourceProject, 160)} → ${flat(pair.introduced.sourceProject, 160)} (target ${flat(pair.introduced.target, 240)})`
        : `target ${flat(pair.resolved.target, 240)} → ${flat(pair.introduced.target, 240)} (project ${flat(pair.introduced.sourceProject, 160)})`;
    out.push(
      `- ${flat(id, 120)} — ${moved}; ${String(pair.introduced.headCount)} site(s) moved verbatim`,
    );
  }
  return out;
}

/**
 * @param {ArchitectureEvidence} evidence
 * @returns {string[]}
 */
function shrinkingLines(evidence) {
  if (evidence.occurrencesReduced.length === 0) return [];
  const listed = evidence.occurrencesReduced.slice(0, MAX_MOVES_LISTED);
  const out = [
    `Shrinking — improvement, not resolved: ${String(evidence.occurrencesReduced.length)}${evidence.occurrencesReduced.length > listed.length ? ` (first ${String(listed.length)} listed)` : ""}:`,
    ...listed.map(
      (note) =>
        `- ${note.messageId === null ? "(no rule id)" : flat(note.messageId, 120)} — ` +
        `${note.sourceProject === null ? "(unknown source)" : flat(note.sourceProject, 160)} → ` +
        `${note.target === null ? "(unknown target)" : flat(note.target, 240)}: ${flat(note.note, 200)}`,
    ),
  ];
  return out;
}

/**
 * @param {ArchitectureEvidence} evidence
 * @returns {string[]}
 */
function customLines(evidence) {
  const custom = evidence.customRules;
  if (custom === null) return [];
  const bucket = custom.findings.introduced;
  if (bucket.count === 0 && bucket.sites.length === 0) return [];
  const ids = bucket.ruleIds
    .slice(0, 4)
    .map((id) => flat(id, 120))
    .join(", ");
  const sites = bucket.sites
    .slice(0, MAX_SITES_SHOWN)
    .map((site) => `${flat(site.file)}:${String(site.line)}`)
    .join(", ");
  return [
    `Custom rule findings introduced: ${String(bucket.count)}` +
      (ids === "" ? "" : ` (rule ids: ${ids})`) +
      (sites === "" ? "" : ` — first sites: ${sites}`) +
      ".",
  ];
}

/**
 * @param {ArchitectureEvidence} evidence
 * @returns {string[]}
 */
function unresolvableLine(evidence) {
  const { introduced, resolved, unchanged, unknown } = evidence.unresolvable;
  if (introduced + resolved + unchanged + unknown === 0) return [];
  return [
    `Unattributed rows: introduced ${String(introduced)}, resolved ${String(resolved)}, unchanged ` +
      `${String(unchanged)}, unknown ${String(unknown)} — counts the tool could not attribute, not findings.`,
  ];
}

/**
 * The coverage line — the predicate plus its counts and up to two producer
 * notes, flattened: a note is untrusted bytes, and this line's structure is
 * meaning.
 *
 * @param {ArchitectureEvidence} evidence
 * @returns {string}
 */
function coverageLine(evidence) {
  const { coverage } = evidence;
  const headline = coverage.complete
    ? `Coverage: complete — ${String(coverage.analyzedFiles)} analyzed, ${String(coverage.notAnalyzedCount)} not analyzed, ${String(coverage.blindSpotCount)} blind spot(s).`
    : `Coverage: INCOMPLETE — ${String(coverage.analyzedFiles)} analyzed, ${String(coverage.notAnalyzedCount)} not analyzed, ${String(coverage.blindSpotCount)} blind spot(s).`;
  const notes = coverage.notes.slice(0, 2).map((note) => flat(note, 160));
  return notes.length === 0 ? headline : `${headline} Notes: ${notes.join(" | ")}`;
}

/**
 * The ADR block, spending exactly the budget the facts left. Funding is
 * decided once from the whole pie: when an equal share cannot give every
 * excerpt at least the floor, they are all named as omitted — never some
 * refs starved so a later one fits. Within a funded block each excerpt gets
 * an equal integer share of what remains at its turn, in the refs' own
 * order (byte-sorted at collection), so a share an earlier excerpt
 * underspends rolls forward.
 *
 * @param {ReadonlyMap<string, AdrResolution>} adr
 * @param {number} omittedRefs
 * @param {number} budget what the section has left, may be non-positive
 * @returns {string}
 */
function renderAdrBlock(adr, omittedRefs, budget) {
  /** @type {string[]} */
  const lines = ["ADR context (read at the pinned base; a pull request cannot edit these):"];
  const refs = [...adr.keys()];
  let remaining = budget - byteLength(lines[0] ?? "") - MARKER_ALLOWANCE;
  const excerptRefs = refs.filter((ref) => {
    const resolution = adr.get(ref);
    return resolution?.status === "found" && resolution.excerpt !== null;
  });
  const fundable =
    excerptRefs.length === 0 || Math.floor(remaining / excerptRefs.length) >= MIN_ADR_EXCERPT_BYTES;
  for (let at = 0; at < refs.length; at += 1) {
    const ref = refs[at];
    if (ref === undefined) continue;
    const resolution = adr.get(ref);
    if (resolution === undefined) continue;
    const lead = `- ${flat(ref, MAX_ADR_ID_LENGTH)}: `;
    if (resolution.status === "found" && resolution.excerpt !== null) {
      if (!fundable) {
        lines.push(`${lead}omitted for prompt budget.`);
        continue;
      }
      const share = Math.floor(remaining / (excerptRefs.length - at));
      const excerpt = capWithMarker(resolution.excerpt, share - MARKER_ALLOWANCE, "adr excerpt");
      remaining -= byteLength(lead) + byteLength(excerpt);
      lines.push(`${lead}${excerpt}`);
      continue;
    }
    const tail =
      resolution.status === "absent"
        ? "no ADR at the pinned base — intentional evolution is a claim without its record here."
        : "not an ADR id shape — not read.";
    lines.push(`${lead}${tail}`);
  }
  if (omittedRefs > 0) {
    lines.push(
      `(+${String(omittedRefs)} more decision ref(s) not read — the per-run cap is ${String(MAX_ADR_REFS)}.)`,
    );
  }
  return lines.join("\n");
}

// ── Bytes and flattening ───────────────────────────────────────────────────

/**
 * One flattened fact, however hostile the bytes behind it: backticks fold
 * (no code-span escapes), every control character and line separator goes
 * (no forged structure), and the result is capped in code units. Report
 * bytes are evidence; this is the iron they pass through on the way into a
 * line-structured section.
 *
 * @param {string | null | undefined} value
 * @param {number} [maxChars]
 * @returns {string}
 */
function flat(value, maxChars = 200) {
  return (
    String(value ?? "")
      .replace(/`/g, "'")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "")
      .slice(0, maxChars)
  );
}

/**
 * @param {string} text
 * @returns {number}
 */
function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Caps text to a byte budget on whole code points, marking the cut in the
 * wrapper's own family — the same discipline the description's tighter
 * bound follows (#527). Uncut text passes through untouched.
 *
 * @param {string} text
 * @param {number} budget a non-negative byte ceiling for the result, marker included
 * @param {string} what the marker names
 * @returns {string}
 */
function capWithMarker(text, budget, what) {
  const total = byteLength(text);
  if (total <= budget) return text;
  const room = Math.max(0, budget - MARKER_ALLOWANCE);
  /** @type {string[]} */
  const kept = [];
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > room) break;
    kept.push(char);
    used += size;
  }
  return `${kept.join("")}\n[${what} truncated: ${String(used)} of ${String(total)} bytes shown]`;
}
