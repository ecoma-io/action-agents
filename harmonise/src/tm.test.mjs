// Tests for the translation memory store. The rules under test are narrow:
// keys are collision-free encodings of their three parts, the store answers
// only exact (or, opt-in, whitespace-normalized) key matches and never
// judges content, the store keeps every recorded entry — it never evicts,
// because a forgotten entry is a merge base a state record can never reach
// again — and `parse` refuses foreign or malformed documents whole while
// reporting every entry it had to refuse.

import { describe, expect, it } from "vitest";

import {
  buildTmKey,
  createTmStore,
  LEGACY_TM_PATH,
  parse,
  readTm,
  serialize,
  tmPath,
  TM_SCHEMA_VERSION,
} from "./tm.mjs";

/**
 * @param {string} sourceHash
 * @param {string} targetLang
 * @param {string} policyContext
 */
function key(sourceHash, targetLang, policyContext) {
  return buildTmKey({ sourceHash, targetLang, policyContext });
}

describe("buildTmKey", () => {
  it("is deterministic", () => {
    expect(key("alpha", "fr", "strict")).toBe(key("alpha", "fr", "strict"));
  });

  it("never collides across splits a separator join would confuse", () => {
    expect(key("a", "bc", "d")).not.toBe(key("ab", "c", "d"));
    expect(key("a", "b", "cd")).not.toBe(key("a", "bc", "d"));
    expect(key("1:", "b", "c")).not.toBe(key("1", ":b", "c"));
  });

  it("refuses non-string parts instead of coercing them", () => {
    expect(() =>
      buildTmKey({ sourceHash: /** @type {any} */ (7), targetLang: "fr", policyContext: "c" }),
    ).toThrow(TypeError);
    expect(() =>
      buildTmKey({ sourceHash: "a", targetLang: /** @type {any} */ (null), policyContext: "c" }),
    ).toThrow(TypeError);
  });
});

describe("store", () => {
  it("answers exact-key lookups and counts entries", () => {
    const store = createTmStore();
    expect(store.size()).toBe(0);
    expect(store.lookup(key("alpha", "fr", "strict"))).toBeUndefined();

    store.record(key("alpha", "fr", "strict"), "bonjour");
    expect(store.lookup(key("alpha", "fr", "strict"))).toBe("bonjour");
    expect(store.size()).toBe(1);
  });

  it("keeps keys with different parts apart", () => {
    const store = createTmStore();
    store.record(key("alpha", "fr", "strict"), "bonjour");
    store.record(key("alpha", "de", "strict"), "hallo");
    store.record(key("beta", "fr", "strict"), "salut");
    expect(store.lookup(key("alpha", "fr", "strict"))).toBe("bonjour");
    expect(store.lookup(key("alpha", "de", "strict"))).toBe("hallo");
    expect(store.lookup(key("beta", "fr", "strict"))).toBe("salut");
    expect(store.size()).toBe(3);
  });

  it("re-recording a key updates the value without growing the store", () => {
    const store = createTmStore();
    store.record(key("alpha", "fr", "strict"), "bonjour");
    store.record(key("alpha", "fr", "strict"), "salut");
    expect(store.lookup(key("alpha", "fr", "strict"))).toBe("salut");
    expect(store.size()).toBe(1);
  });

  it("accepts empty-string key parts — they are still strings", () => {
    const store = createTmStore();
    store.record(key("", "fr", ""), "v");
    expect(store.lookup(key("", "fr", ""))).toBe("v");
  });
});

describe("fail-closed API misuse", () => {
  it("refuses non-string keys and values on record", () => {
    const store = createTmStore();
    expect(() => store.record(/** @type {any} */ (7), "x")).toThrow(TypeError);
    expect(() => store.record(key("alpha", "fr", "strict"), /** @type {any} */ (null))).toThrow(
      TypeError,
    );
  });

  it("refuses a record whose key was not built by buildTmKey", () => {
    const store = createTmStore();
    expect(() => store.record("alpha/fr/strict", "x")).toThrow(TypeError);
    expect(() => store.record("", "x")).toThrow(TypeError);
    expect(() => store.record(key("alpha", "fr", "strict").slice(0, -1), "x")).toThrow(TypeError);
    expect(() => store.record(`${key("alpha", "fr", "strict")}x`, "x")).toThrow(TypeError);
  });
});

