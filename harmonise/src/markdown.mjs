/**
 * The Markdown mechanics every deterministic stage shares: which lines sit
 * inside fenced code blocks, which byte ranges of a line sit inside inline
 * code spans, and the structural profile a translated document is judged by.
 *
 * This is deliberately not a Markdown parser. The specification's validation
 * is "counting and syntax checking" — fences, heading levels, balanced link
 * syntax — because the action's promise to a document is narrower than a
 * framework's: prose moves, structure holds.
 *
 * One subtlety does the work throughout: masking preserves byte offsets. A
 * masked region keeps its exact length (interior replaced by NUL characters),
 * so a regex match found in masked output points at the same columns in the
 * original line. Nothing ever needs to un-mask to know where it is.
 */

/**
 * Per-line fence state for a whole document. A fence opens on a line of three
 * or more backticks or tildes (up to three leading spaces, info string after
 * it is fine) and closes on a line of the same character at least as long.
 * The state array marks whether each line sits INSIDE a fence — the opening
 * and closing delimiter lines themselves are marked true: they are fence, not
 * content.
 *
 * @param {string[]} lines
 * @returns {boolean[]} parallel to `lines`
 */
export function fenceMask(lines) {
  /** @type {boolean[]} */
  const mask = new Array(lines.length).fill(false);
  /** @type {{ char: string, length: number } | undefined} */
  let open;
  for (const [index, line] of lines.entries()) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const delimiter = match?.[1];
    if (
      open !== undefined &&
      delimiter !== undefined &&
      delimiter[0] === open.char &&
      delimiter.length >= open.length &&
      line.trim() === delimiter
    ) {
      // Closing delimiter — fence, not content.
      mask[index] = true;
      open = undefined;
    } else if (open !== undefined) {
      mask[index] = true;
    } else if (delimiter !== undefined) {
      open = { char: delimiter[0] ?? "`", length: delimiter.length };
      mask[index] = true;
    }
  }
  return mask;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  return text.split("\n");
}

/**
 * Masks inline code spans in one line, preserving byte offsets: the span's
 * interior becomes NUL characters of the same total length, so column
 * positions survive. Unescaped backtick runs of length ≥ 1 toggle a span;
 * a backtick escaped with `\` never toggles. An unterminated span masks to
 * end of line — conservative, and never wrong about columns.
 *
 * @param {string} line
 * @returns {string}
 */
export function maskCodeSpans(line) {
  let out = "";
  let runStart = -1;
  let inSpan = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? "";
    if (char === "\\" && !inSpan) {
      out += line.slice(index, index + 2);
      index++;
      continue;
    }
    if (char !== "`") {
      out += inSpan ? "\u0000" : char;
      continue;
    }
    // A backtick run: all its characters belong to the delimiter.
    let run = index;
    while (line[run + 1] === "`") run++;
    const length = run - index + 1;
    if (!inSpan) {
      runStart = length;
      inSpan = true;
      out += line.slice(index, run + 1);
    } else if (length === runStart) {
      inSpan = false;
      out += line.slice(index, run + 1);
    } else {
      // A different-length run inside a span is span content.
      out += "\u0000".repeat(length);
    }
    index = run;
  }
  return out;
}

/**
 * Masks the machinery half of one line so prose-only scanners (the glossary)
 * never match inside it: inline link and image destinations, reference
 * definition destinations, angle autolinks, and bare scheme URLs. Like every
 * mask here it preserves byte length — each masked interior becomes NUL
 * characters of the same size, so column positions survive untouched. All
 * ranges are UTF-16 code-unit offsets and the blank-out walks the line as
 * code units, so astral characters shift nothing.
 *
 * Link TEXT stays visible: `[see the repository](repo.md)` keeps "see the
 * repository" matchable while `repo.md` is machinery. An inline construct's
 * whole parenthesized interior is machinery — destination and quoted title
 * alike — because its extent is what the depth scan can prove; reference
 * definitions mask only their destination token and keep titles visible.
 * A construct that never closes on its line proves nothing and is left
 * unmasked end to end.
 *
 * @param {string} line a line that may already carry code-span masking
 * @returns {string}
 */
export function maskDestinations(line) {
  /** @type {[number, number][]} */ // [start, end) ranges to blank out
  const ranges = [];

  // Reference definitions: the first token after `[label]:` is machinery,
  // located by its own match index — never searched for, or a label that
  // repeats the destination's text would steal the mask.
  const definition = /^ {0,3}\[[^\]]*\]:\s*(<[^>]*>|\S+)/.exec(line);
  if (definition !== null && definition[1] !== undefined) {
    const at = definition.index + definition[0].length - definition[1].length;
    ranges.push([at, at + definition[1].length]);
  }

  // Angle autolinks — `<https://…>` — are one whole piece of machinery.
  for (const match of line.matchAll(/<[a-zA-Z][a-zA-Z0-9+.-]*:[^<>]*>/g)) {
    ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }

  // Bare scheme URLs riding in prose (`https://…` with no bracket around).
  for (const match of line.matchAll(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g)) {
    ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }

  // Inline link/image destinations: every `]( … )`, paren-depth aware, the
  // same scan the link rewriter uses. A construct that never closes on its
  // line is authoring slop whose extent cannot be proven — it is left
  // entirely unmasked, exactly as the rewriter leaves it unrewritten, so
  // prose after it keeps full glossary protection rather than being eaten.
  /** @type {number} */
  let claimedUntil = -1;
  for (const match of line.matchAll(/\]\(/g)) {
    const openerAt = match.index ?? 0;
    if (openerAt < claimedUntil) continue;
    let cursor = openerAt + 2;
    let depth = 1;
    let end = -1;
    while (cursor < line.length) {
      const char = line[cursor] ?? "";
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
    claimedUntil = end;
    // The interior between `(` and `)` is machinery either way — angle
    // brackets included.
    ranges.push([openerAt + 2, end]);
  }

  if (ranges.length === 0) return line;
  const out = line.split("");
  for (const [from, to] of ranges) {
    for (let index = from; index < to && index < out.length; index++) out[index] = "\u0000";
  }
  return out.join("");
}
/**
 * Where one inline construct's parentheses close: the index of the `)` that
 * ends the destination that opens just past `start`, scanned with paren
 * depth and backslash escapes — the same extent scan the link rewriter and
 * the destination mask walk their lines with, shared so extraction agrees
 * with both on where a construct's bytes end. -1 when the line ends first:
 * a construct that never closes proves nothing and belongs to no scanner.
 *
 * @param {string} masked a line with code spans masked
 * @param {number} start just past the `(`, or at the opening angle bracket
 * @returns {number} the index of the closing `)`, or -1
 */
