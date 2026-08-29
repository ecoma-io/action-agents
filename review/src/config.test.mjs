// Tests for review's config schema and document loading.
//
// The mechanics mirror the other actions' loaders (default locations, the
// dual-declaration refusal, byte caps) and are retested here because the
// failure contract is per-action: what is a red refusal for review, and
// what falls back to built-in defaults.

import { describe, expect, it } from "vitest";

import { json5Parse } from "#core/json5-parse.mjs";

import { loadConfigFile, loadDocuments, validateConfig } from "./config.mjs";

/**
 * @param {Record<string, string | null>} files path → content; null means absent
 * @returns {{ getContents: (path: string) => Promise<{ content: string } | null> }}
 */
function reader(files) {
  return {
    async getContents(path) {
      const content = files[path];
      if (content === undefined || content === null) return null;
      return { content };
    },
  };
}

/** The resolved policy source every loader test resolves against. */
/** @type {import("#core/policy.mjs").PolicySource} */
const SOURCE = { basis: "default", branch: "main", sha: "5".repeat(40) };

const FULL_CONFIG = `{
  strictness: "high",
  language: "pt-BR",
  ignore: ["dist/**", "!dist/keep/**"],
  maxDiffLines: 100,
  rules: [{ include: ["src/**/*.mjs"], instruction: ".github/rules/js.md" }],
  instructions: { instruction: ".github/rubric.md" },
}`;

describe("loadConfigFile", () => {
  it("reads an explicit config-path and refuses when absent", async () => {
    const present = await loadConfigFile({
      forge: reader({ "policies/review.json5": "{}" }),
      configPath: "policies/review.json5",
      source: SOURCE,
    });
    expect(present.raw).toEqual({});
    expect(present.path).toBe("policies/review.json5");

    await expect(
      loadConfigFile({ forge: reader({}), configPath: "nope.json5", source: SOURCE }),
    ).rejects.toThrow(/does not exist on branch/);
  });

  it("prefers .json5 over .json at the default location, refusing both", async () => {
    const json5 = await loadConfigFile({
      forge: reader({ ".github/action-agents/review/review.json5": "/* json5 flavor */ {}" }),
      configPath: "",
      source: SOURCE,
    });
    expect(json5.path).toContain(".json5");

    const both = loadConfigFile({
      forge: reader({
        ".github/action-agents/review/review.json5": "{}",
        ".github/action-agents/review/review.json": "{}",
      }),
      configPath: "",
      source: SOURCE,
    });
    await expect(both).rejects.toThrow(/declared twice/);
  });

  it("treats absent default locations as policy-empty", async () => {
    const none = await loadConfigFile({ forge: reader({}), configPath: "", source: SOURCE });
    expect(none.raw).toBeNull();
  });

  it("refuses a file past its byte cap or one that does not parse", async () => {
    await expect(
      loadConfigFile({
        forge: reader({ ".github/action-agents/review/review.json5": "x".repeat(65 * 1024) }),
        configPath: "",
        source: SOURCE,
      }),
    ).rejects.toThrow(/past the .*-byte cap/);

    await expect(
      loadConfigFile({
        forge: reader({ ".github/action-agents/review/review.json5": "{strictness:" }),
        configPath: "",
        source: SOURCE,
      }),
    ).rejects.toThrow(/does not parse/);
  });
});

