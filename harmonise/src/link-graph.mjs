/**
 * Post-model link-graph validation — the deterministic proof that a
 * translation preserved link identity before the translation is accepted.
 *
 * Three gates already judge a model answer: placeholder restoration (counts
 * and namespace), the HTML sanitiser, and the structural profile. None of
 * them looks at where a link POINTS. As long as markdown structure survives,
 * a model could silently re-target a reference — swap a localized sibling
 * for `https://evil.example`, inject a `[x](javascript:…)` destination the
 * HTML sanitiser never sees (it blanks href/src attributes, not markdown
 * destinations), strip an anchor fragment, or point a link at a different
 * document — and every gate would accept the answer. This module closes
 * that gap.
 *
 * Extraction reuses the rewriter's mechanics — fenced-line skipping, code
 * span masking, the paren-depth destination extent scan, the definition-
 * first line test, the angle-bracket pass-through — so "link" means the
 * same thing on both sides of the comparison. It is not a Markdown parser
 * and proves nothing the rewriter cannot.
 *
 * The verdict is per-kind identity equality between the model-visible
 * source and the sanitised candidate:
 *
 *   - Refused-shaped destinations — schemes, protocol- and root-relative,
 *     same-page anchors, angle brackets, anything the rewriter's ladder
 *     declines or cannot prove — must come back byte-identical, query and
 *     fragment tails and titles included.
 *   - Internal destinations must denote the same target: the candidate's
 *     destination resolves through the same inventory resolvers the
 *     rewrite localized with, and must land on the target the source
 *     landed on — or, when nothing localizes for it, on the same
 *     normalized repository-absolute path. Tails and titles are bytes and
 *     must survive byte-for-byte.
 *   - Reference definitions pair label with destination: both survive
 *     together, or the pair fails.
 *   - Kinds are counted separately: an image may not come back a link, an
 *     inserted or dropped construct is a violation, and no destination may
 *     appear that the source cannot account for.
 *
 * Matching is per kind on identity, not on position: honest translation
 * reorders prose, and links ride along with their sentences, so a faithful
 * answer may present the same constructs in a different order. Identity —
 * not layout — is the contract; document order only sequences the
 * violation report.
 */

import { destinationEnd, fenceMask, maskCodeSpans, splitLines } from "./markdown.mjs";
import { openingBracket, resolveLocalDestination, splitDestination } from "./links.mjs";

/** The construct kinds extraction recognises — the rewriter's own notion. @typedef {"link" | "image" | "reference-definition" | "autolink"} LinkKind */

/**
 * One link construct, collected exactly where the rewriter would have
 * walked it.
 *
 * @typedef {object} CollectedLink
 * @property {LinkKind} kind
 * @property {string} destination the destination as authored — the rewritten
 *   spelling on the source side, since the model saw the rewritten document
 * @property {string | undefined} title the quoted title tail as authored, when one is present
 * @property {number} line 1-based line in the collected text
 * @property {string} text the construct's visible text, or a definition's label
 */

/**
 * @typedef {object} LinkGraphContext
 * @property {string} translatedDocPath repository path of the translation — relative destinations are judged from here
 * @property {(absPath: string) => string | null} resolveDocument a linked document's localized target, or null when absent and unplanned
 * @property {(absPath: string) => string | null} resolveImage an image's localized variant, or null when the file does not exist
 */

/**
 * @typedef {object} LinkGraphVerdict
 * @property {boolean} ok
 * @property {string[]} violations empty exactly when `ok`
 */

const KINDS = /** @type {const} */ (["link", "image", "reference-definition", "autolink"]);

/**
 * Collects every link construct the rewriter's walk would prove, in
 * document order: inline links and images, reference definitions, and
 * angle autolinks. Fenced blocks and inline code spans are skipped exactly
 * as the rewriter skips them.
 *
 * @param {string} text
 * @returns {CollectedLink[]}
 */
export function collectLinks(text) {
  const lines = splitLines(text);
  const fences = fenceMask(lines);
  /** @type {CollectedLink[]} */
  const links = [];

  for (const [index, line] of lines.entries()) {
    if (fences[index] === true || line === "") continue;
    const lineNo = index + 1;
    const masked = maskCodeSpans(line);

    // A line that opens a reference definition is a definition line, whole:
    // the rewriter handles it through `localizeFirstToken` and never walks
    // it for `](` openers, and neither does collection.
    const definition = /^(\s{0,3}\[[^\]]+\]:\s*)(\S.*)$/.exec(masked);
    if (definition !== null) {
      collectDefinition(definition, line, lineNo, links);
      continue;
    }

    const proven = collectInline(masked, line, lineNo, links);
    collectAutolinks(masked, line, lineNo, links, proven);
  }

  return links;
}

