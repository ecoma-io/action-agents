/**
 * `triage`'s config file — the schema, its validation, and the effective
 * sheet. The `labels` block is policy only: it names the labels the action
 * may use and what each is for, never their words. Descriptions and colours
 * come from GitHub — `core/forge.mjs` reads each label's metadata — so the
 * repository stops duplicating its label registry and the model reads what
 * GitHub already says. A config never needs to restate a gloss; the one
 * thing it must get right is which labels are usable and in what role.
 *
 * Schema major 2. A v1 file — `labels.{universal,issues,pr}` name→gloss
 * maps plus an optional top-level `triageMarker` — is migrated on read:
 * its sheet names become the v2 `labels.use` set, its marker becomes the
 * first `labels.workflowMarkers` entry, and the migration is logged. v1
 * files keep working; only their glosses stop being read (GitHub supplies
 * them).
 */
import { loadConfigFile as loadConfigFileCore, MAX_CONFIG_BYTES } from "#core/config-file.mjs";
import { validateSizeConfig } from "./size.mjs";

/**
 * The operations the config loaders need — a slice of the forge client, so
 * a test doubles only the reading half.
 *
 * @typedef {{ getContents: (path: string) => Promise<{ content: string } | null> }} ContentsReader
 */

/** @typedef {import("./size.mjs").SizeConfig} SizeConfig */

/**
 * @typedef {object} LabelPolicy
 * @property {Set<string>} use every label the action may apply, by name — GitHub is the source of truth for its description and colour
 * @property {Map<string, string>} roles the role each `use` label carries: semantic-classification, routing-area, priority, workflow-marker or triage-owned
 * @property {string[]} exclusive role groups whose labels are mutually exclusive — only one label per listed role may sit on a thread
 * @property {string[]} workflowMarkers the queue labels the action clears by code, never by model choice
 * @property {Set<string>} triageOwned labels the action may remove or replace by code — a size rung it measures, never a category a human chose
 * @property {Map<string, string>} priority an optional severity-class → priority-label mapping; empty means no such mapping
 * @property {string | null} needsMoreInfo an optional `use` label the action adds by code when an issue is judged incomplete; null means the action reports it as a comment instead
 * @property {Record<string, string>} routing an optional issue-form-id → routing-area-label mapping; the label the action adds by code when an issue matches that form, empty by default
 */

/**
 * @typedef {object} TriageConfig
 * @property {LabelPolicy} labels
 * @property {SizeConfig | undefined} size
 * @property {{ instruction?: string, "issue-instruction"?: string, "pr-instruction"?: string }} instructions configured instruction paths, before defaults
 */

export { MAX_CONFIG_BYTES };

/** An instruction document larger than this is a red refusal — prose cut mid-sentence misleads. */
export const MAX_INSTRUCTION_BYTES = 8 * 2 ** 10;

export const DEFAULT_LOCATIONS = [
  ".github/action-agents/triage/triage.json5",
  ".github/action-agents/triage/triage.json",
];

/** The only policy schema major this build emits; a higher major is refused at startup. */
export const SCHEMA_MAJOR = 2;

/**
 * The schema majors this build reads. Schema 1 is a migration window: a v1
 * `labels.{universal,issues,pr}` config is accepted and migrated to the v2
 * `labels.use` policy shape. The window is deliberate — it closes once v1
 * files are gone — never a promise to hold every major forever.
 */
export const SUPPORTED_SCHEMA_MAJORS = [1, 2];

/** The role a config may give a `use` label — the whole vocabulary of what a label is for. */
const ROLES = new Set([
  "semantic-classification",
  "routing-area",
  "priority",
  "workflow-marker",
  "triage-owned",
]);

const DEFAULT_INSTRUCTION_PATHS = {
  instruction: ".github/action-agents/triage/instruction.md",
  "issue-instruction": ".github/action-agents/triage/issue-instruction.md",
  "pr-instruction": ".github/action-agents/triage/pr-instruction.md",
};

/**
 * Reads the config file from the resolved policy source and parses it.
 *
 * Absent default locations are policy-empty; a configured `config-path`
 * that is absent is a red refusal — a workflow naming a file that does
 * not exist has a bug, and guessing `null` would silently run an empty
 * policy. The reading, the cap and the schema check live in `core`; this
 * wrapper supplies `triage`'s locations and schema.
 *
 * @param {object} input
 * @param {ContentsReader} input.forge pinned to the resolved policy source
 * @param {string} input.configPath the `config-path` input, "" for the default locations
 * @param {import("#core/policy.mjs").PolicySource} input.source the resolved policy source
 * @returns {Promise<{ raw: Record<string, unknown> | null, path: string }>}
 */
