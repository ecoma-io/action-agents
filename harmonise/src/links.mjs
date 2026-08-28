/**
 * Localized internal links — the deterministic re-pointing of one document's
 * references at another language's files, using the inventory's answers and
 * nothing else.
 *
 * What gets rewritten: inline images `![alt](target)`, inline links
 * `[text](target)`, and reference definitions `[id]: target` whose target is
 * a relative repository path. What never does: anything with a scheme
 * (`https:`, `mailto:`, `data:`), protocol-relative targets (`//host`),
 * same-page anchors (`#x`), root-relative targets (`/docs/x.md` — GitHub
 * serves those against the site root, not the repository, so "localizing"
 * them would guess), anything inside fenced blocks or inline code spans, and
 * any destination whose resolver returns nothing. A link the action cannot
 * prove stays exactly as authored.
 *
 * Rewriting prefers the smallest edit that lands on the resolved target — the
 * language tag inserted into the author's own bytes — and rebuilds the
 * relative path only when the translation lives at a different depth and the
 * small edit cannot land there.
 *
 * The model never sees an unresolved decision: this module runs before
 * translation, so the text handed over already carries its final links.
 */

import { fenceMask, maskCodeSpans, splitLines } from "./markdown.mjs";

/**
 * @typedef {object} LinkContext
 * @property {string} sourceDocPath repository path of the document holding the links (decoded, `/`-separated, no leading slash)
 * @property {string} translatedDocPath repository path of the translation being produced — re-relativization aims here
 * @property {string} languageTag the target language, as it appears inside localized file names
 * @property {(absPath: string) => string | null} resolveDocument a linked document's localized target, or null when absent and unplanned
 * @property {(absPath: string) => string | null} resolveImage an image's localized variant, or null when the file does not exist
 */

/**
 * Rewrites every provable internal reference in `source`.
 *
 * @param {string} source
 * @param {LinkContext} context
 * @returns {{ text: string, count: number }} the rewritten text and how many destinations moved
 */
export function rewriteLinks(source, context) {
  const lines = splitLines(source);
  const fences = fenceMask(lines);
  let count = 0;

  const rebuilt = lines.map((line, index) => {
    if (fences[index] === true || line === "") return line;
    const masked = maskCodeSpans(line);
    const definition = /^(\s{0,3}\[[^\]]+\]:\s*)(\S.*)$/.exec(masked);
    if (definition !== null) {
      // `[id]: destination "title"` — no `](` to find; the destination is the
      // first token after the colon.
      const [, prefix, rest] = /** @type {[string, string, string]} */ (
        /** @type {unknown} */ (definition)
      );
      const localized = localizeFirstToken(rest, context);
      if (localized !== null) {
        count++;
        return line.slice(0, prefix.length) + localized.replacement + localized.remainder;
      }
      return line;
    }
    const outcome = rewriteDestinations(masked, line, 0, context);
    count += outcome.count;
    return outcome.text;
  });

  return { text: rebuilt.join("\n"), count };
}

/**
 * Localizes the leading destination token of a reference definition's
 * remainder, leaving any title untouched. Angle-bracket destinations are
 * passed through in v1.
 *
 * @param {string} rest
 * @param {LinkContext} context
 * @returns {{ replacement: string, remainder: string } | null}
 */
function localizeFirstToken(rest, context) {
  const token = /^\s*(<[^>]*>|\S+)/.exec(rest)?.[1];
  if (token === undefined) return null;
  if (token.startsWith("<")) return null;

  const replacement = localize(token.trim(), false, context);
  if (replacement === null) return null;
  return {
    replacement,
    remainder: rest.slice(rest.indexOf(token) + token.length),
  };
}

/**
 * Walks one line's masked text for `](` openers, rewrites each qualifying
 * destination in the original.
 *
 * @param {string} masked the line with code spans masked (same length as `line`)
 * @param {string} line the original line
 * @param {number} from where destinations may begin (after a definition's colon)
 * @param {LinkContext} context
 * @returns {{ text: string, count: number }}
 */
