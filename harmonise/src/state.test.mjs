// Tests for `harmonise` sync-state: deterministic render, strict parse, and
// the repository read.
//
// What is pinned: render output is byte-deterministic (sorted records, sorted
// keys, 2-space indent, trailing newline); parse is strict about schema
// (unknown keys, wrong types, duplicates, wrong schemaVersion, malformed JSON
// all refused) and normalizes record order on read; readState tries the
// suffixed path on the branch tip, then the default branch, and — only when
// no ref carries the suffixed file — the pre-#156 legacy path once. It
// treats absence as null, propagates non-404 errors, and degrades corrupt
// state to absent — advisory state never blocks a run.

import { describe, expect, it } from "vitest";

import {
  LEGACY_STATE_PATH,
  STATE_SCHEMA_VERSION,
  parseState,
  readState,
  renderState,
  statePath,
} from "./state.mjs";

/**
 * @param {Partial<import("./state.mjs").SyncStateRecord>} overrides
 * @returns {import("./state.mjs").SyncStateRecord}
 */
function record(overrides = {}) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    sourcePath: "manual/dev.md",
    destinationPath: "manual/vi/dev.md",
    language: "vi",
    sourceFingerprint: "a".repeat(64),
    translationFingerprint: "b".repeat(64),
    policyFingerprint: "c".repeat(64),
    transformationVersion: 1,
    ...overrides,
  };
}

/** @param {string[]} paths @returns {import("./state.mjs").SyncStateRecord[]} */
function recordsFor(paths) {
  return paths.map((destinationPath) =>
    record({ destinationPath, sourcePath: `src/${destinationPath}`, language: "vi" }),
  );
}