describe("unbounded store", () => {
  it("keeps every entry — the store never evicts, even far past the old 1000-entry cap", () => {
    const store = createTmStore();
    for (let index = 0; index < 1001; index++) {
      store.record(key(`h${index}`, "fr", "ctx"), `v${index}`);
    }
    expect(store.size()).toBe(1001);
    // The oldest entry may be a recorded pair's only merge base: eviction
    // would be data loss, so nothing is dropped, oldest included.
    expect(store.lookup(key("h0", "fr", "ctx"))).toBe("v0");
    expect(store.lookup(key("h1000", "fr", "ctx"))).toBe("v1000");
  });

  it("re-recording an existing key updates the value without growing the store", () => {
    const store = createTmStore();
    store.record(key("a", "fr", "ctx"), "1");
    store.record(key("b", "fr", "ctx"), "2");
    store.record(key("a", "fr", "ctx"), "1b");
    expect(store.size()).toBe(2);
    expect(store.lookup(key("b", "fr", "ctx"))).toBe("2");
    expect(store.lookup(key("a", "fr", "ctx"))).toBe("1b");
  });

  it("a lookup never drops a sibling entry", () => {
    const store = createTmStore();
    store.record(key("a", "fr", "ctx"), "1");
    store.record(key("b", "fr", "ctx"), "2");
    expect(store.lookup(key("a", "fr", "ctx"))).toBe("1");
    expect(store.lookup(key("b", "fr", "ctx"))).toBe("2");
    expect(store.size()).toBe(2);
  });
});

describe("normalized-whitespace tier", () => {
  const k1 = key("alpha beta", "fr", "ctx");
  const k2 = key("alpha  beta", "fr", "ctx"); // doubled internal space
  const k3 = key("  alpha beta ", "fr", "ctx"); // leading and trailing space
  const k4 = key("alpha\tbeta\n", "fr", "ctx"); // tab and newline

  it("is off by default: whitespace variants are different keys", () => {
    const store = createTmStore();
    store.record(k1, "v");
    expect(store.lookup(k2)).toBeUndefined();
    expect(store.size()).toBe(1);
  });

  it("answers whitespace variants when enabled, exact tier first", () => {
    const store = createTmStore({ normalizeWhitespace: true });
    store.record(k1, "v");
    expect(store.lookup(k1)).toBe("v");
    expect(store.lookup(k2)).toBe("v");
    expect(store.lookup(k3)).toBe("v");
    expect(store.lookup(k4)).toBe("v");
  });

  it("keeps distinct raw keys distinct while the alias follows the last record", () => {
    const store = createTmStore({ normalizeWhitespace: true });
    store.record(k1, "first");
    store.record(k2, "second");
    expect(store.lookup(k1)).toBe("first");
    expect(store.lookup(k2)).toBe("second");
    expect(store.lookup(k3)).toBe("second"); // alias: last record wins
    expect(store.size()).toBe(2);
  });

  it("never throws on a key it cannot decode", () => {
    const store = createTmStore({ normalizeWhitespace: true });
    expect(store.lookup("garbage")).toBeUndefined();
  });
});

