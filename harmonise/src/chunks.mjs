/**
 * `harmonise` document chunking — per-chunk bounded payloads that replace
 * the whole-document semantic ceiling.
 *
 * A document larger than one chunk is accepted and partitioned
 * deterministically at Markdown structural boundaries; the reassembled
 * document equals the original byte-for-byte. No content is truncated,
 * dropped or reordered, and no single chunk exceeds `MAX_CHUNK_BYTES`
 * UTF-8 bytes.
 *
 * The chunker is a pure function over the source document; it runs before
 * protection and rewriting, so it knows nothing about glossary tokens or
 * link context. After chunking, each chunk is independently protected,
 * rewritten, sent to the provider, parsed, restored and sanitised; the
 * reassembled whole is then judged by the same whole-document gates the
 * single-chunk path already uses (script, frontmatter, structural
 * profile, links).
 *
 * ## Atomic units — what a chunk never splits
 *
 * 1. **Frontmatter** — lines from the document head through the closing
 *    `---` (if present).
 * 2. **Fenced code blocks** — every line the shared fence mask marks as
 *    delimiter or interior, through the closing delimiter (or EOF for an
 *    unclosed fence).
 * 3. **Harmonise protected regions** — `skip-start` through its `skip-end`,
 *    markers included; a lone `skip` plus its settled target line.
 * 4. **Normal content** — a maximal run of non-blank lines outside the
 *    above; a blank line outside fences and directives is a boundary.
 *
 * ## Two offset systems, never mixed
 *
 * Slicing uses CHAR offsets (`String.slice` semantics); budget measuring
 * converts the sliced chunk to UTF-8 bytes with `TextEncoder`. Byte
 * offsets are never fed to `slice` — in a multibyte document the two
 * numerically diverge and a byte-offset slice would cut mid-character
 * and break reassembly.
 *
 * ## Known limits
 *
 * A pathological document whose lone `skip` precedes a `skip-start`
 * region (the directive's target lands inside the following region) can
 * force a per-chunk refusal downstream — protection refuses the pairing,
 * and the pair reports `refused` rather than translating.
 *
 * ## Determinism
 *
 * The same text and the same `maxChunkBytes` always produce the same
 * chunk boundaries.
 */

import { fenceMask, splitLines } from "./markdown.mjs";

/**
 * Per-chunk source payload bound (UTF-8 bytes). Sized for provider
 * reliability: a chunk's expected answer must come back complete (empty
 * answers and dropped placeholder tokens were observed at 24 KiB chunks on
 * the first real dogfood run), and the answer must fit a provider output
 * cap with room to spare.
 */
export const MAX_CHUNK_BYTES = 8 * 2 ** 10;

/** Maximum chunks per pair — documents needing more are refused. */
export const MAX_CHUNKS_PER_PAIR = 32;

/**
 * Builds a table of char (UTF-16 code unit) offsets for the line starts
 * of `text`: `starts[i]` is the char offset of line `i`'s first
 * character, and the final entry is `text.length`.
 *
 * Slicing uses char offsets because `String.slice` does; budget
 * measuring converts a sliced chunk to UTF-8 bytes separately. The two
 * offset systems are never mixed — in a multibyte document they diverge
 * numerically and a byte-offset slice would cut mid-character.
 *
 * @param {string} text
 * @returns {number[]} char offsets of each line's first character, plus
 *   `text.length` as the final entry
 */
function buildLineStarts(text) {
  /** @type {number[]} */
  const starts = [0];
  let pos = text.indexOf("\n");
  while (pos !== -1) {
    starts.push(pos + 1);
    pos = text.indexOf("\n", pos + 1);
  }
  starts.push(text.length);
  return starts;
}

/** The UTF-8 byte length of one slice — the budget's measure. */
/** @param {string} slice @returns {number} */
const byteLength = (slice) => new TextEncoder().encode(slice).byteLength;

/* ------------------------------------------------------------------ */
/* Directive grammar — the same lines protect.mjs enforces.            */
/* ------------------------------------------------------------------ */

/** Any whole-line comment addressing this action, valid or not. */
const HARMONISE_COMMENT_LINE = /^<!--\s*harmonise:.*-->$/;
/** The three directives a run accepts. */
const DIRECTIVE_LINE = /^<!--\s*harmonise:(skip|skip-start|skip-end)\s*-->$/;