/**
 * A forge contents double: maps (path, ref) → text, mirroring
 * `forge.getContents` — absent is `null`, other failures throw. Returns the
 * bare function, the shape `readState` receives.
 *
 * @param {Record<string, Record<string, string | null>>} byRef ref → path → content
 * @param {{ onCall?: (path: string, ref?: string) => void }} [hooks]
 * @returns {import("./state.mjs").ContentsReader}
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

describe("constants", () => {
  it("pins the schema version and the advisory paths", () => {
    expect(STATE_SCHEMA_VERSION).toBe(1);
    expect(statePath("vi")).toBe(".github/action-agents/harmonise/state.vi.json");
    expect(LEGACY_STATE_PATH).toBe(".github/action-agents/harmonise/state.json");
  });
});

describe("renderState", () => {
  it("is byte-deterministic — same records, same bytes", () => {
    const first = renderState(recordsFor(["b.md", "a.md"]));
    const second = renderState(recordsFor(["b.md", "a.md"]));
    expect(first).toBe(second);
  });

  it("sorts records by destinationPath regardless of input order", () => {
    expect(renderState(recordsFor(["b.md", "a.md"]))).toBe(
      renderState(recordsFor(["a.md", "b.md"])),
    );
  });

  it("sorts keys at every depth and ends with a trailing newline", () => {
    const rendered = renderState([record()]);
    expect(rendered.endsWith("\n")).toBe(true);
    // Keys within a record appear in ascending order.
    const keyOrder = [...rendered.matchAll(/^ {6}"([a-zA-Z]+)":/gm)].map((m) => m[1]);
    expect(keyOrder.length).toBeGreaterThan(0);
    expect(keyOrder).toEqual([...keyOrder].sort());
    // 2-space indent: the wrapper's key sits at column 2, record braces at 4,
    // record keys at 6.
    expect(rendered).toMatch(/^ {2}"records": \[$/m);
    expect(rendered).toMatch(/^ {4}\{$/m);
  });

  it("roundtrips through parseState", () => {
    const records = recordsFor(["manual/vi/b.md", "manual/vi/a.md"]);
    const parsed = parseState(renderState(records));
    expect(parsed.records).toEqual(
      [...records].sort((a, b) => (a.destinationPath < b.destinationPath ? -1 : 1)),
    );
  });
});

describe("parseState", () => {
  it("accepts a well-formed file and normalizes record order on read", () => {
    const unordered = JSON.stringify({
      records: [
        { ...record({ destinationPath: "z.md" }) },
        { ...record({ destinationPath: "a.md" }) },
      ],
    });
    const parsed = parseState(unordered);
    expect(parsed.records.map((r) => r.destinationPath)).toEqual(["a.md", "z.md"]);
  });

  it("refuses malformed JSON", () => {
    expect(() => parseState("{not json")).toThrow(/malformed JSON/);
  });

  it("refuses a top-level array, a bare value, and null", () => {
    expect(() => parseState("[]")).toThrow(/must be a JSON object, got array/);
    expect(() => parseState("42")).toThrow(/must be a JSON object, got number/);
    expect(() => parseState("null")).toThrow(/must be a JSON object, got null/);
  });

  it("refuses an unknown top-level key", () => {
    const text = JSON.stringify({ records: [], schemaVersion: 1 });
    expect(() => parseState(text)).toThrow(/unknown top-level key 'schemaVersion'/);
  });

  it("refuses a file with no records key", () => {
    expect(() => parseState("{}")).toThrow(/missing the 'records' key/);
  });

  it("refuses a records value that is not an array", () => {
    expect(() => parseState(JSON.stringify({ records: {} }))).toThrow(
      /'records' must be an array, got object/,
    );
  });

  it("refuses a record that is not an object — number or array", () => {
    expect(() => parseState(JSON.stringify({ records: [42] }))).toThrow(
      /record\[0\] must be an object, got number/,
    );
    expect(() => parseState(JSON.stringify({ records: [[]] }))).toThrow(
      /record\[0\] must be an object, got array/,
    );
  });

  it("refuses an unknown key inside a record", () => {
    const text = JSON.stringify({ records: [{ ...record(), extra: true }] });
    expect(() => parseState(text)).toThrow(/record\[0\] has unknown key 'extra'/);
  });
  it("refuses a record missing a declared key", () => {
    const partial = record();
    // @ts-expect-error exercising the runtime refusal of a missing key
    delete partial.language;
    expect(() => parseState(JSON.stringify({ records: [partial] }))).toThrow(
      /record\[0\] is missing key 'language'/,
    );
  });

  it("refuses a wrong-typed field", () => {
    /** @type {[string, unknown][]} */
    const cases = [
      ["schemaVersion", "1"],
      ["transformationVersion", "1"],
      ["sourcePath", 42],
      ["destinationPath", 42],
      ["language", 42],
      ["sourceFingerprint", 42],
      ["translationFingerprint", null],
      ["policyFingerprint", {}],
    ];
    for (const [field, value] of cases) {
      const text = JSON.stringify({ records: [{ ...record(), [field]: value }] });
      expect(() => parseState(text)).toThrow(new RegExp(`'${String(field)}' must be a`));
    }
  });

  it("refuses a schemaVersion other than STATE_SCHEMA_VERSION", () => {
    for (const wrong of [0, 2, 99]) {
      const text = JSON.stringify({ records: [record({ schemaVersion: wrong })] });
      expect(() => parseState(text)).toThrow(
        new RegExp(`'schemaVersion' is ${String(wrong)}, expected 1`),
      );
    }
  });

  it("refuses duplicate destinationPath", () => {
    const text = JSON.stringify({
      records: [record(), record({ sourcePath: "other.md" })],
    });
    expect(() => parseState(text)).toThrow(/duplicate destinationPath 'manual\/vi\/dev\.md'/);
  });
});

