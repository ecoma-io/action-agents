/**
 * The Markdown mechanics every deterministic stage shares: which lines sit
 * inside fenced code blocks, which byte ranges of a line sit inside inline
 * code spans, and the structural profile a translated document is judged by.
 *
 * This is deliberately not a Markdown parser. The specification's validation
 * is "counting and syntax checking" — fences, heading levels, lists, tables,
 * blockquotes, links, frontmatter extent, balanced link syntax — because
 * the action's promise to a document is narrower than a
 * framework's: prose moves, structure holds.
 *
 * The profile is conservative by default: it refuses only unambiguous
 * structural change, and a construct it cannot parse confidently on its own
 * line is left unchecked rather than guessed. Semantically harmless reflow —
 * paragraph splitting or merging, re-wrapped lines, emphasis changes — never
 * refuses. Each property documents its own tolerance beside its definition.
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
 * A leading frontmatter block's extent, if any: `---` on the first line and a
 * closing `---` later on, both recognised by trimmed equality. An unclosed
 * leading block is not frontmatter — its `---` is just a thematic break.
 * `end` is the closing delimiter's line index, `-1` when absent.
 * @param {string[]} lines
 * @returns {{present: boolean, lines: number, end: number}}
 */
function frontmatterExtent(lines) {
  if (lines.length < 2 || lines[0]?.trim() !== "---") {
    return { present: false, lines: 0, end: -1 };
  }
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.trim() === "---") {
      return { present: true, lines: index + 1, end: index };
    }
  }
  return { present: false, lines: 0, end: -1 };
}

/**
 * A thematic break: three or more of the same break character with optional
 * spaces between them. `+` is not a break character.
 * @param {string} line
 * @returns {boolean}
 */
function thematicBreak(line) {
  return /^ {0,3}([*_-])(?:\s*\1){2,}\s*$/.test(line);
}

/**
 * @typedef {object} ListMarker
 * @property {number} indent leading spaces; tabs are never a marker
 * @property {number} width marker text plus its separating space: the item's content starts at indent + width
 * @property {boolean} ordered
 * @property {("-"|"*"|"+")|("1."|"1)")} marker normalized to shape, never the start digit
 */

/**
 * The list marker a line opens with, at any indent: a `-`, `*` or `+`, or one
 * to nine digits with a `.` or `)`, followed by whitespace. A bare marker
 * with nothing after it and thematic breaks (`- - -`, `* * *`) are not
 * items. Renumbering a list is prose, not structure: only the marker's shape
 * is kept.
 * @param {string} line
 * @returns {ListMarker | null}
 */
function listMarkerAt(line) {
  const match = /^( *)([-*+]|\d{1,9}[.)]) /.exec(line);
  if (match === null || thematicBreak(line)) return null;
  const raw = match[2] ?? "";
  const ordered = raw !== "-" && raw !== "*" && raw !== "+";
  return {
    indent: match[1]?.length ?? 0,
    width: raw.length + 1,
    ordered,
    marker: ordered ? (raw.endsWith(".") ? "1." : "1)") : /** @type {"-"|"*"|"+"} */ (raw),
  };
}

/**
 * A line's table cells, split on unescaped `|` with surrounding whitespace
 * trimmed and the blank edge cells a leading/trailing pipe produces dropped.
 * `null` when the line holds no pipe at all.
 * @param {string} line
 * @returns {string[] | null}
 */
