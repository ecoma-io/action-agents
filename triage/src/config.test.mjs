// Tests for the config file: discovery, validation, the effective sheet, and instruction loading.
//
// The law with teeth here is narrowing — a workflow's `labels:` input
// selects a subset of what the file declares, an undeclared name is refused
// with both names in the message, and nothing widens the sheet, ever. The
// discovery rules (both files present is an error, neither is fine, a
// configured path that is absent is an error) are the configuration page's
// and are pinned against a fake forge, path by path.

import { describe, expect, it } from "vitest";

import {
  MAX_CONFIG_BYTES,
  effectiveSheet,
  loadConfigFile,
  loadInstructions,
  validateConfig,
} from "./config.mjs";

/** @typedef {Record<string, { content: string } | null>} Files */

/**
 * A forge that answers `getContents` from a table: a path maps to its
 * content, or to null for absent. Every read is recorded.
 *
 * @param {Files} files
 */
function fakeForge(files) {
  /** @type {string[]} */
  const reads = [];
  return {
    reads,
    /** @param {string} path */
    async getContents(path) {
      reads.push(path);
      const file = files[path];
      if (file === null) return null;
      return file === undefined ? null : { content: file.content };
    },
  };
}

const JSON5_PATH = ".github/action-agents/triage/triage.json5";
const JSON_PATH = ".github/action-agents/triage/triage.json";

describe("loadConfigFile", () => {
  it("reads the .json5 location from the default branch", async () => {
    const forge = fakeForge({ [JSON5_PATH]: { content: "{ labels: {} }" } });
    const { raw, path } = await loadConfigFile({ forge, configPath: "" });
    expect(path).toBe(JSON5_PATH);
    expect(raw).toEqual({ labels: {} });
  });

  it("falls back to .json when .json5 is absent — JSON is the boring case of JSON5", async () => {
    const forge = fakeForge({ [JSON_PATH]: { content: '{"labels":{}}' } });
    const { path } = await loadConfigFile({ forge, configPath: "" });
    expect(path).toBe(JSON_PATH);
  });

  it("refuses a repository that has declared its policy twice", async () => {
    const forge = fakeForge({
      [JSON5_PATH]: { content: "{}" },
      [JSON_PATH]: { content: "{}" },
    });
    await expect(loadConfigFile({ forge, configPath: "" })).rejects.toThrow(/declared twice/);
  });

  it("treats neither present as policy-empty", async () => {
    const { raw, path } = await loadConfigFile({ forge: fakeForge({}), configPath: "" });
    expect(raw).toBeNull();
    expect(path).toBe("");
  });

  it("reads only the configured path, and refuses one that is absent", async () => {
    const forge = fakeForge({
      [JSON5_PATH]: { content: "{}" },
      "elsewhere/policy.json5": { content: "{}" },
    });
    const { path } = await loadConfigFile({ forge, configPath: "elsewhere/policy.json5" });
    expect(path).toBe("elsewhere/policy.json5");
    expect(forge.reads).toEqual(["elsewhere/policy.json5"]);

    await expect(loadConfigFile({ forge, configPath: "gone.json5" })).rejects.toThrow(
      /does not exist on the default branch/,
    );
  });

  it("refuses a malformed file with the parser's own position", async () => {
    const forge = fakeForge({ [JSON5_PATH]: { content: "{ labels: " } });
    await expect(loadConfigFile({ forge, configPath: "" })).rejects.toThrow(/does not parse/);
  });

  it("refuses a file past the 64 KiB cap rather than truncating it", async () => {
    const forge = fakeForge({ [JSON5_PATH]: { content: `// ${"x".repeat(70 * 2 ** 10)}` } });
    await expect(loadConfigFile({ forge, configPath: "" })).rejects.toThrow(/past the/);
  });

  it("accepts a file of exactly the 64 KiB cap — the boundary is inclusive", async () => {
    expect(MAX_CONFIG_BYTES).toBe(65536);
    const content = `{${" ".repeat(MAX_CONFIG_BYTES - 2)}}`;
    expect(new TextEncoder().encode(content).byteLength).toBe(MAX_CONFIG_BYTES);
    const forge = fakeForge({ [JSON5_PATH]: { content } });
    const { raw, path } = await loadConfigFile({ forge, configPath: "" });
    expect(path).toBe(JSON5_PATH);
    expect(raw).toEqual({});
  });

  it("refuses a file of exactly one byte past the cap, naming the limit", async () => {
    expect(MAX_CONFIG_BYTES).toBe(65536);
    const content = `{${" ".repeat(MAX_CONFIG_BYTES - 1)}}`;
    expect(new TextEncoder().encode(content).byteLength).toBe(MAX_CONFIG_BYTES + 1);
    const forge = fakeForge({ [JSON5_PATH]: { content } });
    await expect(loadConfigFile({ forge, configPath: "" })).rejects.toThrow(
      new RegExp(
        `is ${String(MAX_CONFIG_BYTES + 1)} bytes, past the ${String(MAX_CONFIG_BYTES)}-byte cap`,
      ),
    );
  });
});