describe("readState", () => {
  const BRANCH = "harmonise/en";
  const DEFAULT = "main";
  const LANG = "en";
  const PATH = statePath(LANG);
  const VALID = JSON.stringify({ records: [record()] });

  it("reads the branch tip first and reports origin 'branch'", async () => {
    /** @type {string[]} */
    const refs = [];
    const reader = contentsReader(
      { [BRANCH]: { [PATH]: VALID }, [DEFAULT]: { [PATH]: "stale" } },
      { onCall: (_path, ref) => refs.push(ref ?? "") },
    );
    const result = await readState({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).toEqual({ records: [record()], origin: "branch" });
    expect(refs).toEqual([BRANCH]);
  });

  it("falls back to the default branch when the branch has no state file", async () => {
    /** @type {string[]} */
    const refs = [];
    const reader = contentsReader(
      { [DEFAULT]: { [PATH]: VALID } },
      { onCall: (_path, ref) => refs.push(ref ?? "") },
    );
    const result = await readState({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).toEqual({ records: [record()], origin: "default" });
    expect(refs).toEqual([BRANCH, DEFAULT]);
  });

  it("falls back to the legacy path once when no ref carries the suffixed file", async () => {
    /** @type {string[]} */
    const reads = [];
    const reader = contentsReader(
      { [BRANCH]: { [LEGACY_STATE_PATH]: VALID } },
      { onCall: (path, ref) => reads.push(`${path}@${ref ?? ""}`) },
    );
    const result = await readState({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).toEqual({ records: [record()], origin: "branch" });
    // The ladder is exactly: suffixed branch, suffixed default, legacy
    // branch. The first suffixed publication ends the walk.
    expect(reads).toEqual([
      `${PATH}@${BRANCH}`,
      `${PATH}@${DEFAULT}`,
      `${LEGACY_STATE_PATH}@${BRANCH}`,
    ]);
  });

  it("prefers the suffixed file on the default branch over the legacy file on the branch", async () => {
    /** @type {string[]} */
    const reads = [];
    const reader = contentsReader(
      {
        [BRANCH]: { [LEGACY_STATE_PATH]: "stale" },
        [DEFAULT]: { [PATH]: VALID },
      },
      { onCall: (path, ref) => reads.push(`${path}@${ref ?? ""}`) },
    );
    const result = await readState({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).toEqual({ records: [record()], origin: "default" });
    // A suffixed file anywhere ends the fallback — the legacy copy of a
    // pre-#156 publication is never read again.
    expect(reads).toEqual([`${PATH}@${BRANCH}`, `${PATH}@${DEFAULT}`]);
  });

  it("returns null when no branch carries the file", async () => {
    const reader = contentsReader({});
    const result = await readState({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).toBeNull();
  });

  it("propagates a non-404 error from the forge layer", async () => {
    const base = contentsReader({});
    /**
     * @param {string} path
     * @param {{ ref?: string }} [options]
     * @returns {Promise<{ content: string } | null>}
     */
    const failing = async (path, options = {}) => {
      if (options?.ref === BRANCH) {
        throw new Error("HTTP 500: the forge is on fire");
      }
      return base(path, options);
    };
    await expect(
      readState({
        getContents: failing,
        branchRef: BRANCH,
        defaultRef: DEFAULT,
        sourceLanguage: LANG,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("degrades corrupt state on the branch to null — advisory state never blocks a run", async () => {
    /** @type {string[]} */
    const reads = [];
    const reader = contentsReader(
      {
        [BRANCH]: { [PATH]: "{not json" },
        [DEFAULT]: { [LEGACY_STATE_PATH]: VALID },
      },
      { onCall: (path, ref) => reads.push(`${path}@${ref ?? ""}`) },
    );
    const result = await readState({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).toBeNull();
    // Corruption is final for the ref that owns the file: the legacy copy
    // is never consulted to replace it.
    expect(reads).toEqual([`${PATH}@${BRANCH}`]);
  });

  it("degrades corrupt state on the default branch to null", async () => {
    const reader = contentsReader({
      [DEFAULT]: { [PATH]: "[]" },
    });
    const result = await readState({
      getContents: reader,
      branchRef: BRANCH,
      defaultRef: DEFAULT,
      sourceLanguage: LANG,
    });
    expect(result).toBeNull();
  });
});