function tableCells(line) {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.includes("|")) return null;
  /** @type {string[]} */
  const cells = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index++) {
    if (trimmed[index] === "\\" && trimmed[index + 1] === "|") {
      current += "\\|";
      index++;
      continue;
    }
    if (trimmed[index] === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += trimmed[index];
  }
  cells.push(current.trim());
  if (cells[0] === "") cells.shift();
  if (cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/**
 * A delimiter row's per-column alignment — every cell `---`, `:--`, `--:` or
 * `:--:` — or `null` when the line is anything else.
 * @param {string} line
 * @returns {("left"|"right"|"center"|"none")[] | null}
 */
function tableAlignment(line) {
  if (!line.includes("-")) return null;
  const cells = tableCells(line);
  if (cells === null || cells.length === 0) return null;
  /** @type {("left"|"right"|"center"|"none")[]} */
  const alignment = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    if (cell.startsWith(":") && cell.endsWith(":")) alignment.push("center");
    else if (cell.startsWith(":")) alignment.push("left");
    else if (cell.endsWith(":")) alignment.push("right");
    else alignment.push("none");
  }
  return alignment;
}

/**
 * The provably complete inline link and image constructs on one masked line:
 * a `](` whose parentheses close on the same line and whose `]` finds its
 * `[` walking back. Anything unprovable stays uncounted — broken shapes are
 * brokenInlineCount's business, reference-style usages `[text][id]` are
 * nobody's here.
 * @param {string} line
 * @returns {{inlineLinks: number, images: number}}
 */
function countInlineLinkConstructs(line) {
  let inlineLinks = 0;
  let images = 0;
  let claimedUntil = -1;
  for (const match of line.matchAll(/\]\(/g)) {
    const openerAt = match.index ?? 0;
    if (openerAt < claimedUntil) continue;
    let depth = 1;
    let closer = -1;
    for (let cursor = openerAt + 2; cursor < line.length; cursor++) {
      if (line[cursor] === "\\") {
        cursor++;
        continue;
      }
      if (line[cursor] === "(") depth++;
      else if (line[cursor] === ")") {
        depth--;
        if (depth === 0) {
          closer = cursor;
          break;
        }
      }
    }
    if (closer < 0) continue;
    claimedUntil = closer;
    let bracketDepth = 1;
    let opener = -1;
    for (let cursor = openerAt - 1; cursor >= 0; cursor--) {
      if (line[cursor] === "]") bracketDepth++;
      else if (line[cursor] === "[") {
        bracketDepth--;
        if (bracketDepth === 0) {
          opener = cursor;
          break;
        }
      }
    }
    if (opener < 0) continue;
    if (line[opener - 1] === "!" && line[opener - 2] !== "\\") images++;
    else inlineLinks++;
  }
  return { inlineLinks, images };
}

/**
 * One top-level list block: the shape of its opening marker, how many items
 * it holds across every nesting level, and how deep the nesting reaches.
 * Item order within the count is not recorded — a reorder of the same shape
 * is accepted. Lists inside blockquotes are left unchecked.
 * @typedef {object} ListBlockProfile
 * @property {boolean} ordered
 * @property {("-"|"*"|"+")|("1."|"1)")} marker normalized to shape, never the start digit
 * @property {number} items
 * @property {number} maxDepth
 */

/**
 * Blockquote blocks in document order: how many there are and how deep each
 * nests (`> >` is depth 2). A blank line separates blocks.
 * @typedef {object} BlockquoteProfile
 * @property {number} count
 * @property {number[]} maxDepths
 */

/**
 * One pipe table: its dimensions and the alignment its delimiter row spells.
 * `rows` counts the header plus every body row; the delimiter row itself is
 * not a row. A ragged body row neither changes `cols` nor refuses on its
 * own. Tables inside list blocks are left unchecked.
 * @typedef {object} TableProfile
 * @property {number} rows
 * @property {number} cols
 * @property {("left"|"right"|"center"|"none")[]} alignment
 */

/**
 * The link machinery a line proves on its own: complete inline links
 * (`[text](destination)`), images (`![alt](destination)`) and angle
 * autolinks (`<scheme:…>`). Destinations are never read here — the link
 * rewriter owns identity; this counts shapes only. Reference-style usages
 * and bare scheme URLs are not counted.
 * @typedef {object} LinkConstructProfile
 * @property {number} inlineLinks
 * @property {number} images
 * @property {number} autolinks
 */

/**
 * The leading frontmatter block, if the document has one: `---` on the
 * first line with a closing `---` later on. `lines` spans both delimiters;
 * the block's interior is metadata, not structure.
 * @typedef {object} FrontmatterProfile
 * @property {boolean} present
 * @property {number} lines
 */
/**
 * An open list block's walk state: the block's shape plus the stack of open
 * nesting levels, each with its marker span and delimiter type.
 * @typedef {object} ListState
 * @property {("-"|"*"|"+")|("1."|"1)")} marker
 * @property {boolean} ordered
 * @property {number} items
 * @property {number} maxDepth
 * @property {{indent: number, content: number, ordered: boolean}[]} stack
 */

/**
 * The structural profile a translation is compared against: fence count,
 * heading levels in document order, the count of visibly broken inline
 * constructs (a `[text](` whose parentheses never close on the same line,
 * outside fences and code spans), and the wider structure inventory —
 * list blocks, blockquotes, tables, reference definitions, link constructs
 * and frontmatter extent. All of it is pure counting and syntax checking.
 *
 * Raw HTML is deliberately not a block kind here: every non-fence, non-
 * frontmatter line is scanned as plain text, so HTML-native structure
 * (`<h1>`, `<ul>`/`<li>`, tag attributes) contributes nothing to the profile
 * while any markdown constructs on those lines still count line-locally.
 * HTML policy lives upstream — `sanitizeTranslationHtml` blanks dangerous
 * HTML before a candidate reaches this function — and the blindness is
 * symmetric across `compareStructuralProfiles`, so a translation that
 * rewrites markdown structure INTO HTML is still caught: the candidate's
 * heading and list counts drop against the source's.
 *
 * @typedef {object} StructuralProfile
 * @property {number} fenceCount
 * @property {string[]} fenceDelimiters each block's opening delimiter character, in document order
 * @property {number[]} headingLevels
 * @property {number} brokenInlineCount
 * @property {ListBlockProfile[]} listBlocks top-level blocks in document order
 * @property {BlockquoteProfile} blockquoteBlocks
 * @property {TableProfile[]} tables in document order
 * @property {number} referenceDefinitionCount
 * @property {LinkConstructProfile} linkConstructs
 * @property {FrontmatterProfile} frontmatter
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

  const frontmatter = frontmatterExtent(lines);

  /** @type {ListBlockProfile[]} */
  const listBlocks = [];
  /** @type {ListState | null} */
  let list = null;
  let quoteCount = 0;
  /** @type {number[]} */
  const quoteMaxDepths = [];
  let quoteOpen = false;
  /** @type {TableProfile[]} */
  const tables = [];
  /** The table whose rows are still being counted. @type {TableProfile | null} */
  let table = null;
  let referenceDefinitionCount = 0;
  let inlineLinkCount = 0;
  let imageCount = 0;
  let autolinkCount = 0;
  let blankSeen = false;

  /**
   * Retires an open list block into the profile.
   * @param {ListState | null} block
   * @returns {ListState | null}
   */
  const closeList = (block) => {
    if (block !== null) {
      listBlocks.push({
        ordered: block.ordered,
        marker: block.marker,
        items: block.items,
        maxDepth: block.maxDepth,
      });
    }
    return null;
  };

  /**
   * The state a new list block opens with.
   * @param {ListMarker} marker
   * @returns {ListState}
   */
  const openList = (marker) => ({
    marker: marker.marker,
    ordered: marker.ordered,
    items: 1,
    maxDepth: 1,
    stack: [
      { indent: marker.indent, content: marker.indent + marker.width, ordered: marker.ordered },
    ],
  });

  // The frontmatter block, when present, is metadata: the walk below starts
  // behind its closing delimiter and never reads its interior.
  for (let index = frontmatter.present ? frontmatter.end + 1 : 0; index < lines.length; index++) {
    if (fences[index] === true) {
      // A fence never closes a list (code fences live inside items), but a
      // table cannot contain one.
      if (table !== null) table = null;
      continue;
    }
    const line = maskCodeSpans(lines[index] ?? "");
    const heading = /^ {0,3}(#{1,6})(?:\s|$)/.exec(line);
    if (heading?.[1] !== undefined) headingLevels.push(heading[1].length);
    // A `[text](` whose parentheses never close on their own line: visibly
    // broken inline syntax. Multi-line destinations exist in wild Markdown,
    // but this action counts rather than renders — a translation may not add
    // new breakage of this shape.
    if (/[^\\]\]\([^)]*$/.test(line)) brokenInlineCount++;

    // Line-local machinery counts regardless of the block state below, and
    // only what a single line proves: an unprovable construct stays
    // uncounted rather than guessed.
    const constructs = countInlineLinkConstructs(line);
    inlineLinkCount += constructs.inlineLinks;
    imageCount += constructs.images;
    autolinkCount += line.match(/<[a-zA-Z][a-zA-Z0-9+.-]*:[^<>]*>/g)?.length ?? 0;
    if (/^ {0,3}\[[^\]]+\]:\s*\S/.test(line)) referenceDefinitionCount++;

    if (line.trim() === "") {
      if (table !== null) table = null;
      quoteOpen = false;
      blankSeen = true;
      continue;
    }

    if (heading?.[1] !== undefined) {
      // A heading interrupts everything open beneath it.
      list = closeList(list);
      if (table !== null) table = null;
      quoteOpen = false;
      blankSeen = false;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      if (!quoteOpen) {
        quoteOpen = true;
        quoteCount++;
        quoteMaxDepths.push(0);
      }
      const markers = /^ {0,3}(?:>\s*)+/.exec(line)?.[0] ?? "";
      quoteMaxDepths[quoteCount - 1] = Math.max(
        quoteMaxDepths[quoteCount - 1] ?? 0,
        markers.match(/>/g)?.length ?? 0,
      );
      // A blockquote interrupts a list; a table cannot hold one.
      list = closeList(list);
      if (table !== null) table = null;
      blankSeen = false;
      continue;
    }

    if (table !== null) {
      // Inside a table every piped line is a row; the first line without a
      // pipe ends it and falls through as plain content.
      if (tableCells(line) !== null) {
        table.rows++;
        blankSeen = false;
        continue;
      }
      table = null;
    }

    const indent = line.length - line.trimStart().length;
    // A non-quote line directly after a quote line is that quote's lazy
    // continuation: left unchecked rather than guessed.
    const quoteLazy = quoteOpen;
    const marker = quoteLazy ? null : listMarkerAt(line);

    if (list === null && marker !== null && marker.indent < 4) {
      list = openList(marker);
      blankSeen = false;
      continue;
    }

    if (list !== null) {
      if (marker !== null) {
        // Which open level does this marker join? A marker nests under the
        // innermost item when its indent reaches that item's content
        // column; otherwise it is a sibling of the level whose span holds
        // its indent.
        let joined = -1;
        for (let depth = list.stack.length - 1; depth >= 0; depth--) {
          const entry = list.stack[depth];
          if (marker.indent >= (entry?.indent ?? 0) && marker.indent < (entry?.content ?? 0)) {
            joined = depth;
            break;
          }
        }
        if (joined !== -1 && marker.ordered !== (list.stack[joined]?.ordered ?? false)) {
          // A delimiter type change starts a new list, not a sibling item.
          closeList(list);
          list = openList(marker);
          blankSeen = false;
          continue;
        }
        if (joined === -1) {
          const innermost = list.stack[list.stack.length - 1];
          if (marker.indent >= (innermost?.content ?? 0)) {
            // A nested level under the innermost open item.
            list.stack.push({
              indent: marker.indent,
              content: marker.indent + marker.width,
              ordered: marker.ordered,
            });
            list.maxDepth = Math.max(list.maxDepth, list.stack.length);
          } else {
            // Shallower than every open level: a new block begins here.
            closeList(list);
            list = openList(marker);
            blankSeen = false;
            continue;
          }
        } else {
          list.stack.length = joined + 1;
        }
        list.items++;
        blankSeen = false;
        continue;
      }
      if (!(indent < 4 && blankSeen)) {
        // Indented content, or a lazy continuation of the open item.
        blankSeen = false;
        continue;
      }
      // Prose after a blank line ends the block and may open a table.
      list = closeList(list);
    }

    if (
      !quoteLazy &&
      indent < 4 &&
      line.includes("|") &&
      index + 1 < lines.length &&
      !fences[index + 1] &&
      !/^ {4}/.test(lines[index + 1] ?? "")
    ) {
      const header = tableCells(line);
      const alignment =
        header === null ? null : tableAlignment(maskCodeSpans(lines[index + 1] ?? ""));
      if (
        header !== null &&
        alignment !== null &&
        header.length > 0 &&
        header.length === alignment.length
      ) {
        table = { rows: 1, cols: header.length, alignment };
        tables.push(table);
        index++; // The delimiter row is consumed with its header.
        blankSeen = false;
        continue;
      }
    }

    blankSeen = false;
  }

  closeList(list);

  return {
    fenceCount,
    fenceDelimiters,
    headingLevels,
    brokenInlineCount,
    listBlocks,
    blockquoteBlocks: { count: quoteCount, maxDepths: quoteMaxDepths },
    tables,
    referenceDefinitionCount,
    linkConstructs: {
      inlineLinks: inlineLinkCount,
      images: imageCount,
      autolinks: autolinkCount,
    },
    frontmatter: { present: frontmatter.present, lines: frontmatter.lines },
  };
}