/**
 * Records one definition line: the label between the brackets and the first
 * destination token after the colon — the token `localizeFirstToken` would
 * judge, angle brackets and all.
 *
 * @param {RegExpExecArray} definition
 * @param {string} line
 * @param {number} lineNo
 * @param {CollectedLink[]} links
 */
function collectDefinition(definition, line, lineNo, links) {
  const prefix = definition[1] ?? "";
  const rest = definition[2] ?? "";
  const labelFrom = prefix.indexOf("[") + 1;
  const labelTo = prefix.indexOf("]:");
  const token = /^\s*(<[^>]*>|\S+)/.exec(rest)?.[1];
  if (labelTo <= labelFrom || token === undefined) return;
  links.push({
    kind: "reference-definition",
    destination: token,
    title: undefined,
    line: lineNo,
    text: line.slice(labelFrom, labelTo),
  });
}

/**
 * Walks one masked line for `](` openers exactly as the rewriter does —
 * same claim discipline, same image detection, same angle-bracket
 * pass-through — collecting every construct whose destination extent can be
 * proven. Returns the proven destination ranges so autolink collection
 * cannot double-count a construct the walk already owns.
 *
 * @param {string} masked
 * @param {string} line
 * @param {number} lineNo
 * @param {CollectedLink[]} links
 * @returns {[number, number][]}
 */
function collectInline(masked, line, lineNo, links) {
  /** @type {[number, number][]} */
  const proven = [];
  let claimedUntil = -1;

  for (const match of masked.matchAll(/\]\(/g)) {
    const openerAt = match.index ?? 0;
    if (openerAt < claimedUntil) continue;

    // An image carries `!` immediately before the bracket that closes onto
    // this `](`; an unbalanced walk means a plain link, as for the rewriter.
    const bracket = openingBracket(masked, openerAt);
    const isImage = bracket !== null && masked[bracket - 1] === "!" && masked[bracket - 2] !== "\\";
    const text = bracket !== null ? line.slice(bracket + 1, openerAt) : "";

    const start = openerAt + 2;
    const end = destinationEnd(masked, start);
    if (end < 0) continue;
    proven.push([start, end]);

    // Angle-bracket destinations are passed through by the rewriter (v1
    // limit) and stay unclaimed on its walk. Collection still records the
    // construct — a passed-through destination is exactly the kind a model
    // must not re-target unseen — without claiming it, so the walk stays
    // byte-identical to the rewriter's.
    if (masked[start] !== "<") claimedUntil = end + 1;
    pushInlineLink(line, text, start, end, isImage, lineNo, links);
  }

  return proven;
}

/**
 * Records one inline link/image from its proven extent, with destination
 * and quoted title split exactly as `localize` splits them.
 *
 * @param {string} line
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {boolean} isImage
 * @param {number} lineNo
 * @param {CollectedLink[]} links
 */
