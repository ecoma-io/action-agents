/**
 * Pair preparation — the whole deterministic half of translating one
 * document, run before any model exists in the picture.
 *
 * For one (source, target-language) pair this fixes everything the model must
 * not decide: the destination path, which terms and regions are protected,
 * where internal links and images point in the translated tree. What comes
 * back is either a prepared pair — protected, link-resolved source text plus
 * the protection map a later stage restores against — or a recorded failure.
 * A pair that fails preparation never reaches translation; the run reports
 * it and carries on with the rest.
 */

import { rewriteLinks } from "./links.mjs";
import { collectLinks, validateLinkGraph } from "./link-graph.mjs";
import { protectDocument } from "./protect.mjs";
import { restoreDocument } from "./protect.mjs";
import { planBlocks, summarizePlan } from "./blocks.mjs";
import {
  DEFAULT_FRONTMATTER_POLICY,
  extractFrontmatter,
  planFrontmatterProtection,
  validateFrontmatter,
} from "./frontmatter.mjs";
import { parseTranslationAnswer } from "./answer.mjs";
import { buildTranslationPrompt } from "./prompt.mjs";
import {
  compareStructuralProfiles,
  structuralProfile,
  fenceMask,
  maskCodeSpans,
  splitLines,
} from "./markdown.mjs";

/** @typedef {import("./inventory.mjs").Inventory} Inventory */
/** @typedef {import("#core/chat.mjs").Chat} Chat */
/** @typedef {import("#core/untrusted.mjs").Evidence} Evidence */

/**
 * The most source text one pair may carry. Both documents must fit inside the
 * evidence wrapper's 64 KiB frame, so the source alone is capped at half that;
 * a pair past the cap skips with that reason rather than translating a
 * silently truncated document.
 */
export const MAX_SOURCE_BYTES = 32 * 2 ** 10;

/**
 * Why a pair cannot be prepared, or null when it can.
 *
 * @param {string} sourceText
 * @returns {string | null}
 */
export function preparationRefusal(sourceText) {
  if (sourceText === "") return "the source document is empty";
  const bytes = new TextEncoder().encode(sourceText).byteLength;
  if (bytes > MAX_SOURCE_BYTES) {
    return (
      `${String(bytes)} bytes, past the ${String(MAX_SOURCE_BYTES)}-byte cap — split the ` +
      `document so both versions fit the evidence frame`
    );
  }
  return null;
}

/**
 * The frontmatter protection one pair carries from preparation to validation:
 * the plan's restore map, the policy the gate judges with, and the raw
 * frontmatter exactly as authored. Planned once per source document by
 * {@link planFrontmatterGuard}; `undefined` for a frontmatter-less document,
 * which passes through untouched.
 *
 * @typedef {object} FrontmatterGuard
 * @property {string} raw the raw frontmatter as authored, the validation gate's original side
 * @property {import("./frontmatter.mjs").FrontmatterPolicy} policy the policy the gate judges with
 * @property {Map<string, string>} restoreMap token → the exact protected bytes
 * @property {string} maskedRaw the raw frontmatter with protected values behind tokens
 */

/**
 * @typedef {object} PreparedPair
 * @property {string} slug
 * @property {string} lang
 * @property {string} sourcePath
 * @property {string} destinationPath
 * @property {"existing" | "missing"} state
 * @property {string} sourceText the untouched original, for identity checks and structure comparison
 * @property {string} protectedText the source as the model will receive it
 * @property {ReturnType<typeof protectDocument>} protection
 * @property {FrontmatterGuard | undefined} frontmatter the pair's frontmatter protection, undefined without frontmatter
 * @property {number} linksRewritten destinations that moved during preparation
 * @property {(absPath: string) => string | null} resolveDocument a linked document's localized target, or null when absent and unplanned
 * @property {(absPath: string) => string | null} resolveImage an image's localized variant, or null when the file does not exist
 */

/**
 * Plans one source document's frontmatter protection. The shipped policy is
 * the whole policy today: keys it names translatable stay in the clear, every
 * other key — known or unknown — goes behind a placeholder. A frontmatter-less
 * document passes through untouched, and a frontmatter the recognizer or the
 * planner refuses comes back refused: masking is the only way past, so a
 * refused plan is a pair that never reaches the model.
 *
 * @param {string} sourceText
 * @returns {{ kind: "absent" } | { kind: "refused", code: string, message: string } | { kind: "planned", guard: FrontmatterGuard }}
 */