describe("serialize/parse", () => {
  it("emits a versioned document with keys decoded into their parts, oldest first", () => {
    const store = createTmStore();
    store.record(key("alpha", "fr", "strict"), "bonjour");
    store.record(key("beta", "de", "loose"), "hallo");
    const document = JSON.parse(serialize(store));
    expect(document.tmSchemaVersion).toBe(TM_SCHEMA_VERSION);
    expect(document.entries).toEqual([
      {
        key: { sourceHash: "alpha", targetLang: "fr", policyContext: "strict" },
        value: "bonjour",
      },
      {
        key: { sourceHash: "beta", targetLang: "de", policyContext: "loose" },
        value: "hallo",
      },
    ]);
  });

  it("round-trips values and size — every entry survives the trip", () => {
    const store = createTmStore();
    store.record(key("a", "fr", "ctx"), "1");
    store.record(key("b", "fr", "ctx"), "2");
    store.record(key("c", "fr", "ctx"), "3");
    store.record(key("d", "fr", "ctx"), "4");

    const revived = parse(serialize(store));
    expect(revived.refused).toEqual([]);
    expect(revived.store.size()).toBe(4);
    expect(revived.store.lookup(key("a", "fr", "ctx"))).toBe("1");
    expect(revived.store.lookup(key("d", "fr", "ctx"))).toBe("4");
  });

  it("with keepKeys, omits every entry whose built key is not in the set", () => {
    const store = createTmStore();
    store.record(key("alpha", "fr", "strict"), "bonjour");
    store.record(key("beta", "de", "loose"), "hallo");
    const keep = new Set([key("beta", "de", "loose")]);
    const document = JSON.parse(serialize(store, { keepKeys: keep }));
    expect(document.entries).toEqual([
      { key: { sourceHash: "beta", targetLang: "de", policyContext: "loose" }, value: "hallo" },
    ]);
  });

  it("without keepKeys, serializes every entry", () => {
    const store = createTmStore();
    store.record(key("alpha", "fr", "strict"), "bonjour");
    store.record(key("beta", "de", "loose"), "hallo");
    expect(JSON.parse(serialize(store)).entries).toHaveLength(2);
  });

  it("re-derives tier-2 aliases on parse — they are not serialized state", () => {
    const store = createTmStore({ normalizeWhitespace: true });
    store.record(key("alpha beta", "fr", "ctx"), "v");
    const revived = parse(serialize(store), { normalizeWhitespace: true });
    expect(revived.refused).toEqual([]);
    expect(revived.store.lookup(key("alpha  beta", "fr", "ctx"))).toBe("v");
  });

  it("replays a document far larger than any old bound whole, without refusals", () => {
    const entries = [];
    for (let index = 0; index < 1001; index++) {
      entries.push({
        key: { sourceHash: `h${index}`, targetLang: "fr", policyContext: "ctx" },
        value: `v${index}`,
      });
    }
    const { store, refused } = parse(
      JSON.stringify({ tmSchemaVersion: TM_SCHEMA_VERSION, entries }),
    );
    expect(refused).toEqual([]);
    expect(store.size()).toBe(1001);
    expect(store.lookup(key("h0", "fr", "ctx"))).toBe("v0");
    expect(store.lookup(key("h1000", "fr", "ctx"))).toBe("v1000");
  });

  it("duplicate keys inside one document resolve to their last occurrence", () => {
    const entries = [
      { key: { sourceHash: "a", targetLang: "fr", policyContext: "c" }, value: "first" },
      { key: { sourceHash: "a", targetLang: "fr", policyContext: "c" }, value: "second" },
    ];
    const { store, refused } = parse(
      JSON.stringify({ tmSchemaVersion: TM_SCHEMA_VERSION, entries }),
    );
    expect(refused).toEqual([]);
    expect(store.size()).toBe(1);
    expect(store.lookup(key("a", "fr", "c"))).toBe("second");
  });

  it("refuses to serialize something that is not a store", () => {
    expect(() => serialize(/** @type {any} */ ({}))).toThrow(TypeError);
  });
});

