/**
 * `harmonise` sync-state — a versioned, repository-visible record of what a
 * prior harmonise run produced for each destination document.
 *
 * ## DOCTRINE (advisory only)
 *
 * The state file is **advisory**. The repository's actual bytes are the sole
 * authority. State avoids recomputation and flags manual edits; it never
 * grants capabilities and never overrides repository content. Every consumer
 * MUST verify against the real content before acting on state.
 *
 * Concretely:
 * - A missing or unparseable state file degrades gracefully to "no prior
 *   state" — the run recomputes everything from real bytes.
 * - A stale fingerprint (source changed between runs) is a signal that the
 *   translation needs re-evaluation, not a verdict.
 * - The file is deterministic JSON; two runs with the same records produce
 *   byte-identical output.
 *
 * ## Layout
 *
 * The file lives at the path {@link statePath} derives from the run's source
 * language. Its shape is
 * `{ "records": [ … ] }` where each record carries exactly these keys:
 *
 * | Field                    | Type   | Purpose                                              |
 * | ------------------------ | ------ | ---------------------------------------------------- |
 * | `schemaVersion`          | number | `{@link STATE_SCHEMA_VERSION}` — bumped on schema change |
 * | `sourcePath`             | string | path of the source document in the repository        |
 * | `destinationPath`        | string | path of the translated document                      |
 * | `language`               | string | language tag of the translation                      |
 * | `sourceFingerprint`      | string | sha-256 hex of the source bytes at translation time  |
 * | `translationFingerprint` | string | sha-256 hex of the translation bytes                 |
 * | `policyFingerprint`      | string | hash of the policy that produced this translation    |
 * | `transformationVersion`  | number | `TRANSFORMATION_VERSION` when the translation was made |
 *
 * Records are sorted by `destinationPath` byte-wise over its UTF-8 encoding.
 * Keys within each record and in the top-level wrapper are sorted for
 * deterministic output. The file ends with a trailing newline.
 *
 * @module harmonise/src/state
 */

import { utf8Compare } from "#core/order.mjs";

/**
 * Bumped when the shape of a sync-state record changes — a field renamed,
 * added, removed, or a type tightened. Records carrying a different version
 * are refused on parse rather than misinterpreted. The run-level schema is
 * per-record, not per-file: a migration may coexist with older records, and
 * the constant is the floor a reader expects.
 */
export const STATE_SCHEMA_VERSION = 1;

/**
 * The advisory sync-state path for one publishing branch: the source
 * language names the branch (`harmonise/<sourceLanguage>`) and the advisory
 * files it owns alike, so concurrent runs for different languages write
 * disjoint file sets and never collide at merge time (#156, Shape 1 — the
 * suffix follows the branch key by construction).
 *
 * @param {string} sourceLanguage
 * @returns {string}
 */
export function statePath(sourceLanguage) {
  return `.github/action-agents/harmonise/state.${sourceLanguage}.json`;
}

/**
 * The un-suffixed path repositories created before #156 carry. Read-only
 * since the suffix landed: a run falls back to it once — when the suffixed
 * file is absent everywhere — and the first suffixed publication ends the
 * fallback. Nothing writes here anymore.
 */
export const LEGACY_STATE_PATH = ".github/action-agents/harmonise/state.json";

/**
 * One destination's sync record — the snapshot of what harmonise produced for
 * a given (source, language) pair at a given instant.
 *
 * @typedef {object} SyncStateRecord
 * @property {number} schemaVersion — must equal `STATE_SCHEMA_VERSION`
 * @property {string} sourcePath
 * @property {string} destinationPath
 * @property {string} language
 * @property {string} sourceFingerprint
 * @property {string} translationFingerprint
 * @property {string} policyFingerprint
 * @property {number} transformationVersion
 */

/**
 * The contents-reading slice of a forge client that `readState` needs.
 *
 * Matches `forge.getContents(path, options)` exactly: reads one file from
 * the repository at an optional ref, or from the default branch when no ref
 * is given. Absent is `null`.
 *
 * @typedef {(path: string, options?: { ref?: string }) => Promise<{ content: string } | null>} ContentsReader
 */

// ── byte-wise path sort ─────────────────────────────────────────────────────

/**
 * Sort comparator for records: byte-wise over the UTF-8 encoding of
 * `destinationPath`. Used by both `renderState` (emission sort) and
 * `parseState` (normalize-on-read sort), so roundtrip is stable.
 *
 * @param {SyncStateRecord} a
 * @param {SyncStateRecord} b
 * @returns {number}
 */
function byDestinationPath(a, b) {
  return utf8Compare(a.destinationPath, b.destinationPath);
}

// ── deterministic render ────────────────────────────────────────────────────

/**
 * Sorts keys of every non-array object at every depth. Arrays are left in
 * their given order — declaration order is meaningful. Used as a JSON
 * replacer so `JSON.stringify` emits keys in stable order regardless of
 * insertion.
 *
 * @param {string} _key
 * @param {unknown} value
 * @returns {unknown}
 */