export function planFrontmatterGuard(sourceText) {
  const extracted = extractFrontmatter(sourceText);
  if (extracted.kind === "absent") return { kind: "absent" };
  if (extracted.kind === "refused") {
    return { kind: "refused", code: extracted.code, message: extracted.message };
  }
  const plan = planFrontmatterProtection(extracted.raw, DEFAULT_FRONTMATTER_POLICY);
  if (plan.kind === "refused") {
    return { kind: "refused", code: plan.code, message: plan.message };
  }
  return {
    kind: "planned",
    guard: {
      raw: extracted.raw,
      policy: DEFAULT_FRONTMATTER_POLICY,
      restoreMap: plan.restoreMap,
      maskedRaw: plan.masked,
    },
  };
}

/**
 * Splices the masked frontmatter back over the document it was planned from:
 * everything before the opening fence, the masked raw, everything from the
 * closing fence on. The fence scan mirrors `extractFrontmatter`'s, and a
 * guard is only ever handed the exact text it was planned from — a missing
 * fence here is a wiring defect, refused, never a mangled document.
 *
 * @param {string} sourceText
 * @param {FrontmatterGuard} guard
 * @returns {string}
 */
function maskFrontmatter(sourceText, guard) {
  const lines = splitLines(sourceText);
  if (lines[0]?.trim() !== "---") {
    throw new Error("the frontmatter planned for masking has no opening fence");
  }
  const contentStart = (lines[0]?.length ?? 0) + 1;
  let closerStart = -1;
  let offset = contentStart;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.trim() === "---") {
      closerStart = offset;
      break;
    }
    offset += line.length + 1;
  }
  if (closerStart === -1) {
    throw new Error("the frontmatter planned for masking has no closing fence");
  }
  return sourceText.slice(0, contentStart) + guard.maskedRaw + sourceText.slice(closerStart);
}

/**
 * Prepares one pair. Throws only on defects that make the pair unpreparable
 * (malformed directives); callers record those per pair and carry on.
 *
 * @param {object} input
 * @param {string} input.slug
 * @param {string} input.lang
 * @param {string} input.sourcePath
 * @param {{ path: string, state: "existing" | "missing" }} input.target
 * @param {string} input.sourceText
 * @param {FrontmatterGuard} [input.frontmatter] the source's planned frontmatter protection, undefined without frontmatter
 * @param {Inventory} input.inventory
 * @param {import("./config.mjs").HarmoniseConfig} input.config
 * @returns {PreparedPair}
 */
export function preparePair({
  slug,
  lang,
  sourcePath,
  target,
  sourceText,
  inventory,
  config,
  frontmatter,
}) {
  // Frontmatter protection runs first: protected values are tokens before
  // the glossary, the skip directives or the link rewriter can see them, so
  // no machinery ever rewrites what the policy holds fixed.
  const working = frontmatter === undefined ? sourceText : maskFrontmatter(sourceText, frontmatter);
  const protection = protectDocument(working, { glossary: config.glossary });

  // The rewrite resolves references from the source document's directory;
  // validation (the resolvers exposed below) judges the rewritten references
  // from the translation's directory, where both sides of a pair anchor at
  // validation time. `resolveDocument` is slug-based and
  // directory-independent; `resolveImage`'s configured layouts are relative
  // to the document's own directory, so each binding anchors where its
  // references do.

  /** @type {import("./links.mjs").LinkContext} */
  const context = {
    sourceDocPath: sourcePath,
    translatedDocPath: target.path,
    languageTag: lang,
    resolveDocument: (absPath) => inventory.resolveDocument(absPath, lang),
    resolveImage: (absPath) => inventory.resolveImage(absPath, lang, sourcePath),
  };
  const rewritten = rewriteLinks(protection.text, context);

  return {
    slug,
    lang,
    sourcePath,
    destinationPath: target.path,
    state: target.state,
    sourceText,
    protectedText: rewritten.text,
    protection,
    frontmatter,
    linksRewritten: rewritten.count,
    resolveDocument: context.resolveDocument,
    resolveImage: (absPath) => inventory.resolveImage(absPath, lang, target.path),
  };
}

