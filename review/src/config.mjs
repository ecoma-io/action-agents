/**
 * `review`'s config file — the schema and its validation. Everything here is
 * `review`'s own domain: `core/` never learns a key's name, and no other
 * action imports this reader.
 *
 * The mechanism — where the file lives, the default branch it is read from,
 * the dual-declaration refusal, the byte caps — is shared with the other
 * actions by being the same shape, not by being shared code. What the keys
 * mean lives here: strictness is a rendering dial the model never controls,
 * `ignore` defines what does not exist for the run, `maxDiffLines` bounds
 * the diff accounting, and `rules` name path-scoped rubrics whose documents
 * must exist on the default branch — declaring a rule and leaving its file
 * absent is a startup error, while a rule matching nothing in one pull
 * request is dormancy, not an error.
 *
 * All validation happens at startup, before the model is called. A config
 * that does not validate is a red run, not a best effort.
 */

import { json5Parse } from "#core/json5-parse.mjs";

/**
 * The operations the config loaders need — a slice of the forge client, so
 * a test doubles only the reading half.
 *
 * @typedef {{ getContents: (path: string) => Promise<{ content: string } | null> }} ContentsReader
 */

/**
 * @typedef {"low" | "medium" | "high"} Strictness
 */

/**
 * @typedef {"standard" | "adversarial"} Strategy
 */

/**
 * @typedef {object} ReviewRule
 * @property {string[]} include globs over repository-relative paths, `!` negates within the list
 * @property {string} instruction the rule document's path on the default branch
 */

/**
 * @typedef {object} ReviewConfig
 * @property {Strictness} strictness
 * @property {Strategy} strategy
 * @property {string} language a BCP-47 tag shaping prose, never the contract
 * @property {string[]} ignore the universe filter, glob dialect
 * @property {number} maxDiffLines counted additions plus deletions, never asked of a model
 * @property {ReviewRule[]} rules
 * @property {string} instructionPath the custom rubric's configured-or-convention path
 */

/** A config file larger than this is a red refusal, not a truncated policy. */
export const MAX_CONFIG_BYTES = 64 * 2 ** 10;

/** An instruction or rule document larger than this is a red refusal — prose cut mid-sentence misleads. */
export const MAX_DOCUMENT_BYTES = 8 * 2 ** 10;

const DEFAULT_LOCATIONS = [
  ".github/action-agents/review/review.json5",
  ".github/action-agents/review/review.json",
];

const CONVENTION_INSTRUCTION_PATH = ".github/action-agents/review/instruction.md";

const STRICTNESS = /** @type {const} */ (["low", "medium", "high"]);

const STRATEGY = /** @type {const} */ (["standard", "adversarial"]);

// Well-formed enough to be a tag; permissive where real tags vary. Language
// shapes reviewer prose only — severity, paths, lines and schema never move.
// Grandfathered (`i-klingon`) and private-use (`x-private`) tags pass too:
// refusing them would make review unable to speak where BCP-47 itself
// allows, and prose language is not a security surface.
const LANGUAGE_TAG =
  /^([A-Za-z]{2,8}(-[A-Za-z0-9]+)*|i-[A-Za-z0-9]+(-[A-Za-z0-9]+)*|x-[A-Za-z0-9]+(-[A-Za-z0-9]+)*)$/;

/**
 * Reads the config file from the default branch and parses it.
 *
 * Absent default locations are the built-in defaults, not an error — unlike
 * `harmonise`, `review` has honest work to do with no file at all. A
 * configured `config-path` that is absent is a red refusal: a workflow
 * naming a file that does not exist has a bug.
 *
 * @param {object} input
 * @param {ContentsReader} input.forge
 * @param {string} input.configPath the `config-path` input, "" for the default locations
 * @returns {Promise<{ raw: Record<string, unknown> | null, path: string }>}
 */