describe("validateConfig", () => {
  it("validates the full schema", () => {
    const config = validateConfig(json5Parse(FULL_CONFIG));
    expect(config.strictness).toBe("high");
    expect(config.language).toBe("pt-BR");
    expect(config.ignore).toEqual(["dist/**", "!dist/keep/**"]);
    expect(config.maxDiffLines).toBe(100);
    expect(config.rules).toEqual([
      { include: ["src/**/*.mjs"], instruction: ".github/rules/js.md" },
    ]);
    expect(config.instructionPath).toBe(".github/rubric.md");
  });

  it("falls back to the built-in defaults with no file", () => {
    const config = validateConfig(null);
    expect(config).toEqual({
      strictness: "medium",
      strategy: "standard",
      language: "en",
      ignore: [],
      maxDiffLines: 5000,
      rules: [],
      instructionPath: ".github/action-agents/review/instruction.md",
    });
  });

  it("refuses unknown keys, bad strictness, bad language tags and non-positive budgets", () => {
    expect(() => validateConfig({ strickness: "low" })).toThrow(/unknown config key/);
    expect(() => validateConfig({ stratagy: "standard" })).toThrow(/unknown config key/);
    expect(() => validateConfig({ strictness: "extreme" })).toThrow(/one of low, medium, high/);
    expect(() => validateConfig({ language: "not a tag!" })).toThrow(/BCP-47/);
    expect(() => validateConfig({ maxDiffLines: 0 })).toThrow(/at least 1/);
    expect(() => validateConfig({ maxDiffLines: 1.5 })).toThrow(/whole number/);
  });

  it("accepts strategy and defaults it to standard when absent", () => {
    expect(validateConfig({}).strategy).toBe("standard");
    expect(validateConfig({ strategy: "standard" }).strategy).toBe("standard");
    expect(validateConfig({ strategy: "adversarial" }).strategy).toBe("adversarial");
    // A present-and-invalid strategy refuses exactly like strictness.
    expect(() => validateConfig({ strategy: "paranoid" })).toThrow(/one of standard, adversarial/);
    expect(() => validateConfig({ strategy: null })).toThrow(/one of standard, adversarial/);
  });

  it("defaults absent keys but refuses present-and-invalid ones", () => {
    const absent = validateConfig({});
    expect(absent.strictness).toBe("medium");
    expect(absent.language).toBe("en");
    expect(absent.maxDiffLines).toBe(5000);

    // null is a value, and a wrong one — never a quiet fallback.
    expect(() => validateConfig({ strictness: null })).toThrow(/one of low, medium, high/);
    expect(() => validateConfig({ language: null })).toThrow(/BCP-47/);
    expect(() => validateConfig({ maxDiffLines: null })).toThrow(/whole number/);
  });

  it("accepts the BCP-47 shapes real repositories use, including private-use tags", () => {
    expect(validateConfig({ language: "en-US-posix" }).language).toBe("en-US-posix");
    expect(validateConfig({ language: "de-CH-1901" }).language).toBe("de-CH-1901");
    expect(validateConfig({ language: "i-klingon" }).language).toBe("i-klingon");
    expect(validateConfig({ language: "x-private" }).language).toBe("x-private");
  });

  it("refuses malformed ignore lists and rules", () => {
    expect(() => validateConfig({ ignore: "dist" })).toThrow(/array of glob patterns/);
    expect(() => validateConfig({ ignore: [""] })).toThrow(/non-empty glob pattern/);
    expect(() => validateConfig({ rules: {} })).toThrow(/must be an array/);
    expect(() => validateConfig({ rules: [{}] })).toThrow(/include must be a non-empty array/);
    expect(() =>
      validateConfig({ rules: [{ include: ["a"], instruction: "", extra: 1 }] }),
    ).toThrow(/unknown key 'extra'/);
    expect(() => validateConfig({ rules: [{ include: ["a"], instruction: "" }] })).toThrow(
      /must be a document path/,
    );
    expect(() => validateConfig({ instructions: { wrong: "x" } })).toThrow(
      /unknown instructions key/,
    );
  });
});

describe("loadDocuments", () => {
  it("requires every declared rule's document and reads it once per path", async () => {
    const forge = reader({
      ".github/rules/a.md": "# Rule A",
      ".github/rules/b.md": "# Rule B",
    });
    const config = validateConfig({
      rules: [
        { include: ["a/**"], instruction: ".github/rules/a.md" },
        { include: ["b/**"], instruction: ".github/rules/b.md" },
        { include: ["a2/**"], instruction: ".github/rules/a.md" },
      ],
    });

    const documents = await loadDocuments({ forge, config, source: SOURCE });
    expect(documents.ruleDocuments.size).toBe(2);
    expect(documents.ruleDocuments.get(".github/rules/a.md")).toBe("# Rule A");
  });

  it("refuses when a rule's document is missing — startup error, not dormancy", async () => {
    const config = validateConfig({
      rules: [{ include: ["a/**"], instruction: ".github/rules/gone.md" }],
    });
    await expect(loadDocuments({ forge: reader({}), config, source: SOURCE })).rejects.toThrow(
      /does not exist on branch/,
    );
  });

  it("loads the custom rubric when present, tolerates its absence", async () => {
    const config = validateConfig({ instructions: { instruction: ".github/rubric.md" } });

    const withDoc = await loadDocuments({
      forge: reader({ ".github/rubric.md": "Be exact." }),
      config,
      source: SOURCE,
    });
    expect(withDoc.instruction).toBe("Be exact.");

    const without = await loadDocuments({ forge: reader({}), config, source: SOURCE });
    expect(without.instruction).toBeUndefined();
  });

  it("refuses any document past its byte cap", async () => {
    const config = validateConfig({
      rules: [{ include: ["a/**"], instruction: ".github/rules/big.md" }],
    });
    await expect(
      loadDocuments({
        forge: reader({ ".github/rules/big.md": "x".repeat(9 * 1024) }),
        config,
        source: SOURCE,
      }),
    ).rejects.toThrow(/byte cap/);
  });
});