function pushInlineLink(line, text, start, end, isImage, lineNo, links) {
  const interior = line.slice(start, end);
  const trimmed = interior.trim();
  const titled = /^\s*(\S+)\s+(['"]).*\2\s*$/.exec(trimmed);
  links.push({
    kind: isImage ? "image" : "link",
    destination: titled?.[1] ?? trimmed,
    title: titled !== null ? trimmed.slice(titled[1]?.length ?? 0) : undefined,
    line: lineNo,
    text,
  });
}

/**
 * Collects angle autolinks — `<scheme:…>` — the same shape the destination
 * mask treats as machinery, skipping any range the inline walk already
 * proved: an autolink inside a proven destination is content of that
 * construct, not a construct of its own.
 *
 * @param {string} masked
 * @param {string} line
 * @param {number} lineNo
 * @param {CollectedLink[]} links
 * @param {[number, number][]} proven
 */
function collectAutolinks(masked, line, lineNo, links, proven) {
  for (const match of masked.matchAll(/<([a-zA-Z][a-zA-Z0-9+.-]*:[^<>]*)>/g)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (proven.some(([from2, to2]) => from < to2 && from2 < to)) continue;
    links.push({
      kind: "autolink",
      destination: match[1] ?? "",
      title: undefined,
      line: lineNo,
      text: line.slice(from, to),
    });
  }
}

/**
 * Judges the candidate's link graph against the source's. Per kind, the
 * candidate must present exactly the identities the source presents — no
 * destination changed, none added, none dropped, no kind swapped for
 * another. Unmatched constructs are paired in document order for the
 * violation report.
 *
 * @param {object} input
 * @param {CollectedLink[]} input.sourceLinks links collected from the model-visible source
 * @param {CollectedLink[]} input.candidateLinks links collected from the sanitised candidate
 * @param {LinkGraphContext} input.context the translated document's path and the inventory resolvers
 * @returns {LinkGraphVerdict}
 */
export function validateLinkGraph({ sourceLinks, candidateLinks, context }) {
  /** @type {string[]} */
  const violations = [];

  for (const kind of KINDS) {
    const source = sourceLinks.filter((link) => link.kind === kind);
    const candidate = candidateLinks.filter((link) => link.kind === kind);

    /** @type {Map<string, CollectedLink[]>} */
    const byIdentity = new Map();
    for (const link of candidate) {
      const key = identityOf(link, context);
      const queue = byIdentity.get(key);
      if (queue === undefined) byIdentity.set(key, [link]);
      else queue.push(link);
    }

    /** @type {CollectedLink[]} */
    const unmatchedSource = [];
    for (const link of source) {
      const match = byIdentity.get(identityOf(link, context))?.shift();
      if (match === undefined) unmatchedSource.push(link);
    }

    /** @type {CollectedLink[]} */
    const unmatchedCandidate = [];
    for (const queue of byIdentity.values()) unmatchedCandidate.push(...queue);
    unmatchedCandidate.sort((a, b) => a.line - b.line);

    const paired = Math.min(unmatchedSource.length, unmatchedCandidate.length);
    const froms = unmatchedSource.slice(0, paired);
    const tos = unmatchedCandidate.slice(0, paired);
    for (const [index, from] of froms.entries()) {
      const to = tos[index];
      if (to === undefined) continue;
      violations.push(
        `line ${String(to.line)}: ${kind} destination changed: '${from.destination}' → ` +
          `'${to.destination}'`,
      );
    }
    for (const extra of unmatchedCandidate.slice(paired)) {
      violations.push(
        `line ${String(extra.line)}: ${kind} added with destination '${extra.destination}' ` +
          `and no source counterpart`,
      );
    }
    for (const gone of unmatchedSource.slice(paired)) {
      violations.push(
        `line ${String(gone.line)}: ${kind} destination '${gone.destination}' removed`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * A construct's identity: what it points at plus, when a title is present,
 * the title's exact bytes. Equal identities match; anything else is a
 * violation.
 *
 * @param {CollectedLink} link
 * @param {LinkGraphContext} context
 * @returns {string}
 */
function identityOf(link, context) {
  return `${destinationIdentity(link, context)}|${link.title ?? ""}`;
}

/**
 * @param {CollectedLink} link
 * @param {LinkGraphContext} context
 * @returns {string}
 */
function destinationIdentity(link, context) {
  if (link.kind === "reference-definition") {
    // A definition localizes through resolveDocument: `localizeFirstToken`
    // never judges one as an image, whatever it points at.
    return (
      `definition '${link.text}' → ` +
      destinationKey(link.destination, context.resolveDocument, context)
    );
  }
  return destinationKey(
    link.destination,
    link.kind === "image" ? context.resolveImage : context.resolveDocument,
    context,
  );
}

/**
 * Where a destination must point for a candidate to pass: refused-shaped
 * destinations (angle brackets included — the rewriter passes those
 * through) are their own verbatim bytes; internal destinations are the
 * target the inventory resolvers name, falling back to the normalized
 * absolute path when nothing localizes for them — the shape of a rewrite
 * whose target the rewriter proved but which no resolver answers for again.
 * Query and fragment tails ride inside the key as the bytes they are.
 *
 * @param {string} destination
 * @param {(absPath: string) => string | null} resolve
 * @param {LinkGraphContext} context
 * @returns {string}
 */
function destinationKey(destination, resolve, context) {
  if (destination.startsWith("<")) return `verbatim ${destination}`;
  const absolute = resolveLocalDestination(destination, context.translatedDocPath);
  if (absolute === null) return `verbatim ${destination}`;
  const resolved = resolve(absolute);
  const tail = tailOf(destination);
  return resolved === null ? `path ${absolute}#${tail}` : `target ${resolved}#${tail}`;
}

/**
 * The query/fragment tail of a destination, split exactly as the rewriter's
 * `splitDestination` splits it.
 *
 * @param {string} destination
 * @returns {string}
 */
function tailOf(destination) {
  const trimmed = destination.trim();
  const titled = /^\s*(\S+)\s+(['"]).*\2\s*$/.exec(trimmed);
  const pathPart = titled?.[1] ?? trimmed;
  return splitDestination(pathPart)?.tail ?? "";
}
