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
  migrateConfig,
  validateConfig,
} from "./config.mjs";
import { matchLabels } from "./answer.mjs";

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

/** The resolved policy source every loadConfigFile test resolves against. */
/** @type {import("#core/policy.mjs").PolicySource} */
const SOURCE = { basis: "default", branch: "main", sha: "5".repeat(40) };

describe("loadConfigFile", () => {
  it("reads the .json5 location from the default branch", async () => {
    const forge = fakeForge({ [JSON5_PATH]: { content: "{ labels: {} }" } });
    const { raw, path } = await loadConfigFile({ forge, configPath: "", source: SOURCE });
    expect(path).toBe(JSON5_PATH);
    expect(raw).toEqual({ labels: {} });
  });

  it("falls back to .json when .json5 is absent — JSON is the boring case of JSON5", async () => {
    const forge = fakeForge({ [JSON_PATH]: { content: '{"labels":{}}' } });
    const { path } = await loadConfigFile({ forge, configPath: "", source: SOURCE });
    expect(path).toBe(JSON_PATH);
  });

  it("refuses a repository that has declared its policy twice", async () => {
    const forge = fakeForge({
      [JSON5_PATH]: { content: "{}" },
      [JSON_PATH]: { content: "{}" },
    });
    await expect(loadConfigFile({ forge, configPath: "", source: SOURCE })).rejects.toThrow(
      /declared twice/,
    );
  });

  it("treats neither present as policy-empty", async () => {
    const { raw, path } = await loadConfigFile({
      forge: fakeForge({}),
      configPath: "",
      source: SOURCE,
    });
    expect(raw).toBeNull();
    expect(path).toBe("");
  });

  it("reads only the configured path, and refuses one that is absent", async () => {
    const forge = fakeForge({
      [JSON5_PATH]: { content: "{}" },
      "elsewhere/policy.json5": { content: "{}" },
    });
    const { path } = await loadConfigFile({
      forge,
      configPath: "elsewhere/policy.json5",
      source: SOURCE,
    });
    expect(path).toBe("elsewhere/policy.json5");
    expect(forge.reads).toEqual(["elsewhere/policy.json5"]);

    await expect(
      loadConfigFile({ forge, configPath: "gone.json5", source: SOURCE }),
    ).rejects.toThrow(/does not exist on branch/);
  });

  it("refuses a malformed file with the parser's own position", async () => {
    const forge = fakeForge({ [JSON5_PATH]: { content: "{ labels: " } });
    await expect(loadConfigFile({ forge, configPath: "", source: SOURCE })).rejects.toThrow(
      /does not parse/,
    );
  });

  it("refuses a file past the 64 KiB cap rather than truncating it", async () => {
    const forge = fakeForge({ [JSON5_PATH]: { content: `// ${"x".repeat(70 * 2 ** 10)}` } });
    await expect(loadConfigFile({ forge, configPath: "", source: SOURCE })).rejects.toThrow(
      /past the/,
    );
  });

  it("accepts a file of exactly the 64 KiB cap — the boundary is inclusive", async () => {
    expect(MAX_CONFIG_BYTES).toBe(65536);
    const content = `{${" ".repeat(MAX_CONFIG_BYTES - 2)}}`;
    expect(new TextEncoder().encode(content).byteLength).toBe(MAX_CONFIG_BYTES);
    const forge = fakeForge({ [JSON5_PATH]: { content } });
    const { raw, path } = await loadConfigFile({ forge, configPath: "", source: SOURCE });
    expect(path).toBe(JSON5_PATH);
    expect(raw).toEqual({});
  });

  it("refuses a file of exactly one byte past the cap, naming the limit", async () => {
    expect(MAX_CONFIG_BYTES).toBe(65536);
    const content = `{${" ".repeat(MAX_CONFIG_BYTES - 1)}}`;
    expect(new TextEncoder().encode(content).byteLength).toBe(MAX_CONFIG_BYTES + 1);
    const forge = fakeForge({ [JSON5_PATH]: { content } });
    await expect(loadConfigFile({ forge, configPath: "", source: SOURCE })).rejects.toThrow(
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

  it("reads the v2 labels.use set — the policy's usable labels by name", () => {
    const config = validateConfig({
      labels: { use: ["bug", "docs", "breaking"] },
    });
    expect([...(config?.labels.use ?? [])]).toEqual(["bug", "docs", "breaking"]);
  });

  it("reads the role each use label carries", () => {
    const config = validateConfig({
      labels: {
        use: ["bug", "regression", "breaking"],
        roles: {
          bug: "semantic-classification",
          regression: "routing-area",
          breaking: "priority",
        },
      },
    });
    expect(config?.labels.roles.get("bug")).toBe("semantic-classification");
    expect(config?.labels.roles.get("regression")).toBe("routing-area");
    expect(config?.labels.roles.get("breaking")).toBe("priority");
  });

  it("refuses a label declared twice in use — refused, not reconciled", () => {
    expect(() => validateConfig({ labels: { use: ["bug", "bug"] } })).toThrow(/declared twice/);
  });

  it("refuses unknown top-level keys and malformed policy values, by name", () => {
    expect(() => validateConfig({ label: {} })).toThrow(/unknown config key 'label'/);
    expect(() => validateConfig({ labels: { use: 7 } })).toThrow(/labels.use must be an array/);
    expect(() => validateConfig({ labels: { roles: { bug: 7 } } })).toThrow(/labels.roles/);
    expect(() => validateConfig({ labels: { roles: { bug: "made-up-role" } } })).toThrow(
      /labels.roles/,
    );
    expect(() => validateConfig({ instructions: { "unknown-key": "x.md" } })).toThrow(
      /unknown instructions key/,
    );
    expect(() => validateConfig({ instructions: { instruction: "" } })).toThrow(/must be a path/);
  });

  it("refuses a role naming a label the policy does not use", () => {
    expect(() =>
      validateConfig({ labels: { use: ["bug"], roles: { ghost: "semantic-classification" } } }),
    ).toThrow(/labels.use does not declare/);
  });

  it("refuses an exclusive group no role carries — a group with no members is meaningless", () => {
    expect(() =>
      validateConfig({
        labels: {
          use: ["bug"],
          roles: { bug: "semantic-classification" },
          exclusive: ["routing-area"],
        },
      }),
    ).toThrow(/no labels.roles entry carries/);
  });

  it("refuses triageOwned naming a label the policy does not use", () => {
    expect(() => validateConfig({ labels: { use: ["bug"], triageOwned: ["size/xs"] } })).toThrow(
      /which labels.use does not declare/,
    );
  });

  it("keeps configured instruction paths for the loader to read", () => {
    const config = validateConfig({ instructions: { instruction: "docs/triage.md" } });
    expect(config?.instructions["instruction"]).toBe("docs/triage.md");
  });

  it("carries workflowMarkers through and holds the queue label in workflowMarkers", () => {
    const config = validateConfig({
      labels: { use: ["bug"], workflowMarkers: ["needs triage"] },
    });
    expect(config?.labels.workflowMarkers).toEqual(["needs triage"]);
  });

  it("accepts an empty priority mapping — the pieces are all optional policy", () => {
    const config = validateConfig({
      labels: { use: ["bug"], priority: {} },
    });
    expect([...(config?.labels.priority.keys() ?? [])]).toEqual([]);
  });

  it("refuses a workflowMarker that is also a classification label", () => {
    expect(() =>
      validateConfig({
        labels: {
          use: ["bug"],
          roles: { bug: "semantic-classification" },
          workflowMarkers: ["bug"],
        },
      }),
    ).toThrow(/also a classification label/);
  });
});
describe("validateConfig — issue evaluator keys", () => {
  it("derives a priority label from a severity-to-label priority mapping", () => {
    const config = validateConfig({
      labels: {
        use: ["high", "normal", "bug"],
        roles: { high: "priority", normal: "priority" },
        priority: { high: "high", normal: "normal" },
      },
    });
    expect(config?.labels.priority.get("high")).toBe("high");
    expect(config?.labels.priority.get("normal")).toBe("normal");
  });

  it("refuses a priority value that labels.use does not declare", () => {
    expect(() =>
      validateConfig({
        labels: { use: ["bug"], priority: { high: "urgent" } },
      }),
    ).toThrow(/labels.use does not declare/);
  });

  it("refuses a priority value that does not carry the priority role", () => {
    expect(() =>
      validateConfig({
        labels: { use: ["high"], priority: { high: "high" } },
      }),
    ).toThrow(/does not carry the priority role/);
  });

  it("carries an optional needsMoreInfo label through", () => {
    const config = validateConfig({
      labels: { use: ["needs more info"], needsMoreInfo: "needs more info" },
    });
    expect(config?.labels.needsMoreInfo).toBe("needs more info");
  });

  it("refuses a needsMoreInfo label that labels.use does not declare", () => {
    expect(() =>
      validateConfig({ labels: { use: ["bug"], needsMoreInfo: "needs more info" } }),
    ).toThrow(/labels.use does not declare/);
  });

  it("carries a routing map from form id to a routing-area label", () => {
    const config = validateConfig({
      labels: {
        use: ["bug", "core", "docs"],
        roles: { core: "routing-area", docs: "routing-area" },
        routing: { bug_report: "core", feature_request: "docs" },
      },
    });
    expect(config?.labels.routing).toEqual({ bug_report: "core", feature_request: "docs" });
  });

  it("refuses a routing value that does not carry the routing-area role", () => {
    expect(() =>
      validateConfig({
        labels: { use: ["core"], routing: { bug_report: "core" } },
      }),
    ).toThrow(/does not carry the routing-area role/);
  });
});

describe("migrateConfig — schema 1 to schema 2", () => {
  it("folds the v1 sheets into labels.use, drops the glosses, and moves the marker", () => {
    const { raw, migrated } = migrateConfig({
      labels: {
        universal: { bug: "Incorrect behaviour." },
        issues: { question: "Asking, not reporting." },
        pr: { breaking: "Consumers must act.", "size/xs": "" },
      },
      triageMarker: "needs triage",
    });
    expect(migrated).toBe(true);
    expect(raw).toEqual({
      labels: {
        use: ["bug", "question", "breaking", "size/xs"],
        roles: { bug: "semantic-classification" },
        workflowMarkers: ["needs triage"],
      },
    });
  });

  it("carries a v1 universal label as the semantic-classification role", () => {
    // Only `universal` was a category under schema 1; issues/pr labels were
    // not, so only universal names gain the classification role.
    const { raw } = migrateConfig(
      /** @type {any} */ ({
        labels: {
          universal: { bug: "a", docs: "b" },
          issues: { question: "c" },
          pr: { breaking: "d" },
        },
      }),
    );
    expect(raw.labels.roles).toEqual({
      bug: "semantic-classification",
      docs: "semantic-classification",
    });
  });

  it("union-deduplicates a name declared in two v1 sheets", () => {
    const { raw } = migrateConfig(
      /** @type {any} */ ({
        labels: { universal: { bug: "a" }, issues: { bug: "b" } },
      }),
    );
    expect(raw.labels.use).toEqual(["bug"]);
  });

  it("returns a v2 file untouched — migrateConfig is idempotent, so validate twice is safe", () => {
    const source = { labels: { use: ["bug"] } };
    const { raw, migrated } = migrateConfig(source);
    expect(migrated).toBe(false);
    expect(raw).toBe(source);
  });

  it("is a no-op for null and for a markerless v1 file with no sheets", () => {
    expect(migrateConfig(null).migrated).toBe(false);
    const empty = migrateConfig({ labels: {} });
    expect(empty.migrated).toBe(false);
    expect(empty.raw).toEqual({ labels: {} });
  });
});

describe("effectiveSheet", () => {
  const CONFIG = validateConfig({
    labels: {
      use: ["bug", "docs", "question", "breaking", "size/xs", "size/xl"],
      roles: {
        breaking: "semantic-classification",
        "size/xs": "priority",
      },
      workflowMarkers: ["needs triage"],
    },
    size: {
      ladder: [{ upTo: 10, label: "size/xs" }, { label: "size/xl" }],
    },
  });

  it("offers the whole use set to every thread, minus the size and marker labels", () => {
    const issue = effectiveSheet({ config: CONFIG, threadType: "issue", narrowing: [] });
    const pr = effectiveSheet({ config: CONFIG, threadType: "pr", narrowing: [] });
    // Schema 2 has no per-thread split: the policy's usable set is the same
    // whether the thread is an issue or a pull request.
    const expected = ["breaking", "bug", "docs", "question"];
    expect([...(issue.sheet?.keys() ?? [])].sort()).toEqual(expected);
    expect([...(pr.sheet?.keys() ?? [])].sort()).toEqual(expected);
  });

  it("never offers the needsMoreInfo label — it is added by code, not chosen", () => {
    const cfg = validateConfig({
      labels: { use: ["bug", "needs more info"], needsMoreInfo: "needs more info" },
    });
    const { sheet } = effectiveSheet({ config: cfg, threadType: "issue", narrowing: [] });
    expect(sheet?.has("needs more info")).toBe(false);
    expect(sheet?.has("bug")).toBe(true);
  });
  it("never offers a label GitHub describes a measurement or a queue reset by", () => {
    // size/xl is on the ladder and size/xs is on the ladder and carries the
    // priority role; 'needs triage' is a workflow marker. None reach a model.
    const { sheet } = effectiveSheet({ config: CONFIG, threadType: "pr", narrowing: [] });
    expect(sheet?.has("size/xs")).toBe(false);
    expect(sheet?.has("size/xl")).toBe(false);
    expect(sheet?.has("needs triage")).toBe(false);
    expect(sheet?.has("breaking")).toBe(true);
  });

  it("never offers a workflow marker declared in use (bug #230)", () => {
    // Schema validation requires a workflow marker to sit in labels.use; a
    // queue marker is cleared by code, never chosen — so once it is declared
    // in use it must still never reach the offered sheet.
    const cfg = validateConfig({
      labels: { use: ["bug", "docs", "needs triage"], workflowMarkers: ["needs triage"] },
    });
    const { sheet } = effectiveSheet({ config: cfg, threadType: "issue", narrowing: [] });
    expect(sheet?.has("needs triage")).toBe(false);
    expect(sheet?.has("bug")).toBe(true);
    expect(sheet?.has("docs")).toBe(true);
  });

  it("never offers a triage-owned label declared in use but off the ladder (bug #230)", () => {
    // A triage-owned label belongs to the action to derive or replace; the
    // model must never pick it, even when it is in use and not on the size
    // ladder (so the ladder alone would not have kept it off the sheet).
    const cfg = validateConfig({
      labels: {
        use: ["bug", "docs", "priority:high"],
        roles: { "priority:high": "priority" },
        triageOwned: ["priority:high"],
      },
    });
    const { sheet } = effectiveSheet({ config: cfg, threadType: "issue", narrowing: [] });
    expect(sheet?.has("priority:high")).toBe(false);
    expect(sheet?.has("bug")).toBe(true);
    expect(sheet?.has("docs")).toBe(true);
  });

  it("keeps a model from selecting a workflow marker or triage-owned label — not offered, so refused", () => {
    const cfg = validateConfig({
      labels: {
        use: ["bug", "docs", "needs triage", "priority:high"],
        roles: { "priority:high": "priority" },
        workflowMarkers: ["needs triage"],
        triageOwned: ["priority:high"],
      },
    });
    const { sheet } = effectiveSheet({ config: cfg, threadType: "issue", narrowing: [] });
    const sheetMap = /** @type {Map<string, string>} */ (sheet);
    // Exactly the classification labels are offered; the marker and the
    // owned label are not, so a model answer naming either fails closed
    // (matchLabels refuses it against this sheet).
    expect([...sheetMap.keys()].sort()).toEqual(["bug", "docs"]);
    const { accepted, refused } = matchLabels(["needs triage", "priority:high", "bug"], sheetMap);
    expect(accepted).toEqual(["bug"]);
    expect(refused.sort()).toEqual(["needs triage", "priority:high"]);
  });

  it("glosses a label with GitHub's own description — a label with none is offered by name", () => {
    const metadata = new Map([
      ["bug", { name: "bug", description: "Incorrect behaviour.", color: "d73a4a" }],
      ["docs", { name: "docs", description: "", color: "" }],
      ["question", { name: "question", description: "Asking, not reporting.", color: "" }],
      ["breaking", { name: "breaking", description: "", color: "" }],
    ]);
    const { sheet } = effectiveSheet({
      config: CONFIG,
      threadType: "issue",
      narrowing: [],
      metadata,
    });
    expect(sheet?.get("bug")).toBe("Incorrect behaviour.");
    expect(sheet?.get("docs")).toBe("docs");
    expect(sheet?.get("question")).toBe("Asking, not reporting.");
  });

  it("falls back to the label name when no metadata is supplied", () => {
    const { sheet } = effectiveSheet({ config: CONFIG, threadType: "issue", narrowing: [] });
    expect(sheet?.get("bug")).toBe("bug");
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

  it("refuses narrowing to a declared label the sheet never offers", () => {
    // `size/xs` sits in `use` and is therefore declared, but it is a size
    // rung with the priority role — never offered to the model. Before the
    // declared-but-never-offered gate this narrowed the sheet to nothing with
    // a generic message; the gate names the entry instead.
    expect(() =>
      effectiveSheet({ config: CONFIG, threadType: "pr", narrowing: ["size/xs"] }),
    ).toThrow(/'size\/xs', which the config file declares but never offers/);
  });

  it("refuses narrowing that mixes an offered label with one the sheet never offers", () => {
    // A partial honour would be worse than a refusal: the run would proceed
    // with fewer labels than the workflow named, and nothing in the log would
    // say so.
    expect(() =>
      effectiveSheet({ config: CONFIG, threadType: "issue", narrowing: ["bug", "size/xl"] }),
    ).toThrow(/'size\/xl', which the config file declares but never offers/);
  });

  it("treats a file that declares no usable labels as no sheet", () => {
    const empty = validateConfig({ instructions: {} });
    const { sheet } = effectiveSheet({ config: empty, threadType: "issue", narrowing: [] });
    expect(sheet).toBeNull();
  });
});