export async function loadConfigFile({ forge, configPath }) {
  if (configPath !== "") {
    const file = await forge.getContents(configPath);
    if (file === null) {
      throw new Error(
        `config-path names '${configPath}', which does not exist on the default branch`,
      );
    }
    return { raw: parseFile(configPath, file.content), path: configPath };
  }

  /** @type {{ path: string, content: string }[]} */
  const found = [];
  for (const path of DEFAULT_LOCATIONS) {
    const file = await forge.getContents(path);
    if (file !== null) found.push({ path, content: file.content });
  }
  if (found.length === 2) {
    throw new Error(
      `the policy is declared twice — both ${DEFAULT_LOCATIONS[0]} and ${DEFAULT_LOCATIONS[1]} ` +
        `exist; remove one`,
    );
  }
  if (found.length === 0) return { raw: null, path: "" };
  const first = found[0];
  if (first === undefined) throw new Error("a config file was found and then lost");
  return { raw: parseFile(first.path, first.content), path: first.path };
}

/**
 * @param {string} path
 * @param {string} content
 * @returns {Record<string, unknown>}
 */
function parseFile(path, content) {
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > MAX_CONFIG_BYTES) {
    throw new Error(
      `'${path}' is ${String(bytes)} bytes, past the ${String(MAX_CONFIG_BYTES)}-byte cap — ` +
        `a policy that overflows is refused rather than truncated`,
    );
  }
  let parsed;
  try {
    parsed = json5Parse(content);
  } catch (cause) {
    const error = new Error(
      `'${path}' does not parse: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    error.cause = cause;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`'${path}' must hold an object`);
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Validates the parsed file into a `ReviewConfig`; `null` (no file anywhere)
 * validates into the built-in defaults. Unknown keys refuse — a typo'd
 * `strickness` must not quietly become medium.
 *
 * @param {Record<string, unknown> | null} raw
 * @returns {ReviewConfig}
 */
export function validateConfig(raw) {
  if (raw === null) {
    return {
      strictness: "medium",
      strategy: "standard",
      language: "en",
      ignore: [],
      maxDiffLines: 5000,
      rules: [],
      instructionPath: CONVENTION_INSTRUCTION_PATH,
    };
  }

  for (const key of Object.keys(raw)) {
    if (
      key !== "strictness" &&
      key !== "strategy" &&
      key !== "language" &&
      key !== "ignore" &&
      key !== "maxDiffLines" &&
      key !== "rules" &&
      key !== "instructions"
    ) {
      throw new Error(
        `unknown config key '${key}' — the file holds strictness, strategy, language, ` +
          `ignore, maxDiffLines, rules and instructions`,
      );
    }
  }

  // Absent keys fall back to the built-in defaults; keys that are PRESENT
  // must be valid — `null` is a present, invalid value, never a quiet
  // fallback.
  const strictnessValue = raw["strictness"] === undefined ? "medium" : raw["strictness"];
  if (
    typeof strictnessValue !== "string" ||
    !STRICTNESS.includes(/** @type {Strictness} */ (strictnessValue))
  ) {
    throw new Error(
      `strictness must be one of low, medium, high — got '${String(strictnessValue)}'`,
    );
  }
  const strictness = /** @type {Strictness} */ (strictnessValue);

  const strategyValue = raw["strategy"] === undefined ? "standard" : raw["strategy"];
  if (
    typeof strategyValue !== "string" ||
    !STRATEGY.includes(/** @type {Strategy} */ (strategyValue))
  ) {
    throw new Error(
      `strategy must be one of standard, adversarial — got '${String(strategyValue)}'`,
    );
  }
  const strategy = /** @type {Strategy} */ (strategyValue);

  const languageValue = raw["language"] === undefined ? "en" : raw["language"];
  if (typeof languageValue !== "string" || !LANGUAGE_TAG.test(languageValue)) {
    throw new Error(
      `language must be a BCP-47 tag like en or pt-BR — got '${String(languageValue)}'`,
    );
  }

  /** @type {string[]} */
  let ignore = [];
  if (raw["ignore"] !== undefined) {
    const patterns = raw["ignore"];
    if (!Array.isArray(patterns)) throw new Error("ignore must be an array of glob patterns");
    for (const pattern of patterns) {
      if (typeof pattern !== "string" || pattern === "") {
        throw new Error("every ignore entry must be a non-empty glob pattern");
      }
    }
    ignore = /** @type {string[]} */ (patterns);
  }

  const maxDiffLinesValue = raw["maxDiffLines"] === undefined ? 5000 : raw["maxDiffLines"];
  if (
    typeof maxDiffLinesValue !== "number" ||
    !Number.isInteger(maxDiffLinesValue) ||
    maxDiffLinesValue < 1
  ) {
    throw new Error(
      `maxDiffLines must be a whole number of at least 1 — got '${String(maxDiffLinesValue)}'`,
    );
  }

  /** @type {ReviewRule[]} */
  const rules = [];
  if (raw["rules"] !== undefined) {
    const declared = raw["rules"];
    if (!Array.isArray(declared)) throw new Error("rules must be an array");
    for (const [index, entry] of declared.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`rules[${String(index)}] must be an object with include and instruction`);
      }
      const record = /** @type {Record<string, unknown>} */ (entry);
      for (const key of Object.keys(record)) {
        if (key !== "include" && key !== "instruction") {
          throw new Error(`rules[${String(index)}] holds unknown key '${key}'`);
        }
      }
      const include = record["include"];
      if (!Array.isArray(include) || include.length === 0) {
        throw new Error(`rules[${String(index)}].include must be a non-empty array of globs`);
      }
      for (const pattern of include) {
        if (typeof pattern !== "string" || (pattern !== "!" && pattern.replace(/^!/, "") === "")) {
          throw new Error(`rules[${String(index)}].include holds an empty glob pattern`);
        }
      }
      const instruction = record["instruction"];
      if (typeof instruction !== "string" || instruction === "") {
        throw new Error(`rules[${String(index)}].instruction must be a document path`);
      }
      rules.push({
        include: /** @type {string[]} */ (include),
        instruction,
      });
    }
  }

  let instructionPath = CONVENTION_INSTRUCTION_PATH;
  if (raw["instructions"] !== undefined) {
    const instructions = raw["instructions"];
    if (typeof instructions !== "object" || instructions === null || Array.isArray(instructions)) {
      throw new Error("instructions must be an object");
    }
    const record = /** @type {Record<string, unknown>} */ (instructions);
    for (const key of Object.keys(record)) {
      if (key !== "instruction") throw new Error(`unknown instructions key '${key}'`);
    }
    if (record["instruction"] !== undefined) {
      const value = record["instruction"];
      if (typeof value !== "string" || value === "") {
        throw new Error("instructions.instruction must be a document path");
      }
      instructionPath = value;
    }
  }

  return {
    strictness,
    strategy,
    language: languageValue,
    ignore,
    maxDiffLines: maxDiffLinesValue,
    rules,
    instructionPath,
  };
}

/**
 * Reads every document the config names, from the default branch. Rule
 * documents are required — a declared rule with no file is a startup error,
 * whatever this pull request changes — and the custom rubric is optional at
 * its configured-or-convention path.
 *
 * @param {object} input
 * @param {ContentsReader} input.forge
 * @param {ReviewConfig} input.config
 * @returns {Promise<{ instruction?: string, ruleDocuments: Map<string, string> }>}
 */
export async function loadDocuments({ forge, config }) {
  /** @type {Map<string, string>} */
  const ruleDocuments = new Map();
  for (const rule of config.rules) {
    if (ruleDocuments.has(rule.instruction)) continue;
    const text = await readDocument(forge, rule.instruction, true);
    if (text === undefined) {
      throw new Error("a required rule document was read and then lost");
    }
    ruleDocuments.set(rule.instruction, text);
  }

  /** @type {{ instruction?: string }} */
  const loaded = {};
  const custom = await readDocument(forge, config.instructionPath, false);
  if (custom !== undefined) loaded.instruction = custom;

  return { ...loaded, ruleDocuments };
}

/**
 * @param {ContentsReader} forge
 * @param {string} path
 * @param {boolean} required
 * @returns {Promise<string | undefined>}
 */
async function readDocument(forge, path, required) {
  const file = await forge.getContents(path);
  if (file === null) {
    if (required) {
      throw new Error(
        `the rule document '${path}' does not exist on the default branch — declaring a ` +
          `rule and leaving its file absent is a startup error`,
      );
    }
    return undefined;
  }
  const bytes = new TextEncoder().encode(file.content).byteLength;
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new Error(
      `'${path}' is ${String(bytes)} bytes, past the ${String(MAX_DOCUMENT_BYTES)}-byte cap — ` +
        `an instruction document that overflows is refused rather than truncated`,
    );
  }
  return file.content;
}
