/**
 * Translation memory (TM) for `harmonise` — an in-memory, advisory cache of
 * previously produced translations, keyed by `(sourceHash, targetLang,
 * policyContext)`. This module is deliberately pure: it imports nothing and
 * wires into nothing, so a later change can decide where recording and
 * lookups happen without this file ever knowing. The caller computes the
 * source hash; this module never imports a fingerprint implementation and
 * never hashes anything itself.
 *
 * ADVISORY, NOT AUTHORITATIVE. A TM hit is a cached suggestion — it may be
 * stale the moment it is stored, and nothing in this module can tell. The
 * doctrine is the same one that governs model output everywhere in this
 * repository: a value read back from this store MUST pass exactly the same
 * downstream checks as fresh model output before it reaches a pull request,
 * and a caller that skips those checks because "the store said so" is the
 * bug. The store validates only its own bookkeeping — string types, key
 * shape, schema version — and never judges translation content.
 *
 * Exact match only, with one opt-in second tier. `lookup` answers from the
 * entry whose key equals the queried key (tier 1), or — when the store was
 * built with `normalizeWhitespace: true` — from an entry whose key differs
 * only in insignificant whitespace of its components (tier 2). There is no
 * fuzzy matching in v1, and none is wanted: accepting near-misses would let
 * the store resurrect a stale translation for source that has changed, and
 * whether that happens would depend on a similarity threshold and on the
 * store's recording history — nondeterminism a translation pipeline cannot
 * afford. If the source is unchanged, its key is unchanged and the exact
 * tier finds it; if it changed, the store has nothing to say.
 */

/**
 * The default memory cap. The store lives for one action run and holds
 * completed block translations; this is far above any real diff, and the LRU
 * bound below is what keeps a pathological input from growing memory without
 * limit. The cap is a memory bound, not a policy statement: an eviction
 * means the store forgot an old suggestion, never that anything remaining
 * became authoritative.
 */
export const TM_MAX_ENTRIES = 1000;

/**
 * The only schema version `serialize` emits and the only one `parse`
 * accepts. A document wearing any other version is refused whole —
 * fail-closed — because guessing at a foreign schema is how a cache quietly
 * returns nonsense.
 */
export const TM_SCHEMA_VERSION = 1;

/**
 * The path the translation memory occupies beside the sync state, written by
 * the same publication that writes the state file. Advisory as a reference:
 * a file that is missing, corrupt or of a foreign schema version is an empty
 * memory — never an error, never a skip on its own. For a pair whose target
 * drifted outside harmonise the memory is also the only source of the merge
 * base, and there its absence is a manual-edit protection refusal — never a
 * silent overwrite.
 */
export const TM_PATH = ".github/action-agents/harmonise/tm.json";

/**
 * The three caller-supplied strings an entry is keyed by. All three are
 * opaque to this module; only equality ever matters.
 *
 * @typedef {object} TmKeyParts
 * @property {string} sourceHash caller-computed identity of the source text
 * @property {string} targetLang language the translation is into
 * @property {string} policyContext caller's namespacing of the translation policy (glossary set, register, ...)
 */

/**
 * @typedef {object} TmStoreOptions
 * @property {number} [maxEntries] eviction cap; defaults to `TM_MAX_ENTRIES`; must be a positive integer
 * @property {boolean} [normalizeWhitespace] enable the normalized-whitespace second lookup tier; default off
 */

/**
 * @typedef {object} TmStore
 * @property {(key: string) => string | undefined} lookup exact match first, then the normalized-whitespace tier when enabled
 * @property {(key: string, value: string) => void} record store or update a translation; strict about types and key shape
 * @property {() => number} size number of stored entries (tier-2 aliases are derived state, never counted)
 */

/**
 * @typedef {object} TmStoreEntry
 * @property {TmKeyParts} parts the key decoded back into its three strings
 * @property {string} value the stored translation
 */

/**
 * @typedef {object} TmStoreInternal
 * @property {Map<string, TmStoreEntry>} entries built key → entry; iteration order is recency, oldest first
 */

/** @type {WeakMap<TmStore, TmStoreInternal>} */
const internals = new WeakMap();

/**
 * Fail-closed type gate for the strings this module's API is built from: a
 * non-string argument is a caller bug, not data to coerce.
 *
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is string}
 */
