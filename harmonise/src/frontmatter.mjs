/**
 * Frontmatter protection — the deterministic policy half of the frontmatter
 * contract. `harmonise` translates Markdown pairs, and the model doing the
 * translating is untrusted: anything it returns is evidence, never
 * instruction. The body of a document already has its deterministic
 * protection — code fences, skip directives, glossary terms — and the
 * structural fingerprint already records the frontmatter's presence and
 * extent. What it has not had is a policy: nothing deterministic stopped a
 * translation from quietly rewriting `slug`, `permalink` or `layout` while
 * the prose moved.
 *
 * This module is that policy, and it is conservative by default:
 *
 *   - A key named in `translatableKeys` is the one write the model can
 *     cause, and only as a single-line scalar string. Everything nested
 *     under a key belongs to that key: a translatable key has no subtree,
 *     because a subtree is not a scalar string.
 *   - Every other key — including any key this policy has never heard of —
 *     is protected: its bytes must survive the translation exactly, carried
 *     through as a placeholder and restored from a map, never re-typed by
 *     the model. An unknown key is protected because a policy that guessed
 *     would be a policy the model could steer.
 *   - A construct the line-oriented recognizer cannot identify with
 *     certainty — anchors, aliases, merge keys, multi-line scalars,
 *     sequences, flow collections that span lines, duplicate keys, ragged
 *     indentation — is a typed refusal. Recognition that is probably right
 *     is still a guess, and a guess here becomes silent corruption.
 *
 * The pipeline a caller composes, none of it wired here:
 *
 *     extractFrontmatter(source)      locate the block, refuse what is not
 *                                     recognized with certainty
 *     planFrontmatterProtection(raw)  protected values behind
 *                                     [[harmonise:<id>:f<n>]] tokens, plus a
 *                                     restore map
 *     ...the masked document is translated...
 *     restore                         the caller puts the original bytes
 *                                     back through the restore map
 *     validateFrontmatter(before, after, policy)
 *                                     the gate: protected bytes identical,
 *                                     translatable keys still scalars, no
 *                                     token left behind
 *
 * Every failure is a typed refusal or a listed violation the caller must
 * surface; none is ever coerced into a pass.
 */

import { randomBytes } from "node:crypto";

import { splitLines } from "./markdown.mjs";

/**
 * The shipped policy. `protectedKeys` must survive byte-identical;
 * `translatableKeys` may be rewritten, as single-line scalar strings only.
 * A key on neither list is protected — conservative by default.
 *
 * @type {FrontmatterPolicy}
 */
export const DEFAULT_FRONTMATTER_POLICY = {
  protectedKeys: [
    "slug",
    "permalink",
    "url",
    "path",
    "layout",
    "template",
    "draft",
    "date",
    "publishdate",
    "lastmod",
    "weight",
    "order",
    "id",
    "uuid",
    "type",
  ],
  translatableKeys: ["title", "description", "summary", "excerpt"],
};

/**
 * @typedef {object} FrontmatterPolicy
 * @property {string[]} protectedKeys keys whose values must survive byte-identical
 * @property {string[]} translatableKeys keys the model may translate, as single-line scalar strings
 */

/**
 * @typedef {object} FrontmatterKey
 * @property {string} name the bare key, exactly as authored
 * @property {"scalar"|"map"|"flow"} kind scalar string, nested mapping, or single-line flow collection
 * @property {number} valueStart char offset into the raw frontmatter, just past the colon (and one separating space, when present)
 * @property {number} valueEnd char offset into the raw frontmatter, exclusive: end of the value, or of a mapping's last line
 */

/**
 * @typedef {object} FrontmatterExtraction
 * @property {"extracted"} kind
 * @property {string} raw the content between the fence lines, exactly as authored
 * @property {number} contentStart UTF-8 byte offset of the raw frontmatter's first byte in the source
 * @property {number} contentEnd UTF-8 byte offset one past its last byte in the source
 * @property {number} startLine 0-based index of the opening fence line
 * @property {number} endLine 0-based index of the closing fence line
 * @property {FrontmatterKey[]} keys every recognized key, in document order
 */

/**
 * @typedef {object} FrontmatterAbsence
 * @property {"absent"} kind no leading fenced block exists — an unclosed leading
 *   `---` is a thematic break, the same call `markdown.mjs` makes
 */

