/**
 * `triage`'s config file — the schema, its validation, and the effective
 * sheet. Everything here is `triage`'s own domain: `core/` never learns a
 * key's name, and no other action imports this reader.
 *
 * The mechanism (where the file lives, the default branch, precedence) is
 * `docs/development/configuration.md`'s and is spoken through the protocol
 * primitives; what the keys mean lives here. The law that matters most is
 * narrowing: a `labels:` input selects a subset of what the file declares —
 * an entry the file does not declare is refused at startup with both names
 * in the message, and nothing widens the sheet, ever. With no file there is
 * no sheet at all: the classification becomes the marker comment, and a
 * `labels:` input with nothing to narrow is refused too.
 *
 * All validation happens at startup, before the model is called. A config
 * that does not validate is a red run, not a best effort.
 */

import { json5Parse } from "#core/json5-parse.mjs";

import { validateSizeConfig } from "./size.mjs";

/**
 * The operations the config loaders need — a slice of the forge client, so
 * a test doubles only the reading half.
 *
 * @typedef {{ getContents: (path: string) => Promise<{ content: string } | null> }} ContentsReader
 */

/**
 * @typedef {import("./size.mjs").SizeConfig} SizeConfig
 */

/**
 * @typedef {object} TriageConfig
 * @property {Map<string, string>} universal
 * @property {Map<string, string>} issues
 * @property {Map<string, string>} pr
 * @property {SizeConfig | undefined} size
 * @property {{ instruction?: string, "issue-instruction"?: string, "pr-instruction"?: string }} instructions configured instruction paths, before defaults
 */

/** A config file larger than this is a red refusal, not a truncated policy. */
export const MAX_CONFIG_BYTES = 64 * 2 ** 10;

/** An instruction document larger than this is a red refusal — prose cut mid-sentence misleads. */
export const MAX_INSTRUCTION_BYTES = 8 * 2 ** 10;

const DEFAULT_LOCATIONS = [
  ".github/action-agents/triage.json5",
  ".github/action-agents/triage.json",
];

const DEFAULT_INSTRUCTION_PATHS = {
  instruction: ".github/action-agents/triage/instruction.md",
  "issue-instruction": ".github/action-agents/triage/issue-instruction.md",
  "pr-instruction": ".github/action-agents/triage/pr-instruction.md",
};

/**
 * Reads the config file from the default branch and parses it.
 *
 * Absent default locations are policy-empty; a configured `config-path`
 * that is absent is a red refusal — a workflow naming a file that does not
 * exist has a bug, and guessing `null` would silently run an empty policy.
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
 * Validates the parsed file into a `TriageConfig`. An empty policy stays
 * `null`: the action then runs with no sheet and writes its classification
 * as a comment.
 *
 * @param {Record<string, unknown> | null} raw
 * @returns {TriageConfig | null}
 */
export function validateConfig(raw) {
  if (raw === null) return null;

  for (const key of Object.keys(raw)) {
    if (key !== "labels" && key !== "size" && key !== "instructions") {
      throw new Error(`unknown config key '${key}' — the file holds labels, size and instructions`);
    }
  }

  /** @type {{ instruction?: string, "issue-instruction"?: string, "pr-instruction"?: string }} */
  const instructions = {};
  const config = { universal: new Map(), issues: new Map(), pr: new Map(), instructions };

  if (raw["labels"] !== undefined) {
    const labels = expectObject(raw["labels"], "labels");
    for (const kind of ["universal", "issues", "pr"]) {
      if (labels[kind] === undefined) continue;
      const map = expectObject(labels[kind], `labels.${kind}`);
      for (const [name, gloss] of Object.entries(map)) {
        if (typeof gloss !== "string") {
          throw new Error(`labels.${kind}.${name} must be a one-line gloss (a string)`);
        }
        const target =
          kind === "universal" ? config.universal : kind === "issues" ? config.issues : config.pr;
        if (config.universal.has(name) || config.issues.has(name) || config.pr.has(name)) {
          throw new Error(
            `the label '${name}' is declared twice — in two of universal/issues/pr; ` +
              `refused, not reconciled`,
          );
        }
        target.set(name, gloss);
      }
    }
  }

  const prSheet = new Set([...config.universal.keys(), ...config.pr.keys()]);
  /** @type {SizeConfig | undefined} */
  const size = raw["size"] === undefined ? undefined : validateSizeConfig(raw["size"], prSheet);

  if (raw["instructions"] !== undefined) {
    const instructions = expectObject(raw["instructions"], "instructions");
    for (const key of Object.keys(instructions)) {
      if (!(key in DEFAULT_INSTRUCTION_PATHS)) {
        throw new Error(`unknown instructions key '${key}'`);
      }
      const value = instructions[key];
      if (typeof value !== "string" || value === "") {
        throw new Error(`instructions.${key} must be a path`);
      }
      const typed = /** @type {keyof typeof DEFAULT_INSTRUCTION_PATHS} */ (key);
      config.instructions[typed] = value;
    }
  }

  return { ...config, size };
}

