// Tests for the translation memory store. The rules under test are narrow:
// keys are collision-free encodings of their three parts, the store answers
// only exact (or, opt-in, whitespace-normalized) key matches and never
// judges content, eviction follows a replayable LRU order with the cap as a
// pure memory bound, and `parse` refuses foreign or malformed documents
// whole while reporting every entry it had to refuse.

import { describe, expect, it } from "vitest";

import {
  buildTmKey,
  createTmStore,
  parse,
  readTm,
  serialize,
  TM_MAX_ENTRIES,
  TM_PATH,
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
  it("refuses a maxEntries that is not a positive integer", () => {
    for (const maxEntries of [0, -1, 1.5, Number.NaN]) {
      expect(() => createTmStore({ maxEntries })).toThrow(TypeError);
    }
  });

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

describe("LRU eviction", () => {
  it("evicts the least-recently inserted-or-accessed entry at the cap", () => {
    const store = createTmStore({ maxEntries: 2 });
    store.record(key("a", "fr", "ctx"), "1");
    store.record(key("b", "fr", "ctx"), "2");
    store.record(key("c", "fr", "ctx"), "3");
    expect(store.size()).toBe(2);
    expect(store.lookup(key("a", "fr", "ctx"))).toBeUndefined();
    expect(store.lookup(key("b", "fr", "ctx"))).toBe("2");
    expect(store.lookup(key("c", "fr", "ctx"))).toBe("3");
  });

  it("a lookup hit refreshes recency and survives the next eviction", () => {
    const store = createTmStore({ maxEntries: 2 });
    store.record(key("a", "fr", "ctx"), "1");
    store.record(key("b", "fr", "ctx"), "2");
    expect(store.lookup(key("a", "fr", "ctx"))).toBe("1");
    store.record(key("c", "fr", "ctx"), "3");
    expect(store.lookup(key("a", "fr", "ctx"))).toBe("1");
    expect(store.lookup(key("b", "fr", "ctx"))).toBeUndefined();
  });

  it("re-recording an existing key at the cap evicts nothing", () => {
    const store = createTmStore({ maxEntries: 2 });
    store.record(key("a", "fr", "ctx"), "1");
    store.record(key("b", "fr", "ctx"), "2");
    store.record(key("a", "fr", "ctx"), "1b");
    expect(store.size()).toBe(2);
    expect(store.lookup(key("b", "fr", "ctx"))).toBe("2");
    expect(store.lookup(key("a", "fr", "ctx"))).toBe("1b");
  });

  it("the default cap is TM_MAX_ENTRIES", () => {
    const store = createTmStore();
    for (let index = 0; index < TM_MAX_ENTRIES + 1; index++) {
      store.record(key(`h${index}`, "fr", "ctx"), `v${index}`);
    }
    expect(store.size()).toBe(TM_MAX_ENTRIES);
    expect(store.lookup(key("h0", "fr", "ctx"))).toBeUndefined();
    expect(store.lookup(key(`h${TM_MAX_ENTRIES}`, "fr", "ctx"))).toBe(`v${TM_MAX_ENTRIES}`);
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

  it("a tier-2 hit refreshes the primary entry's recency", () => {
    const store = createTmStore({ maxEntries: 2, normalizeWhitespace: true });
    store.record(k1, "v1");
    store.record(key("other", "fr", "ctx"), "vo");
    expect(store.lookup(k4)).toBe("v1"); // tier-2 hit touches k1
    store.record(key("third", "fr", "ctx"), "v3");
    expect(store.lookup(k1)).toBe("v1");
    expect(store.lookup(key("other", "fr", "ctx"))).toBeUndefined();
  });

  it("evicting an entry takes its tier-2 alias with it when the alias names it", () => {
    const store = createTmStore({ maxEntries: 2, normalizeWhitespace: true });
    store.record(k1, "v1");
    store.record(key("other", "fr", "ctx"), "vo");
    store.record(key("third", "fr", "ctx"), "v3"); // evicts k1 and its alias
    expect(store.lookup(k1)).toBeUndefined();
    expect(store.lookup(k2)).toBeUndefined();
    expect(store.lookup(key("other", "fr", "ctx"))).toBe("vo");
    expect(store.size()).toBe(2);
  });

  it("an alias survives eviction of an older spelling when it names a newer record", () => {
    const store = createTmStore({ maxEntries: 2, normalizeWhitespace: true });
    store.record(k1, "first");
    store.record(k2, "second"); // alias now names k2
    store.record(key("third", "fr", "ctx"), "v3"); // evicts k1, alias kept
    expect(store.lookup(k1)).toBe("second"); // k1's normalized form resolves to k2
    expect(store.lookup(k3)).toBe("second");
    expect(store.lookup(k2)).toBe("second");
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

  it("round-trips values, size and the LRU bound", () => {
    const store = createTmStore({ maxEntries: 3 });
    store.record(key("a", "fr", "ctx"), "1");
    store.record(key("b", "fr", "ctx"), "2");
    store.record(key("c", "fr", "ctx"), "3");
    store.record(key("d", "fr", "ctx"), "4"); // evicts a

    const revived = parse(serialize(store), { maxEntries: 3 });
    expect(revived.refused).toEqual([]);
    expect(revived.store.size()).toBe(3);
    expect(revived.store.lookup(key("a", "fr", "ctx"))).toBeUndefined();
    expect(revived.store.lookup(key("d", "fr", "ctx"))).toBe("4");
  });

  it("re-derives tier-2 aliases on parse — they are not serialized state", () => {
    const store = createTmStore({ normalizeWhitespace: true });
    store.record(key("alpha beta", "fr", "ctx"), "v");
    const revived = parse(serialize(store), { normalizeWhitespace: true });
    expect(revived.refused).toEqual([]);
    expect(revived.store.lookup(key("alpha  beta", "fr", "ctx"))).toBe("v");
  });

  it("trims a document larger than the cap to its newest entries, without refusals", () => {
    const store = createTmStore();
    store.record(key("a", "fr", "ctx"), "1");
    store.record(key("b", "fr", "ctx"), "2");
    store.record(key("c", "fr", "ctx"), "3");
    const revived = parse(serialize(store), { maxEntries: 2 });
    expect(revived.refused).toEqual([]); // trimming is eviction, not refusal
    expect(revived.store.size()).toBe(2);
    expect(revived.store.lookup(key("a", "fr", "ctx"))).toBeUndefined();
    expect(revived.store.lookup(key("c", "fr", "ctx"))).toBe("3");
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
  /** One entry as valid serialized TM. */
  function tmText() {
    const store = createTmStore();
    store.record(buildTmKey({ sourceHash: "abc", targetLang: "vi", policyContext: "p" }), "base");
    return serialize(store);
  }

  it("pins the TM path", () => {
    expect(TM_PATH).toBe(".github/action-agents/harmonise/tm.json");
  });

  it("reads the branch tip first and reports origin 'branch'", async () => {
    const refs = /** @type {string[]} */ ([]);
    const reader = contentsReader(
      { [BRANCH]: { [TM_PATH]: tmText() }, [DEFAULT]: { [TM_PATH]: "stale" } },
      { onCall: (_path, ref) => refs.push(ref ?? "") },
    );
    const result = await readTm({
      getContents: reader,
      branch: BRANCH,
      defaultBranch: DEFAULT,
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
      { [DEFAULT]: { [TM_PATH]: tmText() } },
      { onCall: (_path, ref) => refs.push(ref ?? "") },
    );
    const result = await readTm({
      getContents: reader,
      branch: BRANCH,
      defaultBranch: DEFAULT,
    });
    expect(result).not.toBeNull();
    expect(result?.origin).toBe("default");
    expect(
      result?.store.lookup(buildTmKey({ sourceHash: "abc", targetLang: "vi", policyContext: "p" })),
    ).toBe("base");
    expect(refs).toEqual([BRANCH, DEFAULT]);
  });

  it("returns null when no branch carries the file", async () => {
    const reader = contentsReader({});
    const result = await readTm({
      getContents: reader,
      branch: BRANCH,
      defaultBranch: DEFAULT,
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
      readTm({ getContents: failing, branch: BRANCH, defaultBranch: DEFAULT }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("degrades corrupt TM on the branch to an empty store — no default substitution", async () => {
    const refs = /** @type {string[]} */ ([]);
    const reader = contentsReader(
      { [BRANCH]: { [TM_PATH]: "{not json" }, [DEFAULT]: { [TM_PATH]: tmText() } },
      { onCall: (_path, ref) => refs.push(ref ?? "") },
    );
    const result = await readTm({
      getContents: reader,
      branch: BRANCH,
      defaultBranch: DEFAULT,
    });
    expect(result).not.toBeNull();
    expect(result?.origin).toBe("branch");
    expect(result?.store.size()).toBe(0);
    expect(refs).toEqual([BRANCH]);
  });

  it("degrades corrupt TM on the default branch to an empty store", async () => {
    const reader = contentsReader({
      [DEFAULT]: { [TM_PATH]: "[]" },
    });
    const result = await readTm({
      getContents: reader,
      branch: BRANCH,
      defaultBranch: DEFAULT,
    });
    expect(result).not.toBeNull();
    expect(result?.origin).toBe("default");
    expect(result?.store.size()).toBe(0);
  });
});