function sortedKeysReplacer(_key, value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = /** @type {Record<string, unknown>} */ (value)[key];
    }
    return sorted;
  }
  return value;
}

/**
 * Renders an array of records into the deterministic JSON that a sync-state
 * file carries.
 *
 * Guarantees:
 * - Records are sorted by `destinationPath` (byte-wise over UTF-8).
 * - Keys at every object depth are sorted ascending.
 * - Indent is 2 spaces.
 * - The output ends with a trailing newline (`\n`).
 *
 * @param {SyncStateRecord[]} records
 * @returns {string}
 */
export function renderState(records) {
  const sorted = [...records].sort(byDestinationPath);
  return JSON.stringify({ records: sorted }, sortedKeysReplacer, 2) + "\n";
}

// ── strict parse ────────────────────────────────────────────────────────────

/** @type {readonly string[]} */
const RECORD_KEYS = Object.freeze([
  "destinationPath",
  "language",
  "policyFingerprint",
  "schemaVersion",
  "sourceFingerprint",
  "sourcePath",
  "transformationVersion",
  "translationFingerprint",
]);

/** @type {readonly string[]} */
const STRING_FIELDS = Object.freeze([
  "sourcePath",
  "destinationPath",
  "language",
  "sourceFingerprint",
  "translationFingerprint",
  "policyFingerprint",
]);

/**
 * Parses a sync-state file into its records, strictly.
 *
 * Refused (throws `Error` with a reason):
 * - Malformed JSON (`JSON.parse` failure).
 * - Top-level value is not a plain object.
 * - Any top-level key other than `records`.
 * - `records` is missing, or not an array.
 * - Any record is not a plain object.
 * - Any record carries a key not in the declared set.
 * - Any record is missing a declared key.
 * - Any record's `schemaVersion`, `sourcePath`, `destinationPath`, `language`,
 *   `sourceFingerprint`, `translationFingerprint`, `policyFingerprint`,
 *   `transformationVersion` has the wrong type (number for `schemaVersion` and
 *   `transformationVersion`; string for the rest).
 * - `schemaVersion` is not `STATE_SCHEMA_VERSION`.
 * - Two records share the same `destinationPath`.
 *
 * Succeeds when the file is well-formed; returns the records sorted by
 * `destinationPath` (byte-wise over UTF-8), regardless of the input order.
 * This is the "normalized-on-read" pin: a hand-edited file whose records were
 * reordered still parses, and the returned records are always in the canonical
 * order.
 *
 * @param {string} text
 * @returns {{ records: SyncStateRecord[] }}
 */
export function parseState(text) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    // `JSON.parse` only ever throws `SyntaxError`, an `Error` subclass.
    const message = /** @type {Error} */ (cause).message;
    throw new Error(`malformed JSON in sync-state file: ${message}`, { cause });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const got = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    throw new Error(`sync-state file must be a JSON object, got ${got}`);
  }

  const topLevel = /** @type {Record<string, unknown>} */ (parsed);
  const topKeys = Object.keys(topLevel);
  for (const key of topKeys) {
    if (key !== "records") {
      throw new Error(`unknown top-level key '${key}' in sync-state file`);
    }
  }

  if (!topKeys.includes("records")) {
    throw new Error("sync-state file is missing the 'records' key");
  }

  if (!Array.isArray(topLevel["records"])) {
    throw new Error(`'records' must be an array, got ${typeof topLevel["records"]}`);
  }

  const rawRecords = /** @type {unknown[]} */ (topLevel["records"]);

  /** @type {SyncStateRecord[]} */
  const records = [];
  /** @type {Set<string>} */
  const seenPaths = new Set();

  for (let i = 0; i < rawRecords.length; i++) {
    const raw = rawRecords[i];
    const prefix = `record[${String(i)}]`;

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(
        `${prefix} must be an object, got ${Array.isArray(raw) ? "array" : typeof raw}`,
      );
    }

    const rec = /** @type {Record<string, unknown>} */ (raw);
    const recKeys = Object.keys(rec);

    for (const key of recKeys) {
      if (!RECORD_KEYS.includes(key)) {
        throw new Error(`${prefix} has unknown key '${key}'`);
      }
    }

    for (const key of RECORD_KEYS) {
      if (!Object.hasOwn(rec, key)) {
        throw new Error(`${prefix} is missing key '${key}'`);
      }
    }

    // Type checks
    const schemaVersion = rec["schemaVersion"];
    if (typeof schemaVersion !== "number") {
      throw new Error(`${prefix} 'schemaVersion' must be a number, got ${typeof schemaVersion}`);
    }
    if (schemaVersion !== STATE_SCHEMA_VERSION) {
      throw new Error(
        `${prefix} 'schemaVersion' is ${String(schemaVersion)}, expected ${String(STATE_SCHEMA_VERSION)}`,
      );
    }

    const transformationVersion = rec["transformationVersion"];
    if (typeof transformationVersion !== "number") {
      throw new Error(
        `${prefix} 'transformationVersion' must be a number, got ${typeof transformationVersion}`,
      );
    }

    for (const field of STRING_FIELDS) {
      if (typeof rec[field] !== "string") {
        throw new Error(`${prefix} '${field}' must be a string, got ${typeof rec[field]}`);
      }
    }

    const destinationPath = /** @type {string} */ (rec["destinationPath"]);
    if (seenPaths.has(destinationPath)) {
      throw new Error(`${prefix} duplicate destinationPath '${destinationPath}'`);
    }
    seenPaths.add(destinationPath);

    records.push({
      schemaVersion: /** @type {number} */ (schemaVersion),
      sourcePath: /** @type {string} */ (rec["sourcePath"]),
      destinationPath,
      language: /** @type {string} */ (rec["language"]),
      sourceFingerprint: /** @type {string} */ (rec["sourceFingerprint"]),
      translationFingerprint: /** @type {string} */ (rec["translationFingerprint"]),
      policyFingerprint: /** @type {string} */ (rec["policyFingerprint"]),
      transformationVersion: /** @type {number} */ (transformationVersion),
    });
  }

  // Normalize-on-read: sort by destinationPath byte-wise, regardless of
  // input order. Hand-edited reordering still parses; the returned records
  // are always in canonical order.
  records.sort(byDestinationPath);

  return { records };
}