function rewriteDestinations(masked, line, from, context) {
  /** @type {[number, number, string][]} */ // [start, end, replacement] on the original
  const edits = [];

  let claimedUntil = from;
  for (const match of masked.slice(from).matchAll(/\]\(/g)) {
    const openerAt = from + match.index;
    // Inside a destination or title already handled — an opener there is
    // content of that construct, not a construct of its own.
    if (openerAt < claimedUntil) continue;

    // An image carries `!` immediately before the bracket that closes onto
    // this `](` — found by walking back over balanced brackets, since text
    // like `![a [b] c](x.png)` nests them.
    const bracket = openingBracket(masked, openerAt);
    const isImage = bracket !== null && masked[bracket - 1] === "!" && masked[bracket - 2] !== "\\";

    // Angle-bracket destinations are passed through untouched (v1 limit).
    if (masked[openerAt + 2] === "<") continue;

    // Scan to the destination's end: unescaped `)` at paren depth zero,
    // honoring quoted titles. Running off the line leaves the construct
    // alone — that is the structural validator's business, not ours.
    let cursor = openerAt + 2;
    const start = cursor;
    let depth = 1;
    let end = -1;
    while (cursor < masked.length) {
      const char = masked[cursor] ?? "";
      if (char === "\\") {
        cursor += 2;
        continue;
      }
      if (char === "(") depth++;
      if (char === ")") {
        depth--;
        if (depth === 0) {
          end = cursor;
          break;
        }
      }
      cursor++;
    }
    if (end < 0) continue;
    claimedUntil = end + 1;

    const rawDestination = line.slice(start, end);
    const replacement = localize(rawDestination, isImage, context);
    if (replacement !== null) edits.push([start, end, replacement]);
  }

  let result = "";
  let cut = 0;
  for (const [start, end, replacement] of edits) {
    result += line.slice(cut, start) + replacement;
    cut = end;
  }
  return { text: result + line.slice(cut), count: edits.length };
}

/**
 * The index of the `[` that closes onto the `](` at `openerAt`, walking back
 * over balanced bracket pairs; null when unbalanced — such a construct is
 * treated as a plain link, never an image.
 *
 * @param {string} masked
 * @param {number} openerAt position of `](`
 * @returns {number | null}
 */
export function openingBracket(masked, openerAt) {
  let depth = 1;
  for (let cursor = openerAt - 1; cursor >= 0; cursor--) {
    const char = masked[cursor] ?? "";
    if (char === "]") depth++;
    if (char === "[") {
      depth--;
      if (depth === 0) return cursor;
    }
  }
  return null;
}

/**
 * One destination's localization, or null when it must stay as authored.
 *
 * @param {string} raw the destination exactly as written
 * @param {boolean} isImage
 * @param {LinkContext} context
 * @returns {string | null}
 */