describe("parse refusals", () => {
  it("refuses a document that is not valid JSON", () => {
    const { store, refused } = parse("{not json");
    expect(store.size()).toBe(0);
    expect(refused).toEqual([{ reason: "document is not valid JSON" }]);
  });

  it("refuses a root that is not a JSON object", () => {
    for (const text of ["42", "null", "[1, 2]", '"a string"']) {
      const { store, refused } = parse(text);
      expect(store.size()).toBe(0);
      expect(refused).toEqual([{ reason: "document root is not a JSON object" }]);
    }
  });

  it("refuses a foreign schema version whole, whatever the entries look like", () => {
    const document = {
      tmSchemaVersion: TM_SCHEMA_VERSION + 1,
      entries: [{ key: { sourceHash: "a", targetLang: "fr", policyContext: "c" }, value: "v" }],
    };
    const { store, refused } = parse(JSON.stringify(document));
    expect(store.size()).toBe(0);
    expect(refused).toEqual([
      { reason: "unsupported tmSchemaVersion", found: TM_SCHEMA_VERSION + 1 },
    ]);
  });

  it("refuses a missing, string-typed or null schema version", () => {
    for (const root of [
      { entries: [] },
      { tmSchemaVersion: "1", entries: [] },
      { tmSchemaVersion: null, entries: [] },
    ]) {
      const { store, refused } = parse(JSON.stringify(root));
      expect(store.size()).toBe(0);
      expect(refused[0]?.reason).toBe("unsupported tmSchemaVersion");
    }
  });

  it("refuses entries that are not an array", () => {
    const { refused } = parse(JSON.stringify({ tmSchemaVersion: TM_SCHEMA_VERSION, entries: {} }));
    expect(refused).toEqual([{ reason: "entries is not an array" }]);
  });

  it("refuses malformed entries individually and reports them with their index", () => {
    const good = { key: { sourceHash: "g", targetLang: "fr", policyContext: "c" }, value: "v" };
    const entries = [
      good,
      42,
      [1],
      { key: { sourceHash: "a", targetLang: "fr" }, value: "v" },
      { key: { sourceHash: "a", targetLang: "fr", policyContext: "c" } },
      { key: "not an object", value: "v" },
      { key: [1], value: "v" },
      { key: { sourceHash: 9, targetLang: "fr", policyContext: "c" }, value: "v" },
      { key: { sourceHash: "a", targetLang: "fr", policyContext: "c" }, value: 7 },
    ];
    const { store, refused } = parse(
      JSON.stringify({ tmSchemaVersion: TM_SCHEMA_VERSION, entries }),
    );
    expect(store.size()).toBe(1);
    expect(store.lookup(key("g", "fr", "c"))).toBe("v");
    expect(refused).toEqual([
      { index: 1, reason: "entry is not a JSON object", found: 42 },
      { index: 2, reason: "entry is not a JSON object", found: [1] },
      { index: 3, reason: "entry.key.policyContext is not a string", found: entries[3] },
      { index: 4, reason: "entry.value is not a string", found: entries[4] },
      { index: 5, reason: "entry.key is not a JSON object", found: entries[5] },
      { index: 6, reason: "entry.key is not a JSON object", found: entries[6] },
      { index: 7, reason: "entry.key.sourceHash is not a string", found: entries[7] },
      { index: 8, reason: "entry.value is not a string", found: entries[8] },
    ]);
  });

  it("refuses a null entry", () => {
    const { refused } = parse(
      JSON.stringify({ tmSchemaVersion: TM_SCHEMA_VERSION, entries: [null] }),
    );
    expect(refused).toEqual([{ index: 0, reason: "entry is not a JSON object", found: null }]);
  });

  it("throws on non-string input", () => {
    expect(() => parse(/** @type {any} */ (undefined))).toThrow(TypeError);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * A forge contents double: maps (path, ref) → text, mirroring
 * `forge.getContents` — absent is `null`, other failures throw. Returns the
 * bare function, the shape `readTm` receives.
 *
 * @param {Record<string, Record<string, string | null>>} byRef ref → path → content
 * @param {{ onCall?: (path: string, ref?: string) => void }} [hooks]
 * @returns {import("./tm.mjs").ContentsReader}
 */
function contentsReader(byRef, hooks = {}) {
  return async (path, options = {}) => {
    const ref = options.ref;
    hooks.onCall?.(path, ref);
    const files = byRef[ref ?? ""];
    if (files === undefined) return null;
    const content = files[path];
    return content === null || content === undefined ? null : { content };
  };
}

// ── readTm ───────────────────────────────────────────────────────────────────

describe("readTm", () => {
  const BRANCH = "harmonise/en";
  const DEFAULT = "main";
  const LANG = "en";
  const PATH = tmPath(LANG);
  /** One entry as valid serialized TM. */
  function tmText() {
    const store = createTmStore();
    store.record(buildTmKey({ sourceHash: "abc", targetLang: "vi", policyContext: "p" }), "base");
    return serialize(store);
  }

  it("pins the TM paths", () => {
    expect(tmPath("vi")).toBe(".github/action-agents/harmonise/tm.vi.json");
    expect(LEGACY_TM_PATH).toBe(".github/action-agents/harmonise/tm.json");
  });

  it("reads the branch tip first and reports origin 'branch'", async () => {
    const refs = /** @type {string[]} */ ([]);
    const reader = contentsReader(
      { [BRANCH]: { [PATH]: tmText() }, [DEFAULT]: { [PATH]: "stale" } },
      { onCall: (_path, ref) => refs.push(ref ?? "") },
    );
    const result = await readTm({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).not.toBeNull();
    expect(result?.origin).toBe("branch");
    expect(
      result?.store.lookup(buildTmKey({ sourceHash: "abc", targetLang: "vi", policyContext: "p" })),
    ).toBe("base");
    expect(refs).toEqual([BRANCH]);
  });

  it("falls back to the default branch when the branch has no TM file", async () => {
    const refs = /** @type {string[]} */ ([]);
    const reader = contentsReader(
      { [DEFAULT]: { [PATH]: tmText() } },
      { onCall: (_path, ref) => refs.push(ref ?? "") },
    );
    const result = await readTm({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).not.toBeNull();
    expect(result?.origin).toBe("default");
    expect(
      result?.store.lookup(buildTmKey({ sourceHash: "abc", targetLang: "vi", policyContext: "p" })),
    ).toBe("base");
    expect(refs).toEqual([BRANCH, DEFAULT]);
  });

  it("falls back to the legacy path once when no ref carries the suffixed file", async () => {
    /** @type {string[]} */
    const reads = [];
    const reader = contentsReader(
      { [BRANCH]: { [LEGACY_TM_PATH]: tmText() } },
      { onCall: (path, ref) => reads.push(`${path}@${ref ?? ""}`) },
    );
    const result = await readTm({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).not.toBeNull();
    expect(result?.origin).toBe("branch");
    expect(
      result?.store.lookup(buildTmKey({ sourceHash: "abc", targetLang: "vi", policyContext: "p" })),
    ).toBe("base");
    // The ladder is exactly: suffixed branch, suffixed default, legacy
    // branch. The first suffixed publication ends the walk.
    expect(reads).toEqual([
      `${PATH}@${BRANCH}`,
      `${PATH}@${DEFAULT}`,
      `${LEGACY_TM_PATH}@${BRANCH}`,
    ]);
  });

  it("never consults the legacy copy when the branch carries a corrupt suffixed file", async () => {
    const refs = /** @type {string[]} */ ([]);
    const reader = contentsReader(
      { [BRANCH]: { [PATH]: "{not json" }, [DEFAULT]: { [LEGACY_TM_PATH]: tmText() } },
      { onCall: (_path, ref) => refs.push(ref ?? "") },
    );
    const result = await readTm({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).not.toBeNull();
    expect(result?.origin).toBe("branch");
    expect(result?.store.size()).toBe(0);
    expect(refs).toEqual([BRANCH]);
  });

  it("returns null when no branch carries the file", async () => {
    const reader = contentsReader({});
    const result = await readTm({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).toBeNull();
  });

  it("propagates a non-404 error from the forge layer", async () => {
    const base = contentsReader({});
    const failing = /** @type {import("./tm.mjs").ContentsReader} */ (
      async (path, options = {}) => {
        if (options?.ref === BRANCH) {
          throw new Error("HTTP 500: the forge is on fire");
        }
        return base(path, options);
      }
    );
    await expect(
      readTm({
        getContents: failing,
        branchRef: BRANCH,
        defaultRef: DEFAULT,
        sourceLanguage: LANG,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("degrades corrupt TM on the branch to an empty store — no default substitution", async () => {
    const refs = /** @type {string[]} */ ([]);
    const reader = contentsReader(
      { [BRANCH]: { [PATH]: "{not json" }, [DEFAULT]: { [PATH]: tmText() } },
      { onCall: (_path, ref) => refs.push(ref ?? "") },
    );
    const result = await readTm({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).not.toBeNull();
    expect(result?.origin).toBe("branch");
    expect(result?.store.size()).toBe(0);
    expect(refs).toEqual([BRANCH]);
  });

  it("degrades corrupt TM on the default branch to an empty store", async () => {
    const reader = contentsReader({
      [DEFAULT]: { [PATH]: "[]" },
    });
    const result = await readTm({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).not.toBeNull();
    expect(result?.origin).toBe("default");
    expect(result?.store.size()).toBe(0);
  });
});