describe("loadInstructions", () => {
  const INSTRUCTION = ".github/action-agents/triage/instruction.md";
  const ISSUE_INSTRUCTION = ".github/action-agents/triage/issue-instruction.md";
  const PR_INSTRUCTION = ".github/action-agents/triage/pr-instruction.md";

  it("resolves the default paths for the thread's type when the config declares none", async () => {
    const forge = fakeForge({
      [INSTRUCTION]: { content: "General guidance." },
      [ISSUE_INSTRUCTION]: { content: "Issue guidance." },
      [PR_INSTRUCTION]: { content: "PR guidance." },
    });

    const forIssue = await loadInstructions({ forge, config: null, threadType: "issue" });
    expect(forIssue).toEqual({
      instruction: "General guidance.",
      typeInstruction: "Issue guidance.",
    });

    const forPr = await loadInstructions({ forge, config: null, threadType: "pr" });
    expect(forPr).toEqual({
      instruction: "General guidance.",
      typeInstruction: "PR guidance.",
    });
    expect(forge.reads).toEqual([INSTRUCTION, ISSUE_INSTRUCTION, INSTRUCTION, PR_INSTRUCTION]);
  });

  it("configured keys select exactly those documents", async () => {
    const config = validateConfig({
      instructions: {
        instruction: "elsewhere/general.md",
        "issue-instruction": "elsewhere/issues.md",
      },
    });
    const forge = fakeForge({
      "elsewhere/general.md": { content: "Configured general." },
      "elsewhere/issues.md": { content: "Configured issues." },
      [INSTRUCTION]: { content: "Default general." },
      [ISSUE_INSTRUCTION]: { content: "Default issues." },
    });

    const documents = await loadInstructions({ forge, config, threadType: "issue" });
    expect(documents).toEqual({
      instruction: "Configured general.",
      typeInstruction: "Configured issues.",
    });
    // The defaults exist on the default branch and are never read.
    expect(forge.reads).toEqual(["elsewhere/general.md", "elsewhere/issues.md"]);
  });

  it("tolerates missing documents — nothing throws and nothing is returned", async () => {
    const forge = fakeForge({});
    const documents = await loadInstructions({ forge, config: null, threadType: "pr" });
    expect(documents).toEqual({});
  });

  it("carries only the documents that exist", async () => {
    const forge = fakeForge({ [INSTRUCTION]: { content: "General guidance." } });
    const documents = await loadInstructions({ forge, config: null, threadType: "issue" });
    expect(documents).toEqual({ instruction: "General guidance." });
  });

  it("accepts an instruction document of exactly 8192 bytes", async () => {
    const forge = fakeForge({ [INSTRUCTION]: { content: "x".repeat(8192) } });
    const documents = await loadInstructions({ forge, config: null, threadType: "pr" });
    expect(documents.instruction).toHaveLength(8192);
  });

  it("refuses 8193 bytes, naming the size and the cap", async () => {
    const forge = fakeForge({ [INSTRUCTION]: { content: "x".repeat(8193) } });
    await expect(loadInstructions({ forge, config: null, threadType: "issue" })).rejects.toThrow(
      /8193 bytes, past the 8192-byte cap/,
    );
  });

  it("measures UTF-8 bytes, not code points", async () => {
    // 4097 two-byte characters are 8194 bytes — past the cap at half its code-point length.
    const forge = fakeForge({ [INSTRUCTION]: { content: "é".repeat(4097) } });
    await expect(loadInstructions({ forge, config: null, threadType: "pr" })).rejects.toThrow(
      /8194 bytes, past the 8192-byte cap/,
    );
  });
});