function assertString(value, name) {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string, got ${value === null ? "null" : typeof value}`);
  }
}

/**
 * Builds a key from its parts: each part written as `len:part`, joined, where
 * `len` is the part's length in UTF-16 code units.
 *
 * @param {string[]} parts exactly three strings
 * @returns {string}
 */
function encodeParts(parts) {
  return parts.map((part) => `${part.length}:${part}`).join("");
}

/**
 * The whitespace-normalized spelling of a key: each component trimmed and its
 * internal whitespace runs collapsed to one space. Normalization operates on
 * the decoded PARTS, never on the built key string — a built key is
 * length-prefixed, so collapsing whitespace inside it would produce a string
 * no decoding agrees with.
 *
 * @param {TmKeyParts} parts
 * @returns {string}
 */
function normalizedKey(parts) {
  return encodeParts(
    [parts.sourceHash, parts.targetLang, parts.policyContext].map((part) =>
      part.trim().replace(/\s+/g, " "),
    ),
  );
}

/**
 * Builds the store's key from its three parts. The encoding is a
 * length-prefixed join, chosen over any separator join because it is
 * collision-free by construction: a naive `parts.join(":")` gives the same
 * string for ("a", "b:c", "d") and ("a:b", "c", "d"), while length prefixes
 * make the split unambiguous — and the key decodable, which `record` does to
 * keep the parts available for serialization. Deterministic: the same parts
 * always produce the same string.
 *
 * @param {TmKeyParts} parts
 * @returns {string}
 */
export function buildTmKey({ sourceHash, targetLang, policyContext }) {
  assertString(sourceHash, "sourceHash");
  assertString(targetLang, "targetLang");
  assertString(policyContext, "policyContext");
  return encodeParts([sourceHash, targetLang, policyContext]);
}

/**
 * Decodes a key built by `buildTmKey` back into its three parts, or returns
 * null for anything else — wrong segment count, non-numeric length, truncated
 * part, trailing bytes. The check is total, so an arbitrary string can never
 * masquerade as a key.
 *
 * @param {string} key
 * @returns {TmKeyParts | null}
 */
function decodeTmKey(key) {
  /** @type {string[]} */
  const parts = [];
  let cursor = 0;
  for (let remaining = 3; remaining > 0; remaining--) {
    const colon = key.indexOf(":", cursor);
    if (colon === -1) return null;
    const lengthText = key.slice(cursor, colon);
    if (!/^\d+$/.test(lengthText)) return null;
    const length = Number(lengthText);
    const part = key.slice(colon + 1, colon + 1 + length);
    if (part.length !== length) return null;
    parts.push(part);
    cursor = colon + 1 + length;
  }
  const [sourceHash, targetLang, policyContext] = parts;
  if (
    cursor !== key.length ||
    sourceHash === undefined ||
    targetLang === undefined ||
    policyContext === undefined
  ) {
    return null;
  }
  return { sourceHash, targetLang, policyContext };
}

/**
 * Creates an in-memory store bounded by `maxEntries`.
 *
 * Eviction is deterministic LRU by insertion/access order. The entries Map's
 * iteration order IS the recency order: recording a new key places it at the
 * most-recent end, re-recording an existing key updates it in place and moves
 * it there too, a lookup hit moves the entry there as well, and when a record
 * pushes the size past the cap the Map's first key — the least-recently
 * inserted-or-accessed entry — is evicted until the size fits. No timestamps,
 * no randomness: replaying the same call sequence against a fresh store
 * evicts the same entries in the same order.
 *
 * With `normalizeWhitespace: true`, a second lookup tier treats key
 * components as equal when they differ only in leading, trailing, or repeated
 * whitespace. The tier is an index from normalized key to the most recently
 * recorded primary key (last record wins — defined, not random); a tier-2 hit
 * refreshes that primary entry's recency, and evicting a primary entry drops
 * its alias only when the alias still names it, so an older spelling may lose
 * its tier-2 route while surviving exact lookups. The tier changes which KEY
 * answers, never how much it is trusted: the value still goes through the
 * caller's downstream checks like any other hit.
 *
 * @param {TmStoreOptions} [options]
 * @returns {TmStore}
 */
export function createTmStore(options = {}) {
  const maxEntries = options.maxEntries === undefined ? TM_MAX_ENTRIES : options.maxEntries;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError(`maxEntries must be a positive integer, got ${String(maxEntries)}`);
  }
  const normalizeWhitespace = options.normalizeWhitespace === true;

  /** Recency order IS iteration order: oldest first, freshest last. */
  const entries = new Map();
  /** Derived tier-2 index: normalized key → primary built key. */
  const aliases = new Map();

  /**
   * Moves an existing entry to the most-recent end.
   *
   * @param {string} key
   * @param {TmStoreEntry} entry
   */
  const touch = (key, entry) => {
    entries.delete(key);
    entries.set(key, entry);
  };

  /** Evicts oldest entries until within the cap; drops aliases that name them. */
  const evictOverflow = () => {
    while (entries.size > maxEntries) {
      const oldest = entries.entries().next();
      // The loop condition guarantees a first entry; the guard keeps tsc
      // honest about `noUncheckedIndexedAccess` all the same.
      if (oldest.done === true) return;
      const [oldestKey, evicted] = oldest.value;
      entries.delete(oldestKey);
      const normalized = normalizedKey(evicted.parts);
      if (aliases.get(normalized) === oldestKey) {
        aliases.delete(normalized);
      }
    }
  };

  /**
   * Stores a translation under an exact key. Re-recording an existing key
   * updates the value and refreshes its recency without growing the store.
   *
   * Strict, because the store keeps the decoded parts for serialization: a
   * non-string value, or a key that is not a `buildTmKey` product, would make
   * a later `serialize` unable to reproduce what was stored — so both are a
   * caller bug refused with a `TypeError`, not data to patch over.
   *
   * @param {string} key
   * @param {string} value
   * @returns {void}
   */
  const record = (key, value) => {
    assertString(key, "key");
    assertString(value, "value");
    const parts = decodeTmKey(key);
    if (parts === null) {
      throw new TypeError("record() requires a key built by buildTmKey()");
    }
    const existing = entries.get(key);
    if (existing === undefined) {
      entries.set(key, { parts, value });
    } else {
      existing.value = value;
      touch(key, existing);
    }
    if (normalizeWhitespace) {
      aliases.set(normalizedKey(parts), key);
    }
    evictOverflow();
  };

  /**
   * Answers the stored translation for a key, or undefined. Lenient by
   * design — a lookup is a read, so an unknown, garbage, or non-string key is
   * a miss, never an error.
   *
   * @param {string} key
   * @returns {string | undefined}
   */
  const lookup = (key) => {
    if (typeof key !== "string") return undefined;
    const exact = entries.get(key);
    if (exact !== undefined) {
      touch(key, exact);
      return exact.value;
    }
    if (!normalizeWhitespace) return undefined;
    const parts = decodeTmKey(key);
    if (parts === null) return undefined;
    const primary = aliases.get(normalizedKey(parts));
    if (primary === undefined || primary === key) return undefined;
    const entry = entries.get(primary);
    if (entry === undefined) return undefined;
    touch(primary, entry);
    return entry.value;
  };

  /** @returns {number} */
  const size = () => entries.size;

  /** @type {TmStore} */
  const store = { lookup, record, size };
  internals.set(store, { entries });
  return store;
}

/**
 * A serialized entry: the key as its three parts, so a parsed document can
 * rebuild the exact keys.
 *
 * @typedef {object} TmSerializedEntry
 * @property {TmKeyParts} key
 * @property {string} value
 */

/**
 * JSON round-trip, versioned by `tmSchemaVersion`. Entries are written
 * oldest-first, so `parse` can replay them in order and the LRU order
 * survives the trip. Tier-2 aliases are derived state and are never written:
 * `parse` re-derives them from the keys themselves.
 *
 * @param {TmStore} store
 * @returns {string}
 */
export function serialize(store) {
  const internal = internals.get(store);
  if (internal === undefined) {
    throw new TypeError("serialize() expects a store created by createTmStore()");
  }
  /** @type {TmSerializedEntry[]} */
  const serialized = [];
  for (const entry of internal.entries.values()) {
    serialized.push({
      key: {
        sourceHash: entry.parts.sourceHash,
        targetLang: entry.parts.targetLang,
        policyContext: entry.parts.policyContext,
      },
      value: entry.value,
    });
  }
  return JSON.stringify({ tmSchemaVersion: TM_SCHEMA_VERSION, entries: serialized });
}

/**
 * @typedef {object} TmRefusal
 * @property {string} reason what was wrong, in the module's own words
 * @property {number} [index] position in `entries`, for per-entry refusals
 * @property {unknown} [found] the offending value, when there is one
 */

/**
 * The reason an entry of a serialized document cannot be recorded, or null
 * when the entry is well-formed.
 *
 * @param {unknown} entry
 * @returns {string | null}
 */
function entryProblem(entry) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return "entry is not a JSON object";
  }
  const candidate = /** @type {{ key: unknown, value: unknown }} */ (entry);
  if (typeof candidate.key !== "object" || candidate.key === null || Array.isArray(candidate.key)) {
    return "entry.key is not a JSON object";
  }
  const parts = /** @type {Record<string, unknown>} */ (candidate.key);
  for (const field of ["sourceHash", "targetLang", "policyContext"]) {
    if (typeof parts[field] !== "string") {
      return `entry.key.${field} is not a string`;
    }
  }
  if (typeof candidate.value !== "string") {
    return "entry.value is not a string";
  }
  return null;
}

/**
 * Rebuilds a store from `serialize` output.
 *
 * Fail-closed at the document level: an unparsable document, a non-object
 * root, or a foreign `tmSchemaVersion` refuses the WHOLE document — nothing
 * is accepted from it. A store that accepted 999 records and quietly dropped
 * one unreadable remainder would be a cache whose contents you cannot reason
 * about. Per-entry malformations are refused individually and REPORTED, never
 * silently dropped: the returned `refused` array says exactly what was
 * rejected, where, and why, and the caller decides what a refusal means.
 *
 * Entries are replayed in document order (oldest first), so a document larger
 * than the cap keeps its newest entries — trimming is eviction, not refusal —
 * and duplicate keys inside one document resolve to their last occurrence.
 *
 * @param {string} text
 * @param {TmStoreOptions} [options]
 * @returns {{ store: TmStore, refused: TmRefusal[] }}
 */
export function parse(text, options = {}) {
  assertString(text, "text");
  /** @type {TmRefusal[]} */
  const refused = [];
  /** @type {unknown} */
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    refused.push({ reason: "document is not valid JSON" });
    return { store: createTmStore(options), refused };
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    refused.push({ reason: "document root is not a JSON object" });
    return { store: createTmStore(options), refused };
  }
  const root = /** @type {Record<string, unknown>} */ (document);
  if (root.tmSchemaVersion !== TM_SCHEMA_VERSION) {
    refused.push({ reason: "unsupported tmSchemaVersion", found: root.tmSchemaVersion });
    return { store: createTmStore(options), refused };
  }
  if (!Array.isArray(root.entries)) {
    refused.push({ reason: "entries is not an array" });
    return { store: createTmStore(options), refused };
  }
  const store = createTmStore(options);
  const entries = root.entries;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const problem = entryProblem(entry);
    if (problem !== null) {
      refused.push({ index, reason: problem, found: entry });
      continue;
    }
    const valid = /** @type {{ key: TmKeyParts, value: string }} */ (entry);
    store.record(buildTmKey(valid.key), valid.value);
  }
  return { store, refused };
}

// ── read from repository ─────────────────────────────────────────────────────

/**
 * The contents-reading slice of a forge client that `readTm` needs, identical
 * to the one `readState` consumes: reads one file from the repository at an
 * optional ref, or from the default branch when no ref is given. Absent is
 * `null`.
 *
 * @typedef {import("./state.mjs").ContentsReader} ContentsReader
 */

/**
 * Reads the translation memory from the repository, trying the harmonise
 * branch tip first, then the default branch — the same snapshot authority
 * `readState` uses, so a state record written by one run can always resolve
 * the merge base it references on the next run even while the proposal pull
 * request is still unmerged. A run publishes `state.json` and `tm.json` in
 * one commit on the `harmonise/<lang>` branch; reading both from that same
 * branch tip keeps the state→memory join resolvable across the open PR.
 *
 * Mirrors `readState`:
 * - `getContents` is injected so tests can double the forge layer.
 * - `404` (absent) is `null` from the injected reader; other `HttpError`s
 *   propagate as thrown `ForgeError`s.
 * - The branch owns its TM file the way it owns its state file: when the
 *   branch carries the file, the default branch is never read, so a file
 *   the branch has is never silently substituted by a stale default.
 *
 * One deliberate difference, `parse`'s contract rather than a new policy:
 * `parseState` throws on a corrupt file, so `readState` degrades corruption
 * to `null`; `parse` never throws — it refuses a whole corrupt document
 * fail-closed and returns an empty store, reporting what it refused. A file
 * that exists but fails to parse therefore yields an empty memory with the
 * file's origin recorded, not `null` — the branch's file was found, its
 * refusal is final, and the run proceeds exactly as a repository without a
 * memory file always has. Advisory as a reference, and the only source of a
 * three-way merge base: there a memory without the recorded entry is a
 * manual-edit protection refusal — never a silent overwrite.
 *
 * @param {{ getContents: ContentsReader, branch: string, defaultBranch: string }} args
 * @returns {Promise<{ store: TmStore, origin: "branch" | "default" } | null>}
 */
export async function readTm({ getContents, branch, defaultBranch }) {
  const fromBranch = await getContents(TM_PATH, { ref: branch });
  if (fromBranch !== null) {
    // The branch's file was found: no fall-through to the default branch,
    // whatever parse makes of the bytes.
    return { store: parse(fromBranch.content).store, origin: "branch" };
  }

  const fromDefault = await getContents(TM_PATH, { ref: defaultBranch });
  if (fromDefault !== null) {
    return { store: parse(fromDefault.content).store, origin: "default" };
  }

  return null;
}