// ── read from repository ────────────────────────────────────────────────────

/**
 * Reads the sync-state file from the repository, trying the harmonise branch
 * tip first, then the default branch. Both refs arrive already resolved —
 * the caller resolves the branch tip once and feeds that SHA to every
 * advisory read, so state and memory can never come from two different
 * commits of the same branch.
 *
 * The file is looked up under {@link statePath}`(sourceLanguage)` — the
 * publishing branch's own suffixed name. Only when no ref carries it does
 * the read fall back once to {@link LEGACY_STATE_PATH}, the un-suffixed
 * path a pre-#156 repository still carries; the suffixed file this or any
 * later run publishes ends the fallback.
 *
 * - `getContents` is injected so tests can double the forge layer.
 * - `404` (absent) is `null` from the injected reader — forge already
 *   converts that. `getContents` may return `null` for absent; other
 *   `HttpError`s propagate as thrown `ForgeError`s.
 * - A file that exists but fails to parse (corrupt, hand-edited wrongly) is
 *   treated as absent (`null`). This follows from the doctrine: advisory
 *   state never blocks a run. The repository's actual bytes stay the sole
 *   authority; a corrupt advisory file degrades gracefully to "no prior
 *   state" so the run recomputes everything. What recomputation means for a
 *   pair with existing bytes is the protection policy's call: with no record
 *   there is no verified base, so the pair is preserved — never overwritten.
 *   The verdict is final for the ref that owns the file: a corrupt branch
 *   file is never replaced by a stale default, and a found-but-corrupt
 *   suffixed file is never replaced by the legacy copy — the fallback read
 *   answers absence, not corruption.
 *
 * @param {{ getContents: ContentsReader, branchRef: string | null, defaultRef: string, sourceLanguage: string }} args
 *   `branchRef` is the resolved harmonise branch tip SHA, or `null` when the
 *   branch does not exist; `defaultRef` is the resolved default-branch SHA;
 *   `sourceLanguage` is the branch key the advisory paths are suffixed by.
 * @returns {Promise<{ records: SyncStateRecord[], origin: "branch" | "default" } | null>}
 */
export async function readState({ getContents, branchRef, defaultRef, sourceLanguage }) {
  const path = statePath(sourceLanguage);
  const fromBranch = branchRef === null ? null : await getContents(path, { ref: branchRef });
  if (fromBranch !== null) return parseRecords(fromBranch.content, "branch");

  const fromDefault = await getContents(path, { ref: defaultRef });
  if (fromDefault !== null) return parseRecords(fromDefault.content, "default");

  // One-cycle legacy fallback: no ref carries the suffixed file, so a
  // repository not yet republished under the suffixed names is read from
  // the paths it has — branch tip first, default second, same rules.
  const legacyBranch =
    branchRef === null ? null : await getContents(LEGACY_STATE_PATH, { ref: branchRef });
  if (legacyBranch !== null) return parseRecords(legacyBranch.content, "branch");

  const legacyDefault = await getContents(LEGACY_STATE_PATH, { ref: defaultRef });
  if (legacyDefault !== null) return parseRecords(legacyDefault.content, "default");

  return null;
}

/**
 * Parses one fetched sync-state file under the advisory doctrine: a file
 * that exists but fails to parse degrades to absent, and the degradation is
 * final — no fall-through to another ref and no substitution from another
 * path.
 *
 * @param {string} content
 * @param {"branch" | "default"} origin
 * @returns {{ records: SyncStateRecord[], origin: "branch" | "default" } | null}
 */
function parseRecords(content, origin) {
  try {
    return { records: parseState(content).records, origin };
  } catch {
    // Advisory: unparseable state degrades to absent so the run
    // recomputes from real bytes. The branch owns its state file and a
    // corrupt one is the branch's signal, not a reason to silently
    // substitute a stale default.
    return null;
  }
}