/**
 * Translates one prepared pair: prompt, one chat request, contract parsing,
 * placeholder restoration, structural comparison. The model's degrees of
 * freedom end at prose and the three contract fields — everything else was
 * already decided when the text was prepared.
 *
 * @param {object} input
 * @param {PreparedPair} input.prepared
 * @param {string} input.sourceLanguage the config's resolved source language
 * @param {string | undefined} input.existingText the translation on the branch, when one exists
 * @param {string} input.model
 * @param {Chat} input.chat
 * @param {Evidence} input.evidence
 * @param {{ name: string, description: string }} input.repository
 * @param {{ instruction?: string, languages: Record<string, string> }} input.documents
 * @param {string} [input.priorTranslation] a previously accepted translation of this exact source, offered to the model as reference — never an instruction
 * @returns {Promise<{ outcome: "noop", summary: string } | { outcome: "proposal", text: string, summary: string }>}
 */
export async function translatePair(input) {
  const { messages } = buildTranslationPrompt({
    repository: input.repository,
    sourceLanguage: input.sourceLanguage,
    language: input.prepared.lang,
    protectedSource: input.prepared.protectedText,
    existingTranslation: input.existingText,
    priorTranslation: input.priorTranslation,
    documents: input.documents,
    evidence: input.evidence,
  });

  const { content } = await input.chat.complete({ model: input.model, messages });
  const answer = parseTranslationAnswer(content, {
    existingTranslation: input.existingText,
  });

  // The cheapest identity check runs first, on what the model actually said:
  // an answer carrying the published translation verbatim needs no
  // restoration — the published text holds no placeholders to validate.
  // Without this early exit, an honest no-op could never pass restoration,
  // because the published text legitimately contains none of this run's
  // tokens.
  if (input.existingText !== undefined && answer.content === input.existingText) {
    return { outcome: "noop", summary: answer.summary };
  }

  // Restoration is validation: counts must match and no unknown token may
  // wear this run's namespace, or this throws and the pair fails.
  const restored = restoreDocument(answer.content, input.prepared.protection);

  // Strip dangerous HTML from model output before it reaches the commit.
  // Code blocks and code spans are preserved unchanged; only prose is sanitised.
  const sanitised = sanitizeTranslationHtml(restored);

  // The protected frontmatter values go back only after sanitising: until
  // this point the placeholders shielded them from every rewrite and from
  // the HTML stripper, exactly as the glossary tokens shield their terms.
  const unmasked = restoreFrontmatter(sanitised, input.prepared.frontmatter);

  // A proposal past the same cap the preparation enforces would be a
  // document we could never frame as evidence on a later pass.
  const bytes = new TextEncoder().encode(unmasked).byteLength;
  if (bytes > MAX_SOURCE_BYTES) {
    throw new Error(
      `the translated document is ${String(bytes)} bytes, past the ` +
        `${String(MAX_SOURCE_BYTES)}-byte cap`,
    );
  }

  // Byte-identity semantics, per the specification: identical to what it
  // replaces is no drift whatever the flag claimed.
  if (input.existingText !== undefined && unmasked === input.existingText) {
    return { outcome: "noop", summary: answer.summary };
  }

  // The frontmatter gate: protected values byte-identical, the key sequence
  // exact, translatable scalars still single-line, no placeholder alive. Any
  // violation refuses the pair — reported, never coerced back into a pass.
  if (input.prepared.frontmatter !== undefined) {
    const refusal = validateRestoredFrontmatter(unmasked, input.prepared.frontmatter);
    if (refusal !== null) throw new Error(`frontmatter validation failed: ${refusal}`);
  }

  const violations = compareStructuralProfiles(
    structuralProfile(input.prepared.sourceText),
    structuralProfile(unmasked),
  );
  if (violations.length > 0) {
    throw new Error(`structural validation failed: ${violations.join("; ")}`);
  }

  // Link identity: the rewriter decided where every internal reference
  // points before the model saw the document, and the answer must come back
  // pointing there still. Both sides are collected from text the candidate
  // is actually judged against — the rewritten source with placeholders
  // restored, because skip regions return byte-for-byte inside the
  // candidate — and validated with the same inventory resolvers the rewrite
  // localized with.
  const linkVerdict = validateLinkGraph({
    sourceLinks: collectLinks(
      restoreDocument(input.prepared.protectedText, input.prepared.protection),
    ),
    candidateLinks: collectLinks(unmasked),
    context: {
      translatedDocPath: input.prepared.destinationPath,
      resolveDocument: input.prepared.resolveDocument,
      resolveImage: input.prepared.resolveImage,
    },
  });
  if (linkVerdict.violations.length > 0) {
    throw new Error(`link validation failed: ${linkVerdict.violations.join("; ")}`);
  }

  return { outcome: "proposal", text: unmasked, summary: answer.summary };
}

