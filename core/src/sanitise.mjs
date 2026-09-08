/**
 * What model text must survive before it can become comment text.
 *
 * Everything a model wrote that a human reads as comment text passes through
 * here — the one deliberate exception is `harmonise`'s document content,
 * written verbatim for the reason its page carries. Sanitising is lossy on
 * purpose: a finding mangled by these rules is the intended outcome, and a
 * readable finding that notifies someone or forges the comment's structure
 * is the bug the rules exist to prevent.
 *
 * The rules, each testable, in the order they run:
 *
 * 0. **No non-text control character survives.** C0 controls beyond the
 *    three whitespace controls — TAB, LF and CR are legitimate, layout-
 *    carrying text on every surface that consumes this module — are mapped
 *    to a space before any other rule. What is stripped is the class a
 *    hostile message has no clean use for: NUL, BEL, other graphic and line
 *    controls, DEL. Those never render as text, and on the run log a lone
 *    line-break control before `::` can start a runner workflow command the
 *    action never wrote — the boundary this rule guards is the class of
 *    bytes the SARIF projection already strips (`presentMessage`), kept
 *    byte-aligned for the never-text controls while TAB/LF/CR survive to do
 *    their job. The one strictly-line-shaped classifier the log surfaces
 *    apply — `one-line.mjs` maps the full C0 range — flattens where this
 *    module preserves, because a log line is one line by construction and a
 *    comment body is not. U+2028/U+2029 are code-point separators, not C0;
 *    they are not stripped here.
 *
 * 1. **No structural token survives.** The comment's own scaffolding is
 *    built from HTML comments — the marker and any metadata around it — so
 *    `<!--` and `-->` are removed outright from model text, along with any
 *    exact string the caller forbids (its own marker). Injected Markdown
 *    cannot close a container early, and cannot pose as the action's voice.
 *    Everything removed is counted and returned, so the caller logs it.
 *
 * 2. **No raw HTML renders.** A tag-shaped `<` outside a code span is
 *    entity-escaped, so model text carries structure only as Markdown the
 *    comment's scaffolding already chose. Code spans and fenced blocks are
 *    left alone — escaping inside them would corrupt the very text it was
 *    meant to make safe, and inside code nothing renders as HTML anyway.
 *
 * 3. **No mention parses.** An `@` followed by an identifier character is
 *    broken up with a zero-width non-joiner, so nothing an action writes can
 *    notify anyone, on any re-run.
 *
 * 4. **Length caps, visibly.** A field cut is marked cut, never silently
 *    dropped.
 */

/** The default cap on sanitised text: enough for a real paragraph of findings. */
export const DEFAULT_MAX_CHARS = 1000;

/** An `@` that would begin a username or team handle on GitHub. */
const MENTION = /@(?=[A-Za-z0-9_])/g;

/** A `<` that begins a tag: a letter or a closing slash-letter. */
const TAG = /<(?=\/?[A-Za-z])/g;

const ZERO_WIDTH_NON_JOINER = "\u200C";
const TRUNCATION_MARK = "…[truncated]";

/**
 * @typedef {object} SanitiseOptions
 * @property {number} [maxChars] the cap, marked visibly when it bites
 * @property {string[]} [forbidden] exact strings to remove outright — the caller's own marker
 */

/**
 * @param {string} text model text on its way into a comment
 * @param {SanitiseOptions} [options]
 * @returns {{ text: string, notes: string[] }} the sanitised text, and one note per rule that bit
 */
export function sanitiseCommentText(text, options = {}) {
  /** @type {string[]} */
  const notes = [];

  const uncontrol = stripControlChars(text);
  const stripped = stripStructural(uncontrol, options.forbidden ?? [], notes);
  const escaped = escapeTags(stripped);
  const unmentionable = breakMentions(escaped);
  const capped = cap(unmentionable, options.maxChars ?? DEFAULT_MAX_CHARS, notes);

  return { text: capped, notes };
}

/**
 * Rule 0. C0 controls beyond TAB, LF and CR — plus DEL — are mapped to
 * spaces before anything else. The three whitespace controls are real text
 * (a multi-line comment and a record carry them); the rest of C0 (NUL, BEL,
 * the graphic/line packages) and DEL are never text on these surfaces, and
 * `one-line.mjs` on the log flattens even TAB/LF/CR because a log line is
 * one line by construction. This keeps the never-text class byte-aligned
 * with the SARIF projection's `presentMessage` while layout survives.
 *
 * @param {string} text
 * @returns {string}
 */