/**
 * The effective sheet for a thread: `universal ∪ issues` for an issue,
 * `universal ∪ pr` for a pull request, narrowed by the workflow's `labels:`
 * input when it names a subset — and never carrying the size labels, which
 * are measured rather than asked and are never on any sheet offered to a
 * model.
 *
 * @param {object} input
 * @param {TriageConfig | null} input.config
 * @param {"issue" | "pr"} input.threadType
 * @param {string[]} input.narrowing the `labels:` input; empty means no narrowing
 * @returns {{ sheet: Map<string, string> | null, sizeLabels: string[] }}
 */
export function effectiveSheet({ config, threadType, narrowing }) {
  if (config === null) {
    if (narrowing.length > 0) {
      throw new Error(
        `the labels input names ${narrowing.join(", ")}, but there is no config file to narrow — ` +
          `a sheet must be declared before it can be narrowed`,
      );
    }
    return { sheet: null, sizeLabels: [] };
  }

  // A file that declares no labels at all is no sheet: the classification
  // becomes the marker comment, exactly as with no file. (A file declaring
  // size labels but no sheet never validates — every size label must be on
  // the PR sheet, and an empty sheet holds none.)
  if (config.universal.size + config.issues.size + config.pr.size === 0) {
    if (narrowing.length > 0) {
      throw new Error(
        `the labels input names ${narrowing.join(", ")}, which the config file does not declare — ` +
          `the file declares no labels at all`,
      );
    }
    return { sheet: null, sizeLabels: [] };
  }

  const declared = new Set([
    ...config.universal.keys(),
    ...config.issues.keys(),
    ...config.pr.keys(),
    ...(config.size?.ladder.map((rung) => rung.label) ?? []),
  ]);
  for (const name of narrowing) {
    if (!declared.has(name)) {
      throw new Error(
        `the labels input names '${name}', which the config file does not declare — ` +
          `narrowing selects a subset of the declared sheet; it never widens it`,
      );
    }
  }

  const sizeLabels = config.size?.ladder.map((rung) => rung.label) ?? [];
  const typeMap = threadType === "issue" ? config.issues : config.pr;
  /** @type {Map<string, string>} */
  const sheet = new Map();
  for (const [name, gloss] of config.universal) sheet.set(name, gloss);
  for (const [name, gloss] of typeMap) sheet.set(name, gloss);
  if (narrowing.length > 0) {
    const keep = new Set(narrowing);
    for (const name of sheet.keys()) {
      if (!keep.has(name)) sheet.delete(name);
    }
  }
  // Size is measured from the diff, never asked of the model: the size
  // labels stay off every sheet offered, however configured.
  for (const name of sizeLabels) sheet.delete(name);

  if (sheet.size === 0) {
    throw new Error(
      "the effective sheet is empty — nothing is offered to the model. Narrow less, or " +
        "declare labels the thread type can be classified into",
    );
  }

  return { sheet, sizeLabels };
}

/**
 * Reads the instruction documents a run will use, from the default branch.
 * Every document is optional: the configured-or-default path is tried, and a
 * missing document is fine. A document past its cap is refused — prose cut
 * mid-sentence misleads more reliably than prose absent.
 *
 * @param {object} input
 * @param {ContentsReader} input.forge
 * @param {TriageConfig | null} input.config
 * @param {"issue" | "pr"} input.threadType
 * @returns {Promise<{ instruction?: string, typeInstruction?: string }>}
 */
export async function loadInstructions({ forge, config, threadType }) {
  /** @type {{ instruction?: string, typeInstruction?: string }} */
  const documents = {};

  const instructionPath =
    config?.instructions["instruction"] ?? DEFAULT_INSTRUCTION_PATHS["instruction"];
  const general = await readDocument(forge, instructionPath);
  if (general !== null) documents.instruction = general;

  const typeKey = threadType === "issue" ? "issue-instruction" : "pr-instruction";
  const typePath = config?.instructions[typeKey] ?? DEFAULT_INSTRUCTION_PATHS[typeKey];
  const typed = await readDocument(forge, typePath);
  if (typed !== null) documents.typeInstruction = typed;

  return documents;
}

/**
 * @param {ContentsReader} forge
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function readDocument(forge, path) {
  const file = await forge.getContents(path);
  if (file === null) return null;
  const bytes = new TextEncoder().encode(file.content).byteLength;
  if (bytes > MAX_INSTRUCTION_BYTES) {
    throw new Error(
      `'${path}' is ${String(bytes)} bytes, past the ${String(MAX_INSTRUCTION_BYTES)}-byte cap — ` +
        `an instruction document that overflows is refused rather than truncated`,
    );
  }
  return file.content;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function expectObject(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}