/** The shape of every frontmatter placeholder this pipeline can mint. Case-insensitive on purpose: a token the model re-cased is a forgery, never prose. */
const FRONTMATTER_TOKEN = /\[\[harmonise:[0-9a-f]{16}:f[1-9][0-9]*\]\]/gi;

/**
 * Restores the protected frontmatter values into a translated document:
 * every token this run minted back to its exact bytes. A token the model
 * dropped or mangled is not refused here — the restoration simply cannot put
 * the value back, and the validation gate refuses the pair for the changed
 * bytes. A token this run never minted is refused on the spot, mirroring
 * `restoreDocument`'s namespace rule: the `f` kind sits outside that
 * function's token pattern, so this is the only place the refusal lives.
 *
 * @param {string} candidate the translated text, machinery tokens already restored
 * @param {FrontmatterGuard | undefined} frontmatter the pair's frontmatter protection
 * @returns {string}
 */
function restoreFrontmatter(candidate, frontmatter) {
  if (frontmatter === undefined) return candidate;
  for (const match of candidate.matchAll(FRONTMATTER_TOKEN)) {
    if (!frontmatter.restoreMap.has(match[0])) {
      throw new Error(`the output contains '${match[0]}', which this run never minted`);
    }
  }
  let restored = candidate;
  for (const [token, original] of frontmatter.restoreMap) {
    restored = restored.split(token).join(original);
  }
  return restored;
}

/**
 * The deterministic gate over a restored translation's frontmatter: the
 * translated block must still parse, and {@link validateFrontmatter}'s
 * verdicts — byte-identical protected values, the exact key sequence,
 * single-line translatable scalars, no surviving placeholder — are refusal
 * conditions, never coerced back into a pass.
 *
 * @param {string} restored the candidate with every placeholder consumed
 * @param {FrontmatterGuard} guard
 * @returns {string | null} the refusal message, or null when the frontmatter is in step
 */
function validateRestoredFrontmatter(restored, guard) {
  const translated = extractFrontmatter(restored);
  if (translated.kind === "absent") {
    return "the translated document lost its frontmatter block";
  }
  if (translated.kind === "refused") {
    return `the translated frontmatter does not parse: ${translated.message}`;
  }
  const verdict = validateFrontmatter(guard.raw, translated.raw, guard.policy);
  return verdict.ok ? null : verdict.violations.map((entry) => entry.detail).join("; ");
}

/**
 * The change shape one pair is reported with. A block plan needs BOTH sides'
 * blocks: the recorded source's blocks from the pair's sync-state record and
 * a segmentation of the current source. Either side missing makes whole-file
 * the only honest scope — the current behavior — with the reason named;
 * neither side is ever guessed.
 *
 * @typedef {object} PairBlockShape
 * @property {"whole-file" | "planned"} planning how the pair's change was scoped
 * @property {string} [reason] why whole-file was the only honest scope
 * @property {number} [changed] planned: current blocks aligned with a previous block of different content
 * @property {number} [unchanged] planned: current blocks byte-identical to a previous block
 * @property {number} [added] planned: current blocks with no previous counterpart
 * @property {number} [removed] planned: previous blocks with no current counterpart
 */

/**
 * The recorded source's blocks, when the pair's state record carries them.
 * The state schema (v1) records whole-document fingerprints only, so no
 * record a repository holds today has blocks; the read is shaped defensively
 * so a schema that grows them is picked up by this seam without a rewrite.
 * Anything that is not a list of content-carrying blocks is null — a plan
 * built on malformed records would be a guess.
 *
 * @param {import("./state.mjs").SyncStateRecord | null} recorded
 * @returns {import("./blocks.mjs").SourceBlock[] | null}
 */
function recordedSourceBlocks(recorded) {
  const blocks = /** @type {{ sourceBlocks?: unknown } | null} */ (recorded)?.sourceBlocks;
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (typeof (/** @type {any} */ (block)?.content) !== "string") return null;
  }
  return /** @type {import("./blocks.mjs").SourceBlock[]} */ (blocks);
}

