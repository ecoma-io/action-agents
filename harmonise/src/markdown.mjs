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
 * The structural profile a translation is compared against: fence count,
 * heading levels in document order, and the count of visibly broken inline
 * constructs (a `[text](` whose parentheses never close on the same line,
 * outside fences and code spans). All three are pure counting.
 *
 * @typedef {object} StructuralProfile
 * @property {number} fenceCount
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

  // One count per fence pair: the false→true transition where it opens.
  let fenceCount = 0;
  for (let index = 0; index < fences.length; index++) {
    if (fences[index] === true && (index === 0 || fences[index - 1] !== true)) fenceCount++;
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

  return { fenceCount, headingLevels, brokenInlineCount };
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