function stripControlChars(text) {
  /** @type {string[]} */
  const out = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isLayoutControl = code === 0x09 || code === 0x0a || code === 0x0d;
    out.push((code <= 0x1f && !isLayoutControl) || code === 0x7f ? " " : char);
  }
  return out.join("");
}

/**
 * Rule 1. Structural tokens and the caller's forbidden strings are removed,
 * never rendered, and every removal is counted for the log.
 *
 * @param {string} text
 * @param {string[]} forbidden
 * @param {string[]} notes
 * @returns {string}
 */
function stripStructural(text, forbidden, notes) {
  let removed = 0;
  let out = text;
  // The specific before the general: a forbidden string is usually a whole
  // marker, and removing `<!--` first would shred it into a half-match.
  for (const token of [...forbidden, "<!--", "-->"]) {
    if (token === "") continue;
    const count = out.split(token).length - 1;
    if (count > 0) {
      out = out.split(token).join("");
      removed += count;
    }
  }
  if (removed > 0) {
    notes.push(
      `removed ${String(removed)} structural token(s) from model text ` +
        `(comment markers cannot be forged)`,
    );
  }
  return out;
}

/**
 * Rule 2. Escape a tag-shaped `<` outside code, where "outside code" is
 * decided line-wise: fenced blocks are skipped whole, and inline code spans
 * are skipped within a line. A code span that spans lines is not a shape
 * these comments carry; escaping inside such a rare span is the safe
 * direction — the text renders escaped rather than rendering as HTML.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeTags(text) {
  /** @type {string[]} */
  const lines = [];
  let fenced = false;

  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      lines.push(line);
      fenced = !fenced;
      continue;
    }
    lines.push(fenced ? line : escapeOutsideInlineCode(line));
  }
  return lines.join("\n");
}

/**
 * Escapes tag-shaped `<` on one line, leaving inline code spans alone.
 *
 * @param {string} line
 * @returns {string}
 */
function escapeOutsideInlineCode(line) {
  /** @type {string[]} */
  const parts = [];
  let rest = line;

  for (;;) {
    const opening = /`+/.exec(rest);
    if (opening === null) {
      parts.push(rest.replace(TAG, "&lt;"));
      return parts.join("");
    }
    const before = rest.slice(0, opening.index);
    const ticks = opening[0];
    parts.push(before.replace(TAG, "&lt;"));
    parts.push(ticks);
    rest = rest.slice(opening.index + ticks.length);

    const closing = new RegExp("`".repeat(ticks.length)).exec(rest);
    if (closing === null) {
      // No closing run: the whole remainder is outside a code span.
      parts.push(rest.replace(TAG, "&lt;"));
      return parts.join("");
    }
    parts.push(rest.slice(0, closing.index + ticks.length));
    rest = rest.slice(closing.index + ticks.length);
  }
}

/**
 * Rule 3. The zero-width non-joiner sits between the `@` and the name, so
 * no re-render, re-run or copy-paste reassembles a notifying mention.
 *
 * @param {string} text
 * @returns {string}
 */
function breakMentions(text) {
  return text.replace(MENTION, `@${ZERO_WIDTH_NON_JOINER}`);
}

/**
 * Rule 4. The cut is marked inside the text, never silent. The metric is
 * UTF-16 length — what `String.prototype.length` counts and what every
 * validator and surface bound reads back — never the code-point count,
 * which astral-plane text drives past the very bound the cap exists to
 * keep (#347). The cut never splits a surrogate pair: a lone half is
 * corrupt text, not truncated text.
 *
 * @param {string} text
 * @param {number} maxChars
 * @param {string[]} notes
 * @returns {string}
 */
function cap(text, maxChars, notes) {
  if (text.length <= maxChars) return text;
  // "text", not "model text": the cap serves surfaces beyond model output —
  // a thrown error's message rides it on the red-reason path.
  notes.push(`truncated text from ${String(text.length)} to ${String(maxChars)} characters`);
  let cut = Math.max(0, maxChars - TRUNCATION_MARK.length);
  if (
    cut > 0 &&
    cut < text.length &&
    text.charCodeAt(cut - 1) >= 0xd800 &&
    text.charCodeAt(cut - 1) <= 0xdbff &&
    text.charCodeAt(cut) >= 0xdc00 &&
    text.charCodeAt(cut) <= 0xdfff
  ) {
    cut -= 1;
  }
  return `${text.slice(0, cut)}${TRUNCATION_MARK}`;
}
