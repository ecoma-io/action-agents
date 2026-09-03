// One JavaScript text scanner for the gates that must read source the way the
// language reads it, not the way grep does.
//
// The monopoly checks (check-http-monopoly, check-forge-monopoly) look for
// call-shaped facts: a bare fetch call or a "method: POST" argument. The
// difference between a violation and a sentence in a comment is exactly the
// difference this module exists to make. A naive line scan misreads the tree
// in both directions at once:
//
//   - a comment or a string naming a verb or a fetch call reports a violation
//     nobody committed — noise that teaches contributors to ignore the gate;
//   - a line whose real code sits after a regular expression containing two
//     slashes is swallowed whole, because the pattern's own delimiters look
//     like a line comment — a blind spot on the exact line a violator would
//     choose.
//
// maskCode replaces every character that is NOT code — comments, string and
// template-literal text, regular-expression bodies — with a space, preserving
// all newlines and every offset, so a gate can run its patterns over the
// masked text and report file:line from the same coordinates. Code inside a
// template-literal interpolation is code and stays code: masking it would
// open the bypass the masking exists to close.
//
// There is no JS parser in this repository (no dependencies is repo law), so
// this is a deliberately conservative state machine: it recognises the
// lexical shapes that matter and, where JavaScript is genuinely ambiguous — a
// slash that could open a regular expression or divide — it resolves the
// ambiguity with the standard preceding-token heuristic, reading backwards
// over the already-masked text so comments and strings are transparent to
// it. The gates that consume this output hold canary fixtures that fail
// loudly if the heuristic ever stops matching the real tree.
//
// The module's whole contract: offsets into the masked string are offsets
// into the source.

/**
 * The states the scanner moves between. "code" is the only state whose
 * characters survive masking.
 *
 * @typedef {"code" | "line-comment" | "block-comment" | "single-quote" |
 *   "double-quote" | "template" | "regex" | "regex-class"} ScanState
 */

/**
 * An open template-literal interpolation: the dollar-brace was seen, code
 * resumed, and the scanner pops back to the template when this
 * interpolation's braces close.
 *
 * @typedef {object} Interpolation
 * @property {number} depth open braces inside the interpolation, above the
 *   dollar-brace itself
 */

/** Keywords after which a slash opens a regular expression, not a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

/**
 * Masks every non-code character of `source` with a space.
 *
 * Newlines are preserved byte-for-byte, so the masked string has exactly the
 * source's length, and line numbers computed over one are line numbers over
 * the other.
 *
 * @param {string} source the exact text of a JavaScript module
 * @returns {string} same length; code preserved, everything else blanked
 */
export function maskCode(source) {
  const out = source.split("");
  /** @type {ScanState} */
  let state = "code";
  /** @type {Interpolation[]} */
  const interpolations = [];

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";

    if (state === "code") {
      if (ch === "/" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 1;
        state = "line-comment";
      } else if (ch === "/" && next === "*") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 1;
        state = "block-comment";
      } else if (ch === "/") {
        if (startsRegexAt(out, i)) {
          out[i] = " ";
          state = "regex";
        }
      } else if (ch === "'") {
        out[i] = " ";
        state = "single-quote";
      } else if (ch === '"') {
        out[i] = " ";
        state = "double-quote";
      } else if (ch === "`") {
        out[i] = " ";
        state = "template";
      } else {
        const top = interpolations.at(-1);
        if (top !== undefined && (ch === "{" || ch === "}")) {
          if (ch === "{") {
            top.depth += 1;
          } else if (top.depth === 0) {
            interpolations.pop();
            out[i] = " ";
            state = "template";
          } else {
            top.depth -= 1;
          }
        }
      }
      continue;
    }

    // Every remaining state blanks its characters — with one exception the
    // whole module stands on: a newline is never blanked, in any state, so
    // masked text and source share their line grid.

    if (state === "line-comment") {
      if (ch === "\n") {
        state = "code";
      } else {
        out[i] = " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (ch === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 1;
        state = "code";
      } else if (ch !== "\n") {
        out[i] = " ";
      }
      continue;
    }

    if (state === "single-quote" || state === "double-quote") {
      if (ch === "\\") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 1;
      } else if (ch === "\n") {
        // A raw newline cannot appear inside a finished string literal; a
        // scanner that trusted the closing quote to arrive would blank the
        // rest of the file when one never does. Treat the string as ended.
        state = "code";
      } else {
        out[i] = " ";
        if ((state === "single-quote" && ch === "'") || (state === "double-quote" && ch === '"')) {
          state = "code";
        }
      }
      continue;
    }

    if (state === "template") {
      if (ch === "\\") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 1;
      } else if (ch === "`") {
        out[i] = " ";
        state = "code";
      } else if (ch === "$" && next === "{") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 1;
        interpolations.push({ depth: 0 });
        state = "code";
      } else if (ch !== "\n") {
        out[i] = " ";
      }
      continue;
    }

    // "regex" and "regex-class".
    if (ch === "\\") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 1;
    } else if (ch === "\n") {
      // A regular expression cannot span lines either; an unterminated one
      // ends at the newline for the same reason an unterminated string does.
      state = "code";
    } else {
      out[i] = " ";
      if (state === "regex") {
        if (ch === "[") {
          state = "regex-class";
        } else if (ch === "/") {
          state = "code";
        }
      } else if (ch === "]") {
        state = "regex";
      }
    }
  }

  return out.join("");
}

/**
 * Whether a slash at `index` opens a regular expression, judged from the
 * preceding significant token of the already-masked text — the standard
 * heuristic: a regex may follow an operator, an opening bracket, a comma, a
 * colon or a keyword; a division follows an operand (a closing bracket, an
 * identifier, a literal).
 *
 * Reading the masked text rather than the source makes comments and strings
 * transparent: they are already spaces here, so the scan skips them and
 * lands on the previous real token.
 *
 * @param {string[]} out masked output so far
 * @param {number} index position of the slash (still unblanked)
 * @returns {boolean}
 */
function startsRegexAt(out, index) {
  let j = index - 1;
  while (j >= 0 && /\s/.test(out[j])) j -= 1;
  if (j < 0) return true; // nothing but the file start before it
  const ch = out[j];
  if (/[A-Za-z0-9_$]/.test(ch)) {
    // The identifier run ending here: a keyword means regex, an operand
    // means division.
    let start = j;
    while (start > 0 && /[A-Za-z0-9_$]/.test(out[start - 1])) start -= 1;
    return REGEX_PRECEDING_KEYWORDS.has(out.slice(start, j + 1).join(""));
  }
  return "([{,;=:!&|?+-*%~^<>/".includes(ch);
}

/**
 * The 1-based line a source offset falls on.
 *
 * @param {string} text text whose newlines are counted (masked or original —
 *   they share offsets by construction)
 * @param {number} index offset into that text
 * @returns {number} the 1-based line number
 */
export function lineOf(text, index) {
  let line = 1;
  const end = Math.min(index, text.length);
  for (let i = 0; i < end; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}