/**
 * @typedef {object} FrontmatterRefusal
 * @property {"refused"} kind
 * @property {string} code stable machine-readable reason
 * @property {string} message specific, stable text for the run report
 */

/** @typedef {FrontmatterExtraction | FrontmatterAbsence | FrontmatterRefusal} FrontmatterExtract */

/**
 * @typedef {object} FrontmatterPlan
 * @property {"planned"} kind
 * @property {string} masked the raw frontmatter with protected values behind placeholder tokens
 * @property {Map<string, string>} restoreMap token → the exact original bytes
 */

/**
 * @typedef {object} FrontmatterViolation
 * @property {string} code stable machine-readable reason
 * @property {string} [key] the top-level key concerned, when there is one
 * @property {string} detail specific, stable text for the run report
 */

/** The namespace every placeholder in this repository shares. A raw frontmatter that already carries it is refused: tokens this run did not mint cannot be told apart from ones it did. */
const PLACEHOLDER_NAMESPACE = /\[\[harmonise:/i;

/** @returns {string} a fresh run id, 16 hex characters like every other token this action mints */
function defaultId() {
  return randomBytes(8).toString("hex");
}

/** @typedef {object} ParsedKey @property {string} name @property {"scalar"|"map"|"flow"} kind @property {number} indent @property {number} valueStart char offset @property {number} valueEnd char offset, exclusive */
/**
 * One open mapping: the block a key owns. `owner` is the key whose extent
 * grows with every line the mapping takes in; the root mapping owns none.
 *
 * @typedef {{ childIndent: number, seen: Set<string>, owner: ParsedKey | null }} Mapping
 */

/**
 * Internal refusal shape: the `ok` discriminator parse and policy results
 * narrow on.
 *
 * @param {string} code
 * @param {string} message
 * @returns {{ ok: false, code: string, message: string }}
 */
function refused(code, message) {
  return { ok: false, code, message };
}

/**
 * The public refusal shape `extractFrontmatter` and
 * `planFrontmatterProtection` return.
 *
 * @param {string} code
 * @param {string} message
 * @returns {FrontmatterRefusal}
 */
function typedRefusal(code, message) {
  return { kind: "refused", code, message };
}

/**
 * Parses the raw frontmatter's keys, line-oriented: bare keys, flat or in
 * simply-nested maps. Anything else is a refusal, never a best guess.
 *
 * Key policy speaks at the top level; nested keys are parsed so their
 * parent's extent can be known exactly, and governed by their parent.
 *
 * @param {string} raw the content between the fence lines
 * @returns {{ ok: true, keys: ParsedKey[] } | { ok: false, code: string, message: string }}
 */
function parseFrontmatter(raw) {
  const lines = splitLines(raw);
  const firstTrimmed = lines[0]?.trim() ?? "";
  const lastTrimmed = lines[lines.length - 1]?.trim() ?? "";
  if (firstTrimmed === "---" || lastTrimmed === "---") {
    return refused(
      "fence-line",
      "the frontmatter text carries its own '---' fences — pass the content between " +
        "the fence lines, as extractFrontmatter's raw provides",
    );
  }
  /** @type {ParsedKey[]} */
  const keys = [];
  /** @type {Mapping[]} */
  const stack = [{ childIndent: -1, seen: new Set(), owner: null }];
  let frame = stack[0] ?? root();
  /** A `key:` line awaiting resolution: a map if the next content line is deeper, an empty scalar if not. @type {{ key: ParsedKey, end: number } | null} */
  let pending = null;
  let offset = 0; // char offset of the current line's first character

  for (const [index, line] of lines.entries()) {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    offset = lineEnd + 1;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (lead.includes("\t")) {
      return refused(
        "tab-indent",
        `line ${String(index + 1)}: tab indentation — YAML tabs are ambiguous and refused`,
      );
    }
    const indent = lead.length;

    // A pending `key:` resolves on the first content line that follows it.
    if (pending !== null) {
      if (indent > pending.key.indent) {
        pending.key.kind = "map";
        const opened = { childIndent: indent, seen: new Set(), owner: pending.key };
        stack.push(opened);
        frame = opened;
      } else {
        pending.key.kind = "scalar";
        pending.key.valueStart = pending.end;
        pending.key.valueEnd = pending.end;
      }
      pending = null;
    }

    // Whole-line constructs, most specific first.
    if (trimmed.startsWith("<<")) {
      return refused(
        "merge-key",
        `line ${String(index + 1)}: '${trimmed}' — merge keys are not recognized and are refused`,
      );
    }
    if (trimmed === "-" || trimmed.startsWith("- ")) {
      return refused(
        "sequence-entry",
        `line ${String(index + 1)}: '${trimmed}' — sequences are not recognized; only flat keys and nested maps are`,
      );
    }
    if (trimmed.startsWith("&")) {
      return refused(
        "anchor",
        `line ${String(index + 1)}: '${trimmed}' — anchors are not recognized and are refused`,
      );
    }
    if (trimmed.startsWith("*")) {
      return refused(
        "alias",
        `line ${String(index + 1)}: '${trimmed}' — aliases are not recognized and are refused`,
      );
    }

    // A CRLF line's '\r' is a line terminator for the key regex, so the
    // body is cut before it; the value spans exclude it the same way.
    const carriage = line.endsWith("\r") ? 1 : 0;
    const body = line.slice(indent, line.length - carriage);
    const keyMatch = /^([A-Za-z0-9][A-Za-z0-9_-]*):(.*)$/.exec(body);
    if (keyMatch === null) {
      return refused(
        "unrecognized-line",
        `line ${String(index + 1)}: '${trimmed}' — not a recognizable key line (bare keys only: 'key:' or 'key: value')`,
      );
    }
    const name = keyMatch[1] ?? "";
    const rest = keyMatch[2] ?? "";
    if (rest !== "" && !rest.startsWith(" ")) {
      return refused(
        "unrecognized-line",
        `line ${String(index + 1)}: '${trimmed}' — a colon with no following space makes this a plain scalar, not a key`,
      );
    }

    // Belong to the nearest open mapping this indent still fits.
    while (stack.length > 1 && frame.childIndent > indent) {
      stack.pop();
      frame = stack[stack.length - 1] ?? root();
    }
    if (frame.childIndent === -1) {
      frame.childIndent = indent;
    } else if (frame.childIndent !== indent) {
      return refused(
        "inconsistent-indent",
        `line ${String(index + 1)}: indent ${String(indent)} does not match the ${String(frame.childIndent)} its mapping opened with — ragged indentation is refused`,
      );
    }
    if (frame.seen.has(name)) {
      return refused(
        "duplicate-key",
        `line ${String(index + 1)}: key '${name}' is declared twice in the same mapping — refused`,
      );
    }
    frame.seen.add(name);

    const valueEnd = lineEnd - carriage;
    // The line belongs to every mapping still open, so every open key's
    // extent grows with it — a grandparent's span must cover its whole
    // subtree, not just its direct children, or a rewritten grandchild
    // would hide outside the protected bytes.
    for (const open of stack) {
      if (open.owner !== null) open.owner.valueEnd = valueEnd;
    }

    const colonAt = lineStart + indent + name.length;
    if (rest === "") {
      // `key:` — a nested mapping if a deeper content line follows, an empty scalar if not.
      /** @type {ParsedKey} */ const key = {
        name,
        kind: "scalar",
        indent,
        valueStart: colonAt + 1,
        valueEnd,
      };
      keys.push(key);
      pending = { key, end: lineEnd };
      continue;
    }

    const trimmedRest = rest.trim();
    const head = trimmedRest[0] ?? "";
    let valueStart = colonAt + 1;
    if (rest.startsWith(" ")) valueStart += 1;

    if (head === "&") {
      return refused(
        "anchor",
        `line ${String(index + 1)}: '${trimmed}' — anchors are not recognized and are refused`,
      );
    }
    if (head === "*") {
      return refused(
        "alias",
        `line ${String(index + 1)}: '${trimmed}' — aliases are not recognized and are refused`,
      );
    }
    if (head === "|" || head === ">") {
      return refused(
        "multiline-scalar",
        `line ${String(index + 1)}: '${trimmed}' — multi-line scalars are not recognized and are refused`,
      );
    }
    if (head === "[" || head === "{") {
      // A flow collection that closes on its own line is knowable; one that
      // spans lines leaves an unrecognizable line behind, refused below.
      keys.push({ name, kind: "flow", indent, valueStart, valueEnd });
      continue;
    }
    if (head === '"' || head === "'") {
      if (!closesQuoted(trimmedRest)) {
        return refused(
          "unrecognized-line",
          `line ${String(index + 1)}: '${trimmed}' — a quoted scalar that does not close on its own line is not recognizable`,
        );
      }
    } else if (rest.includes(": ")) {
      return refused(
        "unrecognized-line",
        `line ${String(index + 1)}: '${trimmed}' — a second ': ' makes the value ambiguous and is refused`,
      );
    }
    keys.push({ name, kind: "scalar", indent, valueStart, valueEnd });
  }

  if (pending !== null) {
    pending.key.kind = "scalar";
    pending.key.valueStart = pending.end;
    pending.key.valueEnd = pending.end;
  }
  return { ok: true, keys };
}

/**
 * The root mapping, recreated only when the stack invariant is somehow
 * violated — which cannot happen, but `noUncheckedIndexedAccess` asks.
 *
 * @returns {Mapping}
 */
function root() {
  return { childIndent: -1, seen: new Set(), owner: null };
}

/**
 * Whether a quoted scalar closes on this line with only whitespace after it.
 * Double-quoted strings carry backslash escapes; single-quoted strings
 * escape their own quote by doubling.
 *
 * @param {string} value the value tail, beginning at its first quote
 * @returns {boolean}
 */
function closesQuoted(value) {
  const quote = value[0] ?? "";
  for (let i = 1; i < value.length; i++) {
    const character = value[i] ?? "";
    if (quote === '"' && character === "\\") {
      i += 1;
      continue;
    }
    if (character === quote) {
      if (quote === "'" && value[i + 1] === "'") {
        i += 1;
        continue;
      }
      return value.slice(i + 1).trim() === "";
    }
  }
  return false;
}

/**
 * UTF-8 byte offset of `charIndex` in `text`, matching what `TextEncoder`
 * produces — including its replacement of lone surrogates.
 *
 * @param {string} text
 * @param {number} charIndex
 * @returns {number}
 */
function utf8Offset(text, charIndex) {
  let bytes = 0;
  for (let i = 0; i < charIndex; i++) {
    const code = text.charCodeAt(i) ?? 0;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < charIndex ? (text.charCodeAt(i + 1) ?? 0) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3; // a lone high surrogate encodes as U+FFFD
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 3; // a lone low surrogate encodes as U+FFFD
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Locates the leading frontmatter block and its keys. Fences are recognized
 * by trimmed equality, the same rule `markdown.mjs` applies: no leading
 * fence, or an unclosed one, is no frontmatter at all. A block whose
 * interior uses a construct the recognizer cannot identify with certainty
 * is a typed refusal — never a best guess.
 *
 * @param {string} source the whole document
 * @returns {FrontmatterExtract}
 */
export function extractFrontmatter(source) {
  const lines = splitLines(source);
  if (lines.length < 2 || lines[0]?.trim() !== "---") {
    return { kind: "absent" };
  }
  let endLine = -1;
  for (const [index, line] of lines.entries()) {
    if (index > 0 && line.trim() === "---") {
      endLine = index;
      break;
    }
  }
  if (endLine === -1) {
    return { kind: "absent" };
  }

  const contentStart = (lines[0]?.length ?? 0) + 1;
  let closerStart = contentStart;
  for (const [index, line] of lines.entries()) {
    if (index === 0 || index >= endLine) continue;
    closerStart += line.length + 1;
  }
  const raw = source.slice(contentStart, closerStart);

  const parsed = parseFrontmatter(raw);
  if (!parsed.ok) return typedRefusal(parsed.code, parsed.message);

  return {
    kind: "extracted",
    raw,
    contentStart: utf8Offset(source, contentStart),
    contentEnd: utf8Offset(source, closerStart),
    startLine: 0,
    endLine,
    keys: parsed.keys.map((key) => ({
      name: key.name,
      kind: key.kind,
      valueStart: key.valueStart,
      valueEnd: key.valueEnd,
    })),
  };
}

/**
 * Normalizes a policy into lookup sets, refusing one that is malformed or
 * self-contradictory. Keys are case-sensitive and matched exactly.
 *
 * @param {FrontmatterPolicy} policy
 * @returns {{ ok: true, protectedKeys: Set<string>, translatable: Set<string> } | { ok: false, code: string, message: string }}
 */
function normalizePolicy(policy) {
  const source = /** @type {any} */ (policy);
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return refused(
      "invalid-policy",
      "the policy must be an object carrying protectedKeys and translatableKeys arrays",
    );
  }
  const translatableList = readKeyList(source, "translatableKeys");
  if (typeof translatableList === "string") return refused("invalid-policy", translatableList);
  /** @type {Set<string>} */
  const translatable = new Set();
  for (const name of translatableList) translatable.add(name);

  const protectedList = readKeyList(source, "protectedKeys");
  if (typeof protectedList === "string") return refused("invalid-policy", protectedList);
  for (const name of protectedList) {
    if (translatable.has(name)) {
      return refused(
        "policy-conflict",
        `key '${name}' is both protected and translatable — a key the model may rewrite cannot also be protected`,
      );
    }
  }
  return { ok: true, protectedKeys: new Set(protectedList), translatable };
}

/**
 * @param {any} source
 * @param {string} field
 * @returns {string[] | string} the key list, or the refusal message
 */
function readKeyList(source, field) {
  const value = source[field];
  if (!Array.isArray(value)) return `policy.${field} must be an array of key names`;
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "") {
      return `policy.${field} must contain non-empty string key names`;
    }
  }
  return /** @type {string[]} */ (value);
}

/**
 * Plans the protection: protected values — and any key the policy does not
 * name, which is protected by default — go behind
 * `[[harmonise:<id>:f<n>]]` placeholders, numbered in document order, with
 * a restore map that puts the original bytes back. Translatable keys stay
 * in the clear: translation is the one write the policy allows. A raw
 * frontmatter the recognizer cannot parse, a policy that contradicts
 * itself, or text already wearing the placeholder namespace is refused.
 *
 * @param {string} rawFrontmatter the content between the fence lines, as `extractFrontmatter`'s raw provides
 * @param {FrontmatterPolicy} policy
 * @param {object} [options]
 * @param {() => string} [options.newId] the run-id generator, injectable for tests
 * @returns {FrontmatterPlan | FrontmatterRefusal}
 */
export function planFrontmatterProtection(rawFrontmatter, policy, { newId = defaultId } = {}) {
  const normalized = normalizePolicy(policy);
  if (!normalized.ok) return typedRefusal(normalized.code, normalized.message);
  if (PLACEHOLDER_NAMESPACE.test(rawFrontmatter)) {
    return typedRefusal(
      "token-collision",
      "the frontmatter already contains text shaped like a harmonise placeholder — " +
        "refused rather than risk token ambiguity",
    );
  }
  const parsed = parseFrontmatter(rawFrontmatter);
  if (!parsed.ok) return typedRefusal(parsed.code, parsed.message);
  const id = newId();

  /** @type {{ token: string, start: number, end: number, original: string }[]} */
  const spans = [];
  for (const key of parsed.keys) {
    if (key.indent !== 0) continue; // governed by its parent, and inside its parent's span
    if (normalized.translatable.has(key.name)) {
      if (key.kind !== "scalar") {
        return typedRefusal(
          "translatable-key-not-scalar",
          `key '${key.name}' is translatable but its value is ` +
            `${key.kind === "map" ? "a nested mapping" : "a flow collection"} — ` +
            "translatable keys carry single-line scalar strings only",
        );
      }
      continue; // left in the clear
    }
    if (key.valueEnd <= key.valueStart) continue; // nothing to carry
    const token = `[[harmonise:${id}:f${String(spans.length + 1)}]]`;
    spans.push({
      token,
      start: key.valueStart,
      end: key.valueEnd,
      original: rawFrontmatter.slice(key.valueStart, key.valueEnd),
    });
  }

  let masked = rawFrontmatter;
  for (const span of [...spans].reverse()) {
    masked = masked.slice(0, span.start) + span.token + masked.slice(span.end);
  }
  return {
    kind: "planned",
    masked,
    restoreMap: new Map(spans.map((span) => [span.token, span.original])),
  };
}

/**
 * The gate a caller applies to the restored translation. Protected keys —
 * and every key the policy does not name — must come back byte-identical;
 * translatable keys must still be single-line scalar strings, and an empty
 * one must stay empty, because there was nothing to translate; the key set,
 * its order and its value kinds must be exactly as they were; and no
 * harmonise placeholder may survive, because restoration consumed the ones
 * this run minted and anything left wearing the namespace is a forgery.
 *
 * Every violation is a refusal condition for the caller — reported, never
 * coerced back into a pass.
 *
 * @param {string} originalRaw the raw frontmatter exactly as authored
 * @param {string} translatedRaw the raw frontmatter after translation and restoration
 * @param {FrontmatterPolicy} policy
 * @returns {{ ok: boolean, violations: FrontmatterViolation[] }}
 */
export function validateFrontmatter(originalRaw, translatedRaw, policy) {
  /** @type {FrontmatterViolation[]} */
  const violations = [];
  const normalized = normalizePolicy(policy);
  if (!normalized.ok) {
    return { ok: false, violations: [violation(normalized.code, normalized.message)] };
  }

  const original = parseFrontmatter(originalRaw);
  if (!original.ok) violations.push(violation("unparseable-original", original.message));
  const translated = parseFrontmatter(translatedRaw);
  if (!translated.ok) violations.push(violation("unparseable-translated", translated.message));

  if (original.ok && translated.ok) {
    const before = original.keys.filter((key) => key.indent === 0);
    const after = translated.keys.filter((key) => key.indent === 0);
    const sameSequence =
      before.length === after.length && before.every((key, i) => key.name === after[i]?.name);
    if (!sameSequence) {
      const beforeNames = new Set(before.map((key) => key.name));
      const afterNames = new Set(after.map((key) => key.name));
      for (const key of before) {
        if (!afterNames.has(key.name)) {
          violations.push(
            violation(
              "missing-key",
              `key '${key.name}' is missing from the translated frontmatter`,
              key.name,
            ),
          );
        }
      }
      for (const key of after) {
        if (!beforeNames.has(key.name)) {
          violations.push(
            violation("added-key", `key '${key.name}' was added by the translation`, key.name),
          );
        }
      }
      if (violations.length === 0) {
        violations.push(
          violation(
            "reordered-key",
            `the translated frontmatter reorders the top-level keys (original: ` +
              `${before.map((key) => key.name).join(", ") || "none"}; translated: ` +
              `${after.map((key) => key.name).join(", ") || "none"})`,
          ),
        );
      }
    } else {
      for (let i = 0; i < before.length; i++) {
        const was = before[i];
        const now = after[i];
        if (was === undefined || now === undefined) continue;
        if (was.kind !== now.kind) {
          violations.push(
            violation(
              "changed-kind",
              `key '${was.name}' was a ${was.kind} and came back a ${now.kind}`,
              was.name,
            ),
          );
          continue;
        }
        if (normalized.translatable.has(was.name)) {
          if (was.kind !== "scalar") {
            violations.push(
              violation(
                "translatable-key-not-scalar",
                `key '${was.name}' is translatable but carries a ${was.kind} value — ` +
                  "translatable keys hold single-line scalar strings",
                was.name,
              ),
            );
            continue;
          }
          const wasEmpty = originalRaw.slice(was.valueStart, was.valueEnd).trim() === "";
          const filled = translatedRaw.slice(now.valueStart, now.valueEnd).trim() !== "";
          if (wasEmpty && filled) {
            violations.push(
              violation(
                "empty-translatable-filled",
                `key '${was.name}' had no value to translate, and the translation filled it`,
                was.name,
              ),
            );
          }
          continue;
        }
        // Protected, or unknown and therefore protected by default: the
        // bytes must be identical. The restore map guarantees it; this gate
        // declines to take the guarantee on faith.
        const expected = originalRaw.slice(was.valueStart, was.valueEnd);
        const actual = translatedRaw.slice(now.valueStart, now.valueEnd);
        if (expected !== actual) {
          violations.push(
            violation(
              "protected-value-changed",
              `key '${was.name}' must survive byte-identical — expected ` +
                `${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
              was.name,
            ),
          );
        }
      }
    }
  }

  const survivors = translatedRaw.match(/\[\[harmonise:/gi)?.length ?? 0;
  if (survivors > 0) {
    violations.push(
      violation(
        "residual-token",
        `${String(survivors)} harmonise placeholder token(s) survive in the translated frontmatter — ` +
          "restoration did not consume them",
      ),
    );
  }
  return { ok: violations.length === 0, violations };
}

/**
 * @param {string} code
 * @param {string} detail
 * @param {string} [key]
 * @returns {FrontmatterViolation}
 */
function violation(code, detail, key) {
  return key === undefined ? { code, detail } : { code, key, detail };
}