/**
 * The structural verdict on a translated document, per the specification:
 * fence counts match, heading levels hold their sequence, broken inline
 * syntax does not increase, and the wider structure inventory — list blocks,
 * blockquotes, tables, reference definitions, link constructs, frontmatter —
 * reconciles. Returns the violations found — an empty list is the pass.
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

  if (candidate.listBlocks.length !== source.listBlocks.length) {
    violations.push(
      `list block count changed: ${String(source.listBlocks.length)} → ` +
        `${String(candidate.listBlocks.length)}`,
    );
  }
  const listShared = Math.min(source.listBlocks.length, candidate.listBlocks.length);
  for (let index = 0; index < listShared; index++) {
    const expected = source.listBlocks[index];
    const actual = candidate.listBlocks[index];
    if ((expected?.marker ?? "") !== (actual?.marker ?? "")) {
      violations.push(
        `list block ${String(index + 1)} marker changed: ${expected?.marker ?? ""} to ` +
          `${actual?.marker ?? ""}`,
      );
      break;
    }
    if ((expected?.items ?? 0) !== (actual?.items ?? 0)) {
      violations.push(
        `list block ${String(index + 1)} item count changed: ${String(expected?.items ?? 0)} → ` +
          `${String(actual?.items ?? 0)}`,
      );
      break;
    }
    if ((expected?.maxDepth ?? 0) !== (actual?.maxDepth ?? 0)) {
      violations.push(
        `list block ${String(index + 1)} max depth changed: ${String(expected?.maxDepth ?? 0)} → ` +
          `${String(actual?.maxDepth ?? 0)}`,
      );
      break;
    }
  }

  if (candidate.blockquoteBlocks.count !== source.blockquoteBlocks.count) {
    violations.push(
      `blockquote count changed: ${String(source.blockquoteBlocks.count)} → ` +
        `${String(candidate.blockquoteBlocks.count)}`,
    );
  }
  const quoteShared = Math.min(
    source.blockquoteBlocks.maxDepths.length,
    candidate.blockquoteBlocks.maxDepths.length,
  );
  for (let index = 0; index < quoteShared; index++) {
    const expected = source.blockquoteBlocks.maxDepths[index] ?? 0;
    const actual = candidate.blockquoteBlocks.maxDepths[index] ?? 0;
    if (expected !== actual) {
      violations.push(
        `blockquote block ${String(index + 1)} max depth changed: ${String(expected)} → ` +
          `${String(actual)}`,
      );
      break;
    }
  }

  if (candidate.tables.length !== source.tables.length) {
    violations.push(
      `table count changed: ${String(source.tables.length)} → ` +
        `${String(candidate.tables.length)}`,
    );
  }
  const tableShared = Math.min(source.tables.length, candidate.tables.length);
  for (let index = 0; index < tableShared; index++) {
    const expected = source.tables[index];
    const actual = candidate.tables[index];
    if ((expected?.rows ?? 0) !== (actual?.rows ?? 0)) {
      violations.push(
        `table ${String(index + 1)} row count changed: ${String(expected?.rows ?? 0)} → ` +
          `${String(actual?.rows ?? 0)}`,
      );
      break;
    }
    if ((expected?.cols ?? 0) !== (actual?.cols ?? 0)) {
      violations.push(
        `table ${String(index + 1)} column count changed: ${String(expected?.cols ?? 0)} → ` +
          `${String(actual?.cols ?? 0)}`,
      );
      break;
    }
    if ((expected?.alignment ?? []).join(",") !== (actual?.alignment ?? []).join(",")) {
      violations.push(
        `table ${String(index + 1)} column alignment changed: ` +
          `${expected?.alignment.join(",") ?? ""} to ${actual?.alignment.join(",") ?? ""}`,
      );
      break;
    }
  }

  if (candidate.referenceDefinitionCount !== source.referenceDefinitionCount) {
    violations.push(
      `reference definition count changed: ${String(source.referenceDefinitionCount)} → ` +
        `${String(candidate.referenceDefinitionCount)}`,
    );
  }

  if (candidate.linkConstructs.inlineLinks !== source.linkConstructs.inlineLinks) {
    violations.push(
      `inline link count changed: ${String(source.linkConstructs.inlineLinks)} → ` +
        `${String(candidate.linkConstructs.inlineLinks)}`,
    );
  }
  if (candidate.linkConstructs.images !== source.linkConstructs.images) {
    violations.push(
      `image count changed: ${String(source.linkConstructs.images)} → ` +
        `${String(candidate.linkConstructs.images)}`,
    );
  }
  if (candidate.linkConstructs.autolinks !== source.linkConstructs.autolinks) {
    violations.push(
      `autolink count changed: ${String(source.linkConstructs.autolinks)} → ` +
        `${String(candidate.linkConstructs.autolinks)}`,
    );
  }

  if (candidate.frontmatter.present !== source.frontmatter.present) {
    violations.push(
      `frontmatter presence changed: ${source.frontmatter.present ? "present" : "absent"} to ` +
        `${candidate.frontmatter.present ? "present" : "absent"}`,
    );
  } else if (
    source.frontmatter.present &&
    candidate.frontmatter.present &&
    source.frontmatter.lines !== candidate.frontmatter.lines
  ) {
    violations.push(
      `frontmatter line count changed: ${String(source.frontmatter.lines)} → ` +
        `${String(candidate.frontmatter.lines)}`,
    );
  }

  return violations;
}