/**
 * The change shape one pair is scoped to, from the pair's recorded state and
 * the current source's blocks. `currentBlocks` is null while no segmentation
 * stage exists — the plan degrades to whole-file with the reason, exactly
 * the current behavior, and {@link planBlocks} runs only when both sides
 * provably exist.
 *
 * @param {import("./state.mjs").SyncStateRecord | null} recorded
 * @param {import("./blocks.mjs").SourceBlock[] | null} currentBlocks
 * @returns {PairBlockShape}
 */
export function pairBlockShape(recorded, currentBlocks) {
  const previousBlocks = recordedSourceBlocks(recorded);
  if (previousBlocks === null) {
    return {
      planning: "whole-file",
      reason: "the recorded state carries no block fingerprints to plan against",
    };
  }
  if (currentBlocks === null) {
    return {
      planning: "whole-file",
      reason: "no segmentation stage exists for the current source",
    };
  }
  const counts = summarizePlan(planBlocks(previousBlocks, currentBlocks));
  return {
    planning: "planned",
    changed: counts.changed,
    unchanged: counts.unchanged,
    added: counts.added,
    removed: counts.removed,
  };
}

/**
 * Strips dangerous HTML from model translation output while preserving code
 * blocks and code spans unchanged. The model is instructed to produce Markdown
 * only; any HTML in prose is either accidental or adversarial.
 *
 * Preserved: fenced code blocks, inline code, safe block-level HTML
 * (tables, details, summary). Blanked: script, iframe, object, embed,
 * form, input, textarea, select, button, link, meta, base, svg, math,
 * foreignObject, and any on* event-handler attributes. Also blanks
 * javascript: URI schemes in href/src attributes — however the scheme is
 * spelled across the whitespace and HTML entities a browser normalises
 * away — and `<!-- harmonise:` directive comments that a model could
 * inject as persistent artifacts.
 *
 * "Blanked" is deliberate, and it is what makes the strip sound: every
 * construct is overwritten in place with spaces of the same length rather
 * than deleted, so nothing can re-form from the leftovers. Deleting
 * `<script>` from `<scr<script>ipt>` leaves `<script>` behind — the
 * incomplete-sanitization class CodeQL flags — while overwriting leaves
 * `<scr        ipt>`. Same-length overwriting also keeps the masked line's
 * byte offsets valid, which the code-span restore below depends on.
 *
 * @param {string} text the restored translation
 * @returns {string} sanitised text safe to commit
 */
export function sanitizeTranslationHtml(text) {
  const lines = splitLines(text);
  const fenced = fenceMask(lines);

  /** @type {string[]} */
  const result = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i] === true) {
      result[i] = lines[i] ?? "";
      continue;
    }
    // Mask code spans to protect their interiors from the HTML regex, blank
    // the visible text in place, then restore the interiors: the NUL
    // replacement is a scanning aid, not a preservation format.
    const line = lines[i] ?? "";
    const masked = maskCodeSpans(line);
    const stripped = stripDangerousHtml(masked);
    result[i] = unmaskCodeSpans(stripped, line, masked);
  }
  return result.join("\n");
}

/**
 * Elements and attribute shapes that execute or navigate on their own: the
 * element list, on* event handlers, and href/src attribute values, plus the
 * directive-comment prefix a model could forge to steer a later run.
 * Hoisted to module scope because the fixpoint loop in
 * `stripDangerousHtml` is part of their contract.
 */
const DANGEROUS_TAG =
  /<\s*\/?\s*(?:script|iframe|object|embed|form|input|textarea|select|button|link|meta|base|svg|math|foreignObject)\b[^>]*>/gi;
const EVENT_HANDLER = /\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const DIRECTIVE_COMMENT = /<!--\s*harmonise:/g;

/** An href/src attribute value in any of the three quoting shapes. The
 *  scheme is judged on the value's normalised form, not on this raw text. */