describe("validateConfig", () => {
  it("returns null for the empty policy — no sheet, the classification becomes a comment", () => {
    expect(validateConfig(null)).toBeNull();
  });

  it("reads the three label maps with their glosses", () => {
    const config = validateConfig({
      labels: {
        universal: { bug: "Incorrect behaviour." },
        issues: { "good first issue": "Small." },
        pr: { breaking: "Consumers must act." },
      },
    });
    expect(config?.universal.get("bug")).toBe("Incorrect behaviour.");
    expect(config?.issues.get("good first issue")).toBe("Small.");
    expect(config?.pr.get("breaking")).toBe("Consumers must act.");
  });

  it("refuses a label declared in two maps — refused, not reconciled", () => {
    expect(() =>
      validateConfig({
        labels: { universal: { bug: "a" }, issues: { bug: "b" } },
      }),
    ).toThrow(/declared twice/);
  });

  it("refuses unknown keys and malformed values, by name", () => {
    expect(() => validateConfig({ label: {} })).toThrow(/unknown config key 'label'/);
    expect(() => validateConfig({ labels: { universal: { bug: 7 } } })).toThrow(/gloss/);
    expect(() => validateConfig({ instructions: { "unknown-key": "x.md" } })).toThrow(
      /unknown instructions key/,
    );
    expect(() => validateConfig({ instructions: { instruction: "" } })).toThrow(/must be a path/);
  });

  it("keeps configured instruction paths for the loader to read", () => {
    const config = validateConfig({ instructions: { instruction: "docs/triage.md" } });
    expect(config?.instructions["instruction"]).toBe("docs/triage.md");
  });

  it("carries a declared triageMarker through", () => {
    const config = validateConfig({
      labels: { universal: { bug: "Incorrect behaviour." } },
      triageMarker: "needs triage",
    });
    expect(config?.triageMarker).toBe("needs triage");
  });

  it("leaves triageMarker undefined when the config declares none", () => {
    const config = validateConfig({ labels: { universal: { bug: "Incorrect behaviour." } } });
    expect(config?.triageMarker).toBeUndefined();
  });

  it("refuses a triageMarker that is not a non-empty label name", () => {
    expect(() => validateConfig({ labels: { universal: { bug: "a" } }, triageMarker: "" })).toThrow(
      /triageMarker/,
    );
    expect(() => validateConfig({ labels: { universal: { bug: "a" } }, triageMarker: 7 })).toThrow(
      /triageMarker/,
    );
  });
});

describe("effectiveSheet", () => {
  const CONFIG = validateConfig({
    labels: {
      universal: { bug: "Incorrect behaviour.", docs: "Documentation only." },
      issues: { question: "Asking, not reporting." },
      pr: { breaking: "Consumers must act.", "size/xs": "", "size/xl": "" },
    },
    size: {
      ladder: [{ upTo: 10, label: "size/xs" }, { label: "size/xl" }],
    },
  });

  it("unions universal with the thread type's map", () => {
    const issue = effectiveSheet({ config: CONFIG, threadType: "issue", narrowing: [] });
    const pr = effectiveSheet({ config: CONFIG, threadType: "pr", narrowing: [] });
    expect([...(issue.sheet?.keys() ?? [])].sort()).toEqual(["bug", "docs", "question"]);
    expect([...(pr.sheet?.keys() ?? [])].sort()).toEqual(["breaking", "bug", "docs"]);
  });

  it("never offers the size labels, however they are configured", () => {
    // size/xs and size/xl are on the ladder above, so they are applied by
    // measurement and must not also be offered to the model.
    const { sheet } = effectiveSheet({ config: CONFIG, threadType: "pr", narrowing: [] });
    expect(sheet?.has("size/xs")).toBe(false);
    expect(sheet?.has("size/xl")).toBe(false);
    expect(sheet?.has("breaking")).toBe(true);
  });

  it("narrows to the workflow's subset, and refuses a name the file does not declare", () => {
    const narrowed = effectiveSheet({
      config: CONFIG,
      threadType: "issue",
      narrowing: ["question"],
    });
    expect([...(narrowed.sheet?.keys() ?? [])]).toEqual(["question"]);

    expect(() =>
      effectiveSheet({ config: CONFIG, threadType: "issue", narrowing: ["question", "nope"] }),
    ).toThrow(/'nope', which the config file does not declare/);
  });

  it("refuses a labels input with no sheet to narrow", () => {
    expect(() => effectiveSheet({ config: null, threadType: "issue", narrowing: ["bug"] })).toThrow(
      /no config file to narrow/,
    );
  });

  it("refuses narrowing that leaves nothing to offer", () => {
    expect(() =>
      effectiveSheet({ config: CONFIG, threadType: "pr", narrowing: ["size/xs"] }),
    ).toThrow(/effective sheet is empty/);
  });

  it("treats a file that declares no labels at all as no sheet", () => {
    const empty = validateConfig({ instructions: {} });
    const { sheet } = effectiveSheet({ config: empty, threadType: "issue", narrowing: [] });
    expect(sheet).toBeNull();
  });
});