function localize(raw, isImage, context) {
  const absolute = resolveLocalDestination(raw, context.sourceDocPath);
  if (absolute === null) return null;

  // A trailing quoted title rides along untouched: only the path part moves.
  const trimmed = raw.trim();
  const titled = /^\s*(\S+)\s+(['"]).*\2\s*$/.exec(trimmed);
  const pathPart = titled?.[1] ?? trimmed;
  const titleTail = titled !== null ? trimmed.slice(titled[1]?.length ?? 0) : "";
  const split = splitDestination(pathPart);
  if (split === null) return null; // refused inside resolveLocalDestination — kept for the type
  const { rawPath, tail } = split;

  const resolved = isImage ? context.resolveImage(absolute) : context.resolveDocument(absolute);
  if (resolved === null || resolved === absolute) return null;

  // Preference one: the smallest possible edit — the language tag inserted
  // into the author's own bytes — when it lands exactly on the resolved
  // target. Every encoding choice of the author survives.
  const taggedRaw = insertLanguageTag(rawPath, context.languageTag);
  if (taggedRaw !== null) {
    const taggedDecoded = decodeSegments(taggedRaw);
    if (
      taggedDecoded !== null &&
      normalizePath(`${directoryOf(context.translatedDocPath)}/${taggedDecoded}`) === resolved
    ) {
      return `${taggedRaw}${tail}${titleTail}`;
    }
  }

  // Preference two: rebuild the relative path from the translation's
  // directory, re-encoded conservatively.
  const relative = relativePath(directoryOf(context.translatedDocPath), resolved);
  return `${relative.map(encodeSegment).join("/")}${tail}${titleTail}`;
}

/**
 * The refusal half of `localize`, exported for post-model link validation:
 * where a destination points when the ladder treats it as local, judged from
 * `fromDocPath`'s directory. Every shape the ladder refuses — empty,
 * root-relative, protocol-relative, same-page anchors, schemes, whitespace
 * in the path, malformed or escaping percent-encodings — returns null,
 * meaning "stay as authored"; everything else returns the normalized
 * repository-absolute path. Sharing the ladder keeps validation's notion of
 * "refused" identical to the rewriter's by construction, so the two can
 * never drift apart.
 *
 * @param {string} raw the destination exactly as written
 * @param {string} fromDocPath repository path of the document holding the link
 * @returns {string | null}
 */
export function resolveLocalDestination(raw, fromDocPath) {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (/^\/{1,2}/.test(trimmed)) return null; // root-relative or protocol-relative
  if (/^#/.test(trimmed)) return null; // same-page anchor
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null; // any scheme

  // A trailing quoted title rides along untouched: only the path part moves.
  const titled = /^\s*(\S+)\s+(['"]).*\2\s*$/.exec(trimmed);
  const pathPart = titled?.[1] ?? trimmed;

  const split = splitDestination(pathPart);
  if (split === null) return null;

  const decoded = decodeSegments(split.rawPath);
  if (decoded === null || decoded === "" || decoded.startsWith("/")) return null;

  return normalizePath(`${directoryOf(fromDocPath)}/${decoded}`);
}

/**
 * The raw destination with `. <tag>` inserted before the final extension of
 * its last segment — mirroring how the inventory names localized files.
 * Null when the path ends in a slash (a directory-style link has no name to
 * tag).
 *
 * @param {string} rawPath
 * @param {string} tag
 * @returns {string | null}
 */
function insertLanguageTag(rawPath, tag) {
  if (rawPath.endsWith("/")) return null;
  const dot = rawPath.lastIndexOf(".");
  const slash = rawPath.lastIndexOf("/");
  return dot > slash && dot > 0
    ? `${rawPath.slice(0, dot)}.${tag}${rawPath.slice(dot)}`
    : `${rawPath}.${tag}`;
}

/**
 * Splits a destination into its path part and its query/fragment tail, both
 * kept verbatim.
 *
 * @param {string} destination
 * @returns {{ rawPath: string, tail: string } | null}
 */
export function splitDestination(destination) {
  const hash = destination.indexOf("#");
  const query = destination.indexOf("?");
  const cut =
    hash < 0 && query < 0
      ? destination.length
      : hash < 0
        ? query
        : query < 0
          ? hash
          : Math.min(hash, query);
  const rawPath = destination.slice(0, cut);
  const tail = destination.slice(cut);
  if (rawPath === "" || /\s/.test(rawPath)) return null;
  return { rawPath, tail };
}

/**
 * Percent-decodes a whole path part. Null when malformed — a `%` sequence
 * that does not decode is preserved by refusing the rewrite.
 *
 * @param {string} path
 * @returns {string | null}
 */
function decodeSegments(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/** @param {string} path @returns {string} the directory part, "" when none */
function directoryOf(path) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Resolves `.` and `..` segments; null when the result escapes the repository.
 *
 * @param {string} path
 * @returns {string | null}
 */
function normalizePath(path) {
  /** @type {string[]} */
  const out = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null; // above the repository root
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/**
 * The segments that walk from `fromDir` up-or-down to `toPath`.
 *
 * @param {string} fromDir
 * @param {string} toPath
 * @returns {string[]}
 */
function relativePath(fromDir, toPath) {
  const from = fromDir === "" ? [] : fromDir.split("/");
  const to = toPath.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  const up = from.length - shared;
  return [...Array.from({ length: up }, () => ".."), ...to.slice(shared)];
}

/** @param {string} segment @returns {string} */
function encodeSegment(segment) {
  return encodeURIComponent(segment);
}