export function loadConfigFile({ forge, configPath, source }) {
  return loadConfigFileCore({
    forge,
    configPath,
    source,
    locations: DEFAULT_LOCATIONS,
    absent: "empty",
    supportedMajor: SUPPORTED_SCHEMA_MAJORS,
  });
}

/**
 * Migrates a schema-1 config into the schema-2 shape, idempotently. A v1
 * file declares `labels.{universal,issues,pr}` name→gloss maps and an
 * optional top-level `triageMarker`; schema 2 declares `labels.use` (the
 * usable set) plus the policy block and keeps workflow markers in
 * `labels.workflowMarkers`. Migration folds every v1 sheet name into
 * `use` and the marker into `workflowMarkers`; descriptions are dropped
 * because GitHub now supplies them. A v2 file is returned untouched, so
 * calling `validateConfig` twice is safe.
 *
 * @template {Record<string, unknown> | null} T
 * @param {T} raw
 * @returns {{ raw: T, migrated: boolean }}
 */
export function migrateConfig(raw) {
  if (raw === null) return { raw, migrated: false };
  const labels = /** @type {unknown} */ (raw["labels"]);
  const isV1 =
    typeof labels === "object" &&
    labels !== null &&
    !Array.isArray(labels) &&
    (Object.hasOwn(labels, "universal") ||
      Object.hasOwn(labels, "issues") ||
      Object.hasOwn(labels, "pr"));
  if (!isV1) return { raw, migrated: false };

  const sheet = /** @type {Record<string, unknown>} */ (labels);
  /** @type {string[]} */
  const use = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const kind of ["universal", "issues", "pr"]) {
    const map = sheet[kind];
    if (typeof map !== "object" || map === null || Array.isArray(map)) continue;
    for (const name of Object.keys(map)) {
      if (!seen.has(name)) {
        seen.add(name);
        use.push(name);
      }
    }
  }

  const migrated = { ...raw };
  delete migrated["labels"];
  delete migrated["triageMarker"];
  /** @type {Record<string, string>} */
  const roles = {};
  // A v1 `universal` label was the closest thing schema 1 had to a category
  // — the marker was cleared once one was classified. Preserve that exactly:
  // those names carry the semantic-classification role under schema 2, so a
  // migrated queue marker still clears when the model classifies a category.
  const universal = sheet["universal"];
  if (typeof universal === "object" && universal !== null && !Array.isArray(universal)) {
    for (const name of Object.keys(universal)) roles[name] = "semantic-classification";
  }
  /** @type {string[]} */
  const workflowMarkers = [];
  const marker = raw["triageMarker"];
  if (typeof marker === "string" && marker !== "") workflowMarkers.push(marker);
  migrated["labels"] = { use, roles, workflowMarkers };
  return { raw: migrated, migrated: true };
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
  /** @type {Record<string, unknown> | null} */
  const migrated = migrateConfig(raw).raw;
  if (migrated === null) return null;

  for (const key of Object.keys(migrated)) {
    if (key !== "schemaVersion" && key !== "labels" && key !== "size" && key !== "instructions") {
      throw new Error(
        `unknown config key '${key}' — the file holds schemaVersion, labels, size and instructions`,
      );
    }
  }

  /** @type {LabelPolicy} */
  const policy = {
    use: new Set(),
    roles: new Map(),
    exclusive: [],
    workflowMarkers: [],
    triageOwned: new Set(),
    priority: new Map(),
    needsMoreInfo: null,
    routing: {},
  };
  /** @type {Partial<Record<keyof typeof DEFAULT_INSTRUCTION_PATHS, string>>} */
  const instructions = {};

  if (migrated["labels"] !== undefined) {
    const labels = expectObject(migrated["labels"], "labels");

    if (labels["use"] !== undefined) {
      if (!Array.isArray(labels["use"]))
        throw new Error("labels.use must be an array of label names");
      for (const name of labels["use"]) {
        if (typeof name !== "string" || name === "")
          throw new Error("labels.use must contain non-empty label names");
        if (policy.use.has(name))
          throw new Error(
            `the label '${name}' is declared twice in labels.use — refused, not reconciled`,
          );
        policy.use.add(name);
      }
    }

    if (labels["roles"] !== undefined) {
      const roles = expectObject(labels["roles"], "labels.roles");
      for (const [name, role] of Object.entries(roles)) {
        if (typeof role !== "string" || !ROLES.has(role))
          throw new Error(
            `labels.roles.${name} must be one of ${[...ROLES].join(", ")} — got '${String(role)}'`,
          );
        if (!policy.use.has(name))
          throw new Error(`labels.roles names '${name}', which labels.use does not declare`);
        policy.roles.set(name, role);
      }
    }

    if (labels["exclusive"] !== undefined) {
      if (!Array.isArray(labels["exclusive"]))
        throw new Error("labels.exclusive must be an array of role names");
      for (const group of labels["exclusive"]) {
        if (typeof group !== "string" || group === "")
          throw new Error("labels.exclusive must contain non-empty role names");
        const carries = [...policy.roles.values()].includes(group);
        if (!carries)
          throw new Error(
            `labels.exclusive names role '${group}', which no labels.roles entry carries`,
          );
        policy.exclusive.push(group);
      }
    }

    if (labels["workflowMarkers"] !== undefined) {
      if (!Array.isArray(labels["workflowMarkers"]))
        throw new Error("labels.workflowMarkers must be an array of label names");
      for (const marker of labels["workflowMarkers"]) {
        if (typeof marker !== "string" || marker === "")
          throw new Error("labels.workflowMarkers must contain non-empty label names");
        // The marker is cleared once a category is classified. If it is
        // itself a classification label, clearing it would un-classify the
        // thread it just marked — refused rather than silently self-defeating.
        if (policy.roles.get(marker) === "semantic-classification") {
          throw new Error(
            `workflow marker '${marker}' is also a classification label — the queue label ` +
              `must not carry the semantic-classification role`,
          );
        }
        policy.workflowMarkers.push(marker);
      }
    }

    if (labels["triageOwned"] !== undefined) {
      if (!Array.isArray(labels["triageOwned"]))
        throw new Error("labels.triageOwned must be an array of label names");
      for (const name of labels["triageOwned"]) {
        if (typeof name !== "string" || name === "")
          throw new Error("labels.triageOwned must contain non-empty label names");
        if (!policy.use.has(name))
          throw new Error(`labels.triageOwned names '${name}', which labels.use does not declare`);
        policy.triageOwned.add(name);
      }
    }

    if (labels["priority"] !== undefined) {
      // v2 semantics: keys are severity classes the model may choose from,
      // values are priority-role labels the action derives by code. Each
      // value must be a `use` label carrying the priority role — a value the
      // action would derive must be a label it may already apply, and it must
      // compete in the single-valued priority role for the removal logic to
      // stay coherent.
      const priority = expectObject(labels["priority"], "labels.priority");
      for (const [severity, labelName] of Object.entries(priority)) {
        if (typeof labelName !== "string" || labelName === "")
          throw new Error(
            `labels.priority.${severity} must be a label name — got '${String(labelName)}'`,
          );
        if (!policy.use.has(labelName))
          throw new Error(
            `labels.priority maps severity '${severity}' to '${labelName}', which labels.use does not declare`,
          );
        if (policy.roles.get(labelName) !== "priority")
          throw new Error(
            `labels.priority maps severity '${severity}' to '${labelName}', which does not carry the priority role`,
          );
        policy.priority.set(severity, labelName);
      }
    }

    if (labels["needsMoreInfo"] !== undefined) {
      const name = labels["needsMoreInfo"];
      if (typeof name !== "string" || name === "")
        throw new Error("labels.needsMoreInfo must be a label name");
      if (!policy.use.has(name))
        throw new Error(`labels.needsMoreInfo names '${name}', which labels.use does not declare`);
      policy.needsMoreInfo = name;
    }

    if (labels["routing"] !== undefined) {
      const routing = expectObject(labels["routing"], "labels.routing");
      for (const [formId, labelName] of Object.entries(routing)) {
        if (typeof labelName !== "string" || labelName === "")
          throw new Error(
            `labels.routing.${formId} must be a label name — got '${String(labelName)}'`,
          );
        if (!policy.use.has(labelName))
          throw new Error(
            `labels.routing maps form '${formId}' to '${labelName}', which labels.use does not declare`,
          );
        if (policy.roles.get(labelName) !== "routing-area")
          throw new Error(
            `labels.routing maps form '${formId}' to '${labelName}', which does not carry the routing-area role`,
          );
        policy.routing[formId] = labelName;
      }
    }
  }

  const useSet = policy.use;
  /** @type {SizeConfig | undefined} */
  const size =
    migrated["size"] === undefined ? undefined : validateSizeConfig(migrated["size"], useSet);

  if (migrated["instructions"] !== undefined) {
    const rawInstructions = expectObject(migrated["instructions"], "instructions");
    for (const key of Object.keys(rawInstructions)) {
      // own-property, not `in`: a key like "constructor" is a path to refuse,
      // never a prototype member to let through.
      if (!Object.hasOwn(DEFAULT_INSTRUCTION_PATHS, key)) {
        throw new Error(`unknown instructions key '${key}'`);
      }
      const value = rawInstructions[key];
      if (typeof value !== "string" || value === "") {
        throw new Error(`instructions.${key} must be a path`);
      }
      const typed = /** @type {keyof typeof DEFAULT_INSTRUCTION_PATHS} */ (key);
      instructions[typed] = value;
    }
  }

  return { labels: policy, size, instructions };
}