const URI_ATTRIBUTE = /(?:href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

/** The scheme, matched on the normalised value. */
const SCRIPT_SCHEME = /javascript:/i;

/** Numeric character references — with or without the semicolon, both of
 *  which browsers parse — and the named references for the characters a
 *  URL's scheme can hide behind. */
const URI_ENTITY = /&#x([0-9a-fA-F]+);?|&#([0-9]+);?|&(tab|newline|colon);/gi;

/** Resolutions for the named references URI_ENTITY matches. */
const NAMED_URI_ENTITIES = new Map([
  ["tab", "\t"],
  ["newline", "\n"],
  ["colon", ":"],
]);

/**
 * Blanks one match in place: same length, all spaces.
 *
 * @param {string} match
 * @returns {string}
 */
function blank(match) {
  return " ".repeat(match.length);
}

/**
 * Neutralises a `<!-- harmonise:` directive prefix while keeping the comment
 * it rode in on — and the line's length, which the code-span restore needs.
 *
 * @param {string} match
 * @returns {string}
 */
function blankDirective(match) {
  return "<!-- " + " ".repeat(match.length - 5);
}

/**
 * Normalises an href/src attribute value the way a browser does before
 * scheme dispatch: attribute entities are decoded once and the tab, LF and
 * CR bytes are stripped from the result. `javascript:` is dispatched
 * however it is spelled across those two normalisations, so the sanitiser
 * judges the scheme on this form rather than on the raw text.
 *
 * @param {string} value the raw attribute value
 * @returns {string}
 */
function normaliseUri(value) {
  return value.replace(URI_ENTITY, decodeUriEntity).replace(/[\t\n\r]/g, "");
}

/**
 * Decodes one character reference for `normaliseUri`: numeric references
 * with or without the semicolon, and the named ones URI_ENTITY matches.
 * Anything outside the code-point range is left as written rather than
 * guessed at.
 *
 * @param {string} match
 * @param {string | undefined} hex the hex digits of a `&#x…;` reference
 * @param {string | undefined} dec the decimal digits of a `&#…;` reference
 * @param {string | undefined} name the name of a `&…;` reference
 * @returns {string}
 */
function decodeUriEntity(match, hex, dec, name) {
  if (name !== undefined) {
    return NAMED_URI_ENTITIES.get(name.toLowerCase()) ?? match;
  }
  const digits = hex ?? dec;
  const radix = hex !== undefined ? 16 : 10;
  const code = digits !== undefined ? Number.parseInt(digits, radix) : Number.NaN;
  if (!Number.isInteger(code) || code > 0x10ffff) {
    return match;
  }
  return String.fromCodePoint(code);
}

/**
 * Blanks an href/src attribute whole when its value dispatches as a
 * javascript: URI once normalised; any other value passes through
 * untouched, byte for byte.
 *
 * @param {string} match the whole `href=…` / `src=…` attribute text
 * @param {string} value the raw attribute value (first capture group)
 * @returns {string}
 */
function blankUriAttribute(match, value) {
  return SCRIPT_SCHEME.test(normaliseUri(value)) ? blank(match) : match;
}

/**
 * Blanks every dangerous construct out of one masked prose line, repeating
 * until nothing changes. In-place overwriting already cannot reconstruct
 * what it removes; the loop is the second belt — the shape sanitisation
 * reviewers (CodeQL's incomplete-sanitization rule among them) recognise as
 * correct for patterns that could ever overlap themselves.
 *
 * @param {string} masked
 * @returns {string}
 */
function stripDangerousHtml(masked) {
  let current = masked;
  let previous;
  do {
    previous = current;
    current = current
      .replace(DANGEROUS_TAG, blank)
      .replace(EVENT_HANDLER, blank)
      .replace(URI_ATTRIBUTE, blankUriAttribute)
      .replace(DIRECTIVE_COMMENT, blankDirective);
  } while (current !== previous);
  return current;
}

/**
 * Restores code span interiors from the original line. `masked` has NUL
 * characters where the interiors were; `original` has the real content.
 * Because `maskCodeSpans` preserves byte length and the strip blanks in
 * place, a NUL in `masked` at position i corresponds to the same position
 * in `original` and in `stripped`.
 *
 * @param {string} stripped the line after in-place blanking on the masked version
 * @param {string} original the untouched source line
 * @param {string} masked the NUL-masked version used for scanning
 * @returns {string}
 */
function unmaskCodeSpans(stripped, original, masked) {
  let out = "";
  for (let i = 0; i < stripped.length; i++) {
    out += (masked[i] === "\u0000" ? original[i] : stripped[i]) ?? "";
  }
  return out;
}