/* ------------------------------------------------------------------ */
/* Unit scan — single pass, emits inclusive line ranges                */
/* ------------------------------------------------------------------ */

/**
 * @typedef {{ start: number, end: number }} LineRange inclusive line indices
 */

/**
 * Scans `lines` and emits atomic units as inclusive, non-overlapping
 * line ranges in document order. The directive state mirrors
 * protect.mjs's `collectSkipRanges` so the chunker never splits a
 * protected region or separates a lone `skip` from its target; fences
 * are atomic whole blocks.
 *
 * @param {string[]} lines
 * @param {boolean[]} fences fence mask for the same lines
 * @returns {LineRange[]}
 */
function collectUnits(lines, fences) {
  /** @type {LineRange[]} */
  const units = [];
  /** @type {number[]} lone-skip directive lines awaiting their target */
  const pending = [];
  let openRegion = -1;
  let fenceStart = -1;
  let contentStart = -1;

  /** Closes an open content run through `through`, inclusive. */
  const flushContent = (/** @type {number} */ through) => {
    if (contentStart >= 0 && through >= contentStart) {
      units.push({ start: contentStart, end: through });
      contentStart = -1;
    }
  };

  /** Settles every pending lone skip with `through` as its target. */
  const settlePending = (/** @type {number} */ through) => {
    for (const directive of pending.splice(0)) {
      units.push({ start: directive, end: Math.max(directive, through) });
    }
  };

  for (const [index, rawLine] of lines.entries()) {
    /* -- Fence lines: one atomic block, no splitting inside --------- */
    if (fences[index] === true) {
      if (fenceStart < 0) {
        flushContent(index - 1);
        settlePending(index);
        fenceStart = index;
      }
      continue;
    }
    if (fenceStart >= 0) {
      // First non-masked line after a fence run: the fence block closed
      // on the previous line and is one atomic unit.
      units.push({ start: fenceStart, end: index - 1 });
      fenceStart = -1;
    }

    /* -- Directive lines --------------------------------------------- */
    const trimmed = rawLine.trim();
    if (HARMONISE_COMMENT_LINE.test(trimmed)) {
      const kind = DIRECTIVE_LINE.exec(trimmed)?.[1];
      if (kind === undefined) {
        // Unknown harmonise comment: ordinary content here — protection
        // refuses it later; the chunker splits normally around it.
        if (contentStart < 0) contentStart = index;
        continue;
      }
      if (openRegion >= 0) {
        // Region interior: every line — blank or content — belongs to the
        // region's one atomic unit, through its `skip-end`. (A nested
        // `skip-start` is absorbed here too; protection refuses the
        // pairing later.)
        if (kind === "skip-end") {
          units.push({ start: openRegion, end: index });
          openRegion = -1;
        }
        continue;
      }
      flushContent(index - 1);
      settlePending(index - 1);
      if (kind === "skip-start") {
        openRegion = index;
      } else if (kind === "skip-end") {
        // Stray skip-end: content — protection refuses it later.
        contentStart = index;
      } else {
        // kind === "skip": pending until the next non-blank content line.
        pending.push(index);
      }
      continue;
    }
    if (openRegion >= 0) {
      // Region interior (non-directive line): absorbed by the region's
      // one atomic unit — blank lines included.
      continue;
    }

    /* -- Blank line: a chunk boundary outside fences and directives -- */
    if (trimmed === "") {
      flushContent(index - 1);
      // An unsettled lone skip stays pending across blank lines; its
      // unit will span [directive, target] once the target arrives.
      continue;
    }

    /* -- Non-blank content line --------------------------------------- */
    if (pending.length > 0) {
      flushContent(index - 1);
      settlePending(index);
    }
    if (contentStart < 0) contentStart = index;
  }

  /* -- Flush the tail -------------------------------------------------- */
  flushContent(lines.length - 1);
  if (fenceStart >= 0) {
    // Unclosed fence: the run of masked lines through EOF is one unit.
    units.push({ start: fenceStart, end: lines.length - 1 });
  }
  if (openRegion >= 0) {
    // Unclosed region: flush it whole — protection refuses the pair.
    units.push({ start: openRegion, end: lines.length - 1 });
  }
  settlePending(lines.length - 1);

  return units;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Chunks a document at Markdown structural boundaries. The result is a
 * list of string slices whose concatenation equals `text` exactly — the
 * invariant is enforced on every call.
 *
 * Returns a `refusal` instead of `chunks` when a single unsplittable
 * unit exceeds `maxChunkBytes`. The caller enforces the pair-level
 * chunk budget (`MAX_CHUNKS_PER_PAIR`) on the returned list.
 *
 * @param {string} text the source document
 * @param {object} [options]
 * @param {number} [options.maxChunkBytes] per-chunk byte ceiling
 *   (UTF-8 bytes, measured per candidate chunk)
 * @returns {{ chunks: string[], refusal: string | null }}
 */
export function chunkDocument(text, { maxChunkBytes = MAX_CHUNK_BYTES } = {}) {
  if (text === "") {
    return { chunks: [], refusal: "the source document is empty" };
  }

  const lines = splitLines(text);
  const fences = fenceMask(lines);
  const lineStarts = buildLineStarts(text);
  const lastOffset = lineStarts[lineStarts.length - 1];

  /** Char offset just past `endLine`, inclusive. */
  const endOffset = (/** @type {number} */ endLine) =>
    lineStarts[endLine + 1] ?? lineStarts[lineStarts.length - 1] ?? 0;

  /* -- Atomic units, in document order -------------------------------- */
  /** @type {LineRange[]} */
  const units = [];

  // Frontmatter head: `---\n` … `---` is the first atomic unit when the
  // document opens with one.
  const firstLine = lines[0] ?? "";
  if (firstLine.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.trim() === "---") {
        units.push({ start: 0, end: i });
        break;
      }
    }
  }

  const bodyFrom = units.length > 0 ? (units[0]?.end ?? 0) + 1 : 0;
  if (bodyFrom < lines.length) {
    for (const unit of collectUnits(lines.slice(bodyFrom), fences.slice(bodyFrom))) {
      units.push({ start: unit.start + bodyFrom, end: unit.end + bodyFrom });
    }
  }

  if (units.length === 0) {
    // No structure to split on: one chunk, whatever its size.
    return { chunks: [text], refusal: null };
  }

  /* -- Greedy pack: units into chunks under the byte ceiling ----------- */
  /** @type {string[]} */
  const chunks = [];
  let packFrom = 0; // unit index where the current chunk began
  let chunkBytes = 0; // UTF-8 bytes accumulated in the current chunk

  // A chunk runs from its first unit's first char to the char where the
  // next unit starts — blank separator lines ride with the chunk before
  // them — and the final chunk runs to the end of the text.
  const flushThrough = (/** @type {number} */ unitIdx) => {
    const from = lineStarts[units[packFrom]?.start ?? 0] ?? 0;
    const to =
      unitIdx + 1 < units.length
        ? (lineStarts[units[unitIdx + 1]?.start ?? 0] ?? lastOffset)
        : lastOffset;
    chunks.push(text.slice(from, to));
    packFrom = unitIdx + 1;
    chunkBytes = 0;
  };

  for (let i = 0; i < units.length; i += 1) {
    const unit = text.slice(lineStarts[units[i]?.start ?? 0], endOffset(units[i]?.end ?? 0));
    const bytes = byteLength(unit);

    // Flush before this unit when adding it would cross the ceiling.
    if (chunkBytes > 0 && chunkBytes + bytes > maxChunkBytes) {
      flushThrough(i - 1);
    }

    chunkBytes += bytes;

    // The unit now opens (or extends) the current chunk: a unit whose
    // own bytes exceed the ceiling is unsplittable — the honest refusal.
    if (chunkBytes > maxChunkBytes && i === packFrom) {
      return {
        chunks: [],
        refusal:
          `an unsplittable block of ${String(bytes)} bytes does not fit one chunk — ` +
          `shrink or split it`,
      };
    }
  }
  flushThrough(units.length - 1);

  // The core invariant, enforced on every call: no truncation, no
  // dropped content, no reordering.
  if (chunks.join("") !== text) {
    throw new Error("chunkDocument: chunks do not reassemble to the original text");
  }

  if (chunks.length > MAX_CHUNKS_PER_PAIR) {
    return {
      chunks: [],
      refusal:
        `the document needs ${String(chunks.length)} chunks, past the ` +
        `${String(MAX_CHUNKS_PER_PAIR)}-chunk execution budget — split the document`,
    };
  }

  return { chunks, refusal: null };
}
