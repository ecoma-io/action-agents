// Tests for `harmonise`'s config reader.
//
// What is pinned: an absent map refuses (unlike triage's policy-empty case —
// no map means nothing to keep in step); validation is complete at startup;
// and the shape a run later relies on — source inside languages, at least one
// target, patterns carrying exactly one `{document}` — cannot be half-right.

import { describe, expect, it } from "vitest";

import { loadConfigFile, validateConfig } from "./config.mjs";

/** @param {Record<string, string | null>} files @returns {import("./config.mjs").ContentsReader} */
function reader(files) {
  return {
    async getContents(path) {
      const content = files[path];
      return content === null || content === undefined ? null : { content };
    },
  };
}

const VALID = `{
  sourceLanguage: "en",
  languages: { en: "manual/{document}.md", vi: "manual/vi/{document}.md" },
}`;

describe("loadConfigFile", () => {
  it("reads a default-location json5 file", async () => {
    const { raw, path } = await loadConfigFile({
      forge: reader({ ".github/action-agents/harmonise/harmonise.json5": VALID }),
      configPath: "",
    });

    expect(path).toBe(".github/action-agents/harmonise/harmonise.json5");
    expect(raw["sourceLanguage"]).toBe("en");
  });

  it("reads the .json twin when only it exists", async () => {
    const { path } = await loadConfigFile({
      forge: reader({ ".github/action-agents/harmonise/harmonise.json": VALID }),
      configPath: "",
    });

    expect(path).toBe(".github/action-agents/harmonise/harmonise.json");
  });

  it("refuses when both default locations exist — a twice-declared policy is not reconciled", async () => {
    await expect(
      loadConfigFile({
        forge: reader({
          ".github/action-agents/harmonise/harmonise.json5": VALID,
          ".github/action-agents/harmonise/harmonise.json": VALID,
        }),
        configPath: "",
      }),
    ).rejects.toThrow(/declared twice/);
  });

  it("refuses when no location exists — harmonise has no policy-empty mode", async () => {
    await expect(loadConfigFile({ forge: reader({}), configPath: "" })).rejects.toThrow(
      /no config file exists/,
    );
  });

  it("reads exactly the configured path when config-path is set, and refuses if absent", async () => {
    const forge = reader({ "custom/map.json": VALID });
    const loaded = await loadConfigFile({ forge, configPath: "custom/map.json" });
    expect(loaded.path).toBe("custom/map.json");

    await expect(
      loadConfigFile({ forge: reader({}), configPath: "custom/map.json" }),
    ).rejects.toThrow(/does not exist on the default branch/);
  });

  it("refuses a file that does not parse or holds a non-object", async () => {
    await expect(
      loadConfigFile({
        forge: reader({ ".github/action-agents/harmonise/harmonise.json5": "{nope" }),
        configPath: "",
      }),
    ).rejects.toThrow(/does not parse/);

    await expect(
      loadConfigFile({
        forge: reader({ ".github/action-agents/harmonise/harmonise.json5": "[1,2]" }),
        configPath: "",
      }),
    ).rejects.toThrow(/must hold an object/);
  });
});

describe("validateConfig", () => {
  /** @param {Record<string, unknown>} overrides @returns {Record<string, unknown>} */
  function config(overrides) {
    return {
      sourceLanguage: "en",
      languages: { en: "manual/{document}.md", vi: "manual/vi/{document}.md" },
      ...overrides,
    };
  }

  it("accepts the documented schema and parses each language pattern", () => {
    const validated = validateConfig(
      config({
        ignore: ["manual/changelog/**"],
        glossary: ["repository", "pull request"],
        instructions: {
          instruction: "a/instruction.md",
          "language-instructions": { vi: "a/vi.md" },
        },
      }),
    );

    expect(validated.sourceLanguage).toBe("en");
    expect(Object.keys(validated.languages)).toEqual(["en", "vi"]);
    expect(validated.languages["vi"]?.pathFromSlug("dev")).toBe("manual/vi/dev.md");
    expect(validated.ignore).toEqual(["manual/changelog/**"]);
    expect(validated.glossary).toEqual(["repository", "pull request"]);
    expect(validated.instructions.instruction).toBe("a/instruction.md");
    expect(validated.instructions.languages["vi"]).toBe("a/vi.md");
  });

  it("refuses an unknown key", () => {
    expect(() => validateConfig(config({ sheet: {} }))).toThrow(/unknown config key 'sheet'/);
  });

  it("refuses a source that languages does not declare", () => {
    expect(() => validateConfig(config({ sourceLanguage: "fr" }))).toThrow(
      /'fr' is not a key of languages/,
    );
  });

  it("refuses a map with no target language — green-on-nothing is not a state this action ships in", () => {
    expect(() => validateConfig(config({ languages: { en: "manual/{document}.md" } }))).toThrow(
      /at least one target language/,
    );
  });

  it("refuses a pattern without exactly one {document} placeholder", () => {
    expect(() =>
      validateConfig(config({ languages: { en: "manual/*.md", vi: "{document}" } })),
    ).toThrow(/languages\.'en'/);
    expect(() =>
      validateConfig(config({ languages: { en: "manual/{document}.md", vi: "manual/{doc}.md" } })),
    ).toThrow(/exactly once/);
    expect(() =>
      validateConfig(
        config({ languages: { en: "manual/{document}.md", vi: "{document}/{lang}.md" } }),
      ),
    ).toThrow(/second placeholder/);
  });

  it("refuses a malformed language tag", () => {
    expect(() =>
      validateConfig(
        config({ languages: { en: "manual/{document}.md", "not a lang": "{document}" } }),
      ),
    ).toThrow(/is not a language tag/);
  });

  it("refuses glossary entries that are empty or duplicated", () => {
    expect(() => validateConfig(config({ glossary: [""] }))).toThrow(/non-empty strings/);
    expect(() => validateConfig(config({ glossary: ["commit", "commit"] }))).toThrow(
      /names 'commit' twice/,
    );
  });

  it("refuses a sourceLanguage that only inherits into languages", () => {
    expect(() => validateConfig(config({ sourceLanguage: "__proto__" }))).toThrow(
      /is not a key of languages/,
    );
  });

  it("refuses glossary terms carrying control characters or line breaks", () => {
    expect(() => validateConfig(config({ glossary: ["ok", "bad\u0000term"] }))).toThrow(
      /control characters or line breaks/,
    );
    expect(() => validateConfig(config({ glossary: ["multi\nline"] }))).toThrow(
      /control characters or line breaks/,
    );
  });

  it("refuses instructions naming an undeclared language", () => {
    expect(() =>
      validateConfig(config({ instructions: { "language-instructions": { fr: "fr.md" } } })),
    ).toThrow(/names 'fr', which languages does not declare/);
  });

  it("refuses unknown instruction keys", () => {
    expect(() => validateConfig(config({ instructions: { style: "x" } }))).toThrow(
      /unknown instructions key 'style'/,
    );
  });
});