export function destinationEnd(masked, start) {
  let cursor = start;
  let depth = 1;
  while (cursor < masked.length) {
    const char = masked[cursor] ?? "";
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") {
      depth--;
      if (depth === 0) return cursor;
    }
    cursor++;
  }
  return -1;
}

/**
 * The structural profile a translation is compared against: fence count,
 * heading levels in document order, and the count of visibly broken inline
 * constructs (a `[text](` whose parentheses never close on the same line,
 * outside fences and code spans). All three are pure counting.
 *
 * @typedef {object} StructuralProfile
 * @property {number} fenceCount
 * @property {string[]} fenceDelimiters each block's opening delimiter character, in document order
 * @property {number[]} headingLevels
 * @property {number} brokenInlineCount
 */

/**
 * @param {string} text
 * @returns {StructuralProfile}
 */
export function structuralProfile(text) {
  const lines = splitLines(text);
  const fences = fenceMask(lines);

  // Counted by walking the same state the mask was built from, not by mask
  // transitions: a closing delimiter followed directly by an opener is TWO
  // blocks back-to-back, and only a real state walk sees both.
  let fenceCount = 0;
  /** @type {string[]} */
  const fenceDelimiters = [];
  /** @type {string | undefined} */
  let open;
  for (const line of lines) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (open === undefined && delimiter !== undefined) {
      open = delimiter[0] ?? "`";
      fenceCount++;
      fenceDelimiters.push(open);
      continue;
    }
    if (
      open !== undefined &&
      delimiter !== undefined &&
      delimiter[0] === open &&
      line.trim() === delimiter
    ) {
      open = undefined;
    }
  }

  /** @type {number[]} */
  const headingLevels = [];
  let brokenInlineCount = 0;

  for (const [index, rawLine] of lines.entries()) {
    if (fences[index] === true) continue;
    const line = maskCodeSpans(rawLine);
    const heading = /^ {0,3}(#{1,6})(?:\s|$)/.exec(line);
    if (heading?.[1] !== undefined) headingLevels.push(heading[1].length);
    // A `[text](` whose parentheses never close on their own line: visibly
    // broken inline syntax. Multi-line destinations exist in wild Markdown,
    // but this action counts rather than renders — a translation may not add
    // new breakage of this shape.
    if (/[^\\]\]\([^)]*$/.test(line)) brokenInlineCount++;
  }

  return { fenceCount, fenceDelimiters, headingLevels, brokenInlineCount };
}

/**
 * The structural verdict on a translated document, per the specification:
 * fence counts match, heading levels hold their sequence, and broken inline
 * syntax does not increase. Returns the violations found — an empty list is
 * the pass.
 *
 * @param {StructuralProfile} source
 * @param {StructuralProfile} candidate
 * @returns {string[]}
 */
export function compareStructuralProfiles(source, candidate) {
  /** @type {string[]} */
  const violations = [];

  if (candidate.fenceCount !== source.fenceCount) {
    violations.push(
      `fenced code block count changed: ${String(source.fenceCount)} → ${String(candidate.fenceCount)}`,
    );
  } else if (candidate.fenceDelimiters.join("") !== source.fenceDelimiters.join("")) {
    // Same number of blocks but the tilde/backtick sequence differs — blocks
    // were reordered or re-charactered, which is restructure, not translation.
    violations.push("fenced code blocks appear in a different order or kind");
  }

  const shorter = Math.min(source.headingLevels.length, candidate.headingLevels.length);
  for (let index = 0; index < shorter; index++) {
    const expected = source.headingLevels[index];
    const actual = candidate.headingLevels[index];
    if (expected !== actual) {
      violations.push(
        `heading ${String(index + 1)} changed level: h${String(expected)} → h${String(actual)}`,
      );
      break;
    }
  }
  if (candidate.headingLevels.length !== source.headingLevels.length) {
    violations.push(
      `heading count changed: ${String(source.headingLevels.length)} → ` +
        `${String(candidate.headingLevels.length)}`,
    );
  }

  if (candidate.brokenInlineCount > source.brokenInlineCount) {
    violations.push(
      `broken inline link/image syntax increased: ${String(source.brokenInlineCount)} → ` +
        `${String(candidate.brokenInlineCount)}`,
    );
  }

  return violations;
}
