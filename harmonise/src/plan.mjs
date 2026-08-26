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
import { protectDocument } from "./protect.mjs";
import { restoreDocument } from "./protect.mjs";
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
 * @typedef {object} PreparedPair
 * @property {string} slug
 * @property {string} lang
 * @property {string} sourcePath
 * @property {string} destinationPath
 * @property {"existing" | "missing"} state
 * @property {string} sourceText the untouched original, for identity checks and structure comparison
 * @property {string} protectedText the source as the model will receive it
 * @property {ReturnType<typeof protectDocument>} protection
 * @property {number} linksRewritten destinations that moved during preparation
 */

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
 * @param {Inventory} input.inventory
 * @param {import("./config.mjs").HarmoniseConfig} input.config
 * @returns {PreparedPair}
 */
export function preparePair({ slug, lang, sourcePath, target, sourceText, inventory, config }) {
  const protection = protectDocument(sourceText, { glossary: config.glossary });

  /** @type {import("./links.mjs").LinkContext} */
  const context = {
    sourceDocPath: sourcePath,
    translatedDocPath: target.path,
    languageTag: lang,
    resolveDocument: (absPath) => inventory.resolveDocument(absPath, lang),
    resolveImage: (absPath) => inventory.resolveImage(absPath, lang),
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
    linksRewritten: rewritten.count,
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
 * @returns {Promise<{ outcome: "noop", summary: string } | { outcome: "proposal", text: string, summary: string }>}
 */
export async function translatePair(input) {
  const { messages } = buildTranslationPrompt({
    repository: input.repository,
    sourceLanguage: input.sourceLanguage,
    language: input.prepared.lang,
    protectedSource: input.prepared.protectedText,
    existingTranslation: input.existingText,
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

  // A proposal past the same cap the preparation enforces would be a
  // document we could never frame as evidence on a later pass.
  const bytes = new TextEncoder().encode(sanitised).byteLength;
  if (bytes > MAX_SOURCE_BYTES) {
    throw new Error(
      `the translated document is ${String(bytes)} bytes, past the ` +
        `${String(MAX_SOURCE_BYTES)}-byte cap`,
    );
  }

  // Byte-identity semantics, per the specification: identical to what it
  // replaces is no drift whatever the flag claimed.
  if (input.existingText !== undefined && sanitised === input.existingText) {
    return { outcome: "noop", summary: answer.summary };
  }

  const violations = compareStructuralProfiles(
    structuralProfile(input.prepared.sourceText),
    structuralProfile(sanitised),
  );
  if (violations.length > 0) {
    throw new Error(`structural validation failed: ${violations.join("; ")}`);
  }

  return { outcome: "proposal", text: sanitised, summary: answer.summary };
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
 * javascript: URI schemes in href/src attributes and `<!-- harmonise:`
 * directive comments that a model could inject as persistent artifacts.
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
 * element list, on* event handlers, and href/src values in the javascript:
 * scheme, plus the directive-comment prefix a model could forge to steer a
 * later run. Hoisted to module scope because the fixpoint loop in
 * `stripDangerousHtml` is part of their contract.
 */
const DANGEROUS_TAG =
  /<\s*\/?\s*(?:script|iframe|object|embed|form|input|textarea|select|button|link|meta|base|svg|math|foreignObject)\b[^>]*>/gi;
const EVENT_HANDLER = /\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const SCRIPT_URI =
  /(?:href|src)\s*=\s*(?:"[^"]*javascript:[^"]*"|'[^']*javascript:[^']*'|[^\s>]*javascript:[^\s>]*)/gi;
const DIRECTIVE_COMMENT = /<!--\s*harmonise:/g;

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
      .replace(SCRIPT_URI, blank)
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