/**
 * The effective sheet for a thread: every `use` label except those the
 * action measures or resets by code — size rungs and workflow markers —
 * each carrying the repository's own description as its gloss. GitHub is
 * the source of truth for what a label means, so the sheet is built from
 * the label metadata the forge just read, not from the config. A label
 * with no description on GitHub is offered by name alone (a normal label,
 * not a broken one); a `metadata` map may be omitted by tests that have
 * no forge, in which case each label's gloss is its name.
 *
 * @param {object} input
 * @param {TriageConfig | null} input.config
 * @param {"issue" | "pr"} input.threadType
 * @param {string[]} input.narrowing the `labels:` input; empty means no narrowing
 * @param {Map<string, { name: string, description: string, color: string }>} [input.metadata] repository label metadata by name
 * @returns {{ sheet: Map<string, string> | null }}
 */
export function effectiveSheet({
  config,
  threadType: _threadType,
  narrowing,
  metadata = new Map(),
}) {
  if (config === null) {
    if (narrowing.length > 0) {
      throw new Error(
        `the labels input names ${narrowing.join(", ")}, but there is no config file to narrow — ` +
          `a sheet must be declared before it can be narrowed`,
      );
    }
    return { sheet: null };
  }

  const sizeLabels = config.size?.ladder.map((rung) => rung.label) ?? [];
  const neverOffered = new Set([...sizeLabels]);
  for (const [name, role] of config.labels.roles) {
    if (role === "priority" || role === "workflow-marker") neverOffered.add(name);
  }
  // needsMoreInfo is added by code, never chosen by the model — so it is
  // never offered on the sheet, like the priority rungs it joins.
  if (config.labels.needsMoreInfo !== null) neverOffered.add(config.labels.needsMoreInfo);
  const offered = [...config.labels.use].filter((name) => !neverOffered.has(name));

  // A file that declares no usable labels is no sheet: the classification
  // becomes the marker comment, exactly as with no file.
  if (offered.length === 0) {
    if (narrowing.length > 0) {
      throw new Error(
        `the labels input names ${narrowing.join(", ")}, which the config file does not declare — ` +
          `the file offers no labels at all`,
      );
    }
    return { sheet: null };
  }

  const declared = new Set([...config.labels.use, ...sizeLabels]);
  for (const name of narrowing) {
    if (!declared.has(name)) {
      throw new Error(
        `the labels input names '${name}', which the config file does not declare — ` +
          `narrowing selects a subset of the declared sheet; it never widens it`,
      );
    }
  }

  /** @type {Map<string, string>} */
  const sheet = new Map();
  for (const name of offered) {
    const known = metadata.get(name);
    const gloss = (known?.description ?? "") || name;
    sheet.set(name, gloss);
  }
  if (narrowing.length > 0) {
    const keep = new Set(narrowing);
    for (const name of sheet.keys()) {
      if (!keep.has(name)) sheet.delete(name);
    }
  }

  if (sheet.size === 0) {
    throw new Error(
      "the effective sheet is empty — nothing is offered to the model. Narrow less, or " +
        "declare labels the thread type can be classified into",
    );
  }

  return { sheet };
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
