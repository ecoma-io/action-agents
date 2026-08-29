/**
 * `harmonise`'s config file — the document map, the ignore list, the glossary,
 * and where the instruction prose lives. Everything here is `harmonise`'s own
 * domain: `core/` never learns a key's name, and no other action imports this
 * reader. The mechanism (where the file lives, the default branch, precedence)
 * is `docs/development/configuration.md`'s.
 *
 * Unlike `triage`, an absent file is never policy-empty here: with no map
 * there is no source language and nothing to keep in step, so a missing file
 * is a red refusal rather than a quiet run. All validation happens at startup,
 * before anything is fetched beyond the config itself.
 */

import { json5Parse } from "#core/json5-parse.mjs";
import { assertPolicySchemaVersion } from "#core/policy.mjs";

import {
  MAX_ASSET_LAYOUTS,
  parseAssetLayout,
  parseLanguagePattern,
  validateLanguagePattern,
} from "./patterns.mjs";

/**
 * The operations the config loaders need — a slice of the forge client, so a
 * test doubles only the reading half.
 *
 * @typedef {{ getContents: (path: string) => Promise<{ content: string } | null> }} ContentsReader
 *
 * Readers anchored to one exact commit pass the ref through their own
 * closure; the typedef stays one-argument by design.
 */

/**
 * @typedef {object} HarmoniseInstructions
 * @property {string} [instruction] path to the all-pairs instruction document
 * @property {Record<string, string>} languages language tag → path, one per language that has its own prose
 */

/**
 * @typedef {object} HarmoniseConfig
 * @property {string} sourceLanguage the key of `languages` every other version is judged against
 * @property {Record<string, LanguagePattern>} languages language tag → parsed pattern
 * @property {string[]} ignore glob patterns excluding generated or untranslated documents from the source set
 * @property {string[]} glossary terms protected verbatim in every translation, exact-match
 * @property {HarmoniseInstructions} instructions
 * @property {{ title: string }} [pullRequest] the commit-subject/pull-request-title template, when the repository renames the convention
 * @property {{ layouts: AssetLayout[] }} [assets] templates naming where a language's image variants live, relative to the document's directory
 * @property {number} concurrency how many translatable pairs may be in flight with the model at once; defaults to 2, capped at `MAX_PAIR_CONCURRENCY`
 */

/**
 * @typedef {import("./patterns.mjs").LanguagePattern} LanguagePattern
 */

/**
 * @typedef {import("./patterns.mjs").AssetLayout} AssetLayout
 */
/** A config file larger than this is a red refusal, not a truncated policy. */
export const MAX_CONFIG_BYTES = 64 * 2 ** 10;

/** An instruction document larger than this is a red refusal — prose cut mid-sentence misleads. */
export const MAX_INSTRUCTION_BYTES = 8 * 2 ** 10;

/** How many translatable pairs a run translates at once when the config is silent. */
const DEFAULT_PAIR_CONCURRENCY = 2;

/**
 * The most pairs one run ever translates concurrently, whatever the config
 * declares. A cap, not a validation range: a declared value above it is
 * honored up to the ceiling rather than refused, so the bound a run works
 * under is `min(config.concurrency, this)`.
 */
export const MAX_PAIR_CONCURRENCY = 4;

const DEFAULT_LOCATIONS = [
  ".github/action-agents/harmonise/harmonise.json5",
  ".github/action-agents/harmonise/harmonise.json",
];

/** The only policy schema major this build understands; a higher major is refused at startup. */
export const SCHEMA_MAJOR = 1;

/** The placeholders a pull-request title template may carry, and no others. */
export const TITLE_PLACEHOLDERS = ["n", "sourceLanguage"];

/** A rendered title longer than this is refused — a subject line is read, not scrolled. */
export const MAX_TITLE_CHARS = 200;

const DEFAULT_INSTRUCTION_PATHS = {
  instruction: ".github/action-agents/harmonise/instruction.md",
};

/**
 * Reads the config file from the resolved policy source and parses it. There
 * is no absent-file case: `harmonise` without a map refuses at startup.
 *
 * @param {object} input
 * @param {ContentsReader} input.forge pinned to the resolved policy source
 * @param {string} input.configPath the `config-path` input, "" for the default locations
 * @param {import("#core/policy.mjs").PolicySource} input.source the resolved policy source
 * @returns {Promise<{ raw: Record<string, unknown>, path: string }>}
 */
export async function loadConfigFile({ forge, configPath, source }) {
  if (configPath !== "") {
    const file = await forge.getContents(configPath);
    if (file === null) {
      throw new Error(
        `config-path names '${configPath}', which does not exist on branch '${source.branch}' ` +
          `at ${source.sha} — the policy source resolved for this run`,
      );
    }
    return { raw: parseFile(configPath, file.content, source), path: configPath };
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
  if (found.length === 0) {
    throw new Error(
      `no config file exists — expected one of ${DEFAULT_LOCATIONS.join(" or ")} on ` +
        `${source.branch} at ${source.sha}, the policy source resolved for this run. ` +
        `harmonise keeps no documents in step without a map of them`,
    );
  }
  const first = found[0];
  if (first === undefined) throw new Error("a config file was found and then lost");
  return { raw: parseFile(first.path, first.content, source), path: first.path };
}

/**
 * @param {string} path
 * @param {string} content
 * @param {import("#core/policy.mjs").PolicySource} source
 * @returns {Record<string, unknown>}
 */
function parseFile(path, content, source) {
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
  assertPolicySchemaVersion({ raw: parsed, supportedMajor: SCHEMA_MAJOR, path, source });
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Validates the parsed file into a `HarmoniseConfig`. Every refusal here is a
 * startup refusal: a config half-accepted would be half-run.
 *
 * @param {Record<string, unknown>} raw
 * @returns {HarmoniseConfig}
 */
export function validateConfig(raw) {
  for (const key of Object.keys(raw)) {
    if (
      ![
        "schemaVersion",
        "sourceLanguage",
        "languages",
        "ignore",
        "glossary",
        "instructions",
        "concurrency",
        "pullRequest",
        "assets",
      ].includes(key)
    ) {
      throw new Error(
        `unknown config key '${key}' — the file holds schemaVersion, sourceLanguage, languages, ` +
          `ignore, glossary, instructions, concurrency, pullRequest and assets`,
      );
    }
  }

  const languagesRaw = expectObject(raw["languages"], "languages");
  /** @type {Record<string, LanguagePattern>} */
  const languages = {};
  for (const [lang, pattern] of Object.entries(languagesRaw)) {
    if (!/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]+)*$/.test(lang)) {
      throw new Error(`languages.'${lang}' is not a language tag`);
    }
    if (typeof pattern !== "string") {
      throw new Error(`languages.'${lang}' must be a pattern string`);
    }
    validateLanguagePattern(pattern, `languages.'${lang}'`);
    languages[lang] = parseLanguagePattern(pattern);
  }

  const sourceLanguage = raw["sourceLanguage"];
  if (typeof sourceLanguage !== "string" || sourceLanguage === "") {
    throw new Error("sourceLanguage must name the language every other version is judged against");
  }
  if (!Object.hasOwn(languages, sourceLanguage)) {
    throw new Error(
      `sourceLanguage '${sourceLanguage}' is not a key of languages — the source needs a ` +
        `pattern like every other language`,
    );
  }
  // A map of the source alone leaves nothing to translate into: green there
  // would be green-on-nothing.
  if (Object.keys(languages).length < 2) {
    throw new Error(
      `languages declares only the source '${sourceLanguage}' — at least one target language ` +
        `is needed, or the action has nothing to do`,
    );
  }

  /** @type {string[]} */
  const ignore = [];
  if (raw["ignore"] !== undefined) {
    if (!Array.isArray(raw["ignore"])) throw new Error("ignore must be an array of globs");
    for (const entry of raw["ignore"]) {
      if (typeof entry !== "string") throw new Error("ignore must hold strings only");
      ignore.push(entry);
    }
  }

  /** @type {string[]} */
  const glossary = [];
  if (raw["glossary"] !== undefined) {
    if (!Array.isArray(raw["glossary"])) throw new Error("glossary must be an array of strings");
    for (const term of raw["glossary"]) {
      if (typeof term !== "string" || term === "") {
        throw new Error("glossary entries must be non-empty strings");
      }
      // Terms are matched against text whose invisible machinery (code-span
      // masks, placeholder bodies) is NUL-filled: a control character or a
      // newline in a term would match the machinery instead of the prose and
      // corrupt documents on restore. Refused, not worked around.
      const carriesControl = [...term].some((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f;
      });
      if (carriesControl) {
        throw new Error(
          `the glossary names a term containing control characters or line breaks — ` +
            `terms match visible prose only`,
        );
      }
    }
    const seen = new Set();
    for (const term of /** @type {unknown[]} */ (raw["glossary"])) {
      const value = /** @type {string} */ (term);
      if (seen.has(value)) {
        throw new Error(`the glossary names '${value}' twice — refused, not deduplicated`);
      }
      seen.add(value);
      glossary.push(value);
    }
  }

  const instructions = parseInstructions(raw["instructions"], languages);

  const { concurrency } = parseConcurrency(raw["concurrency"]);

  const pullRequest = parsePullRequest(raw["pullRequest"]);

  const assets = parseAssets(raw["assets"]);

  return {
    sourceLanguage,
    languages,
    ignore,
    glossary,
    instructions,
    concurrency,
    ...pullRequest,
    ...assets,
  };
}

/**
 * The optional `pullRequest` block: today only `title`, the template for both
 * the commit subject and the pull-request title. Absent means the built-in
 * convention stands — nothing about an existing consumer's run changes.
 *
 * The template is deterministic string work: `{n}` and `{sourceLanguage}` are
 * its only placeholders, substituted at publish time from facts this run
 * already derived. Every brace that is not one of those two placeholders is a
 * refusal — a typo like `{count}` must be a red config, never literal text in
 * a title nobody meant.
 *
 * @param {unknown} value
 * @returns {{ pullRequest?: { title: string } }}
 */
function parsePullRequest(value) {
  if (value === undefined) return {};
  const block = expectObject(value, "pullRequest");

  for (const key of Object.keys(block)) {
    if (key !== "title") {
      throw new Error(`unknown pullRequest key '${key}' — the block holds title`);
    }
  }

  const title = block["title"];
  if (typeof title !== "string") {
    throw new Error("pullRequest.title must be a template string");
  }
  if (title.trim() === "") {
    throw new Error("pullRequest.title is empty — a subject line cannot be blank");
  }
  // Braces are reserved: exactly the two known placeholders may appear.
  const braces = [...title.matchAll(/\{([^{}]*)\}/g)];
  for (const match of braces) {
    const name = /** @type {RegExpMatchArray} */ (match)[1] ?? "";
    if (!TITLE_PLACEHOLDERS.includes(name)) {
      throw new Error(
        name === ""
          ? "pullRequest.title carries an empty placeholder '{}' — the only placeholders " +
              `are ${TITLE_PLACEHOLDERS.map((n) => `{${n}}`).join(" and ")}`
          : `pullRequest.title carries unknown placeholder '{${name}}' — the only ` +
              `placeholders are ${TITLE_PLACEHOLDERS.map((n) => `{${n}}`).join(" and ")}`,
      );
    }
  }
  // A lone brace pairs with nothing and would surface as literal debris or
  // silently vanish depending on where substitution looks; refused outright.
  if (/[{}]/.test(title.replace(/\{(?:n|sourceLanguage)\}/g, ""))) {
    throw new Error(
      "pullRequest.title carries an unpaired brace — braces are reserved for " +
        `${TITLE_PLACEHOLDERS.map((n) => `{${n}}`).join(" and ")}`,
    );
  }
  if (title.length > MAX_TITLE_CHARS) {
    throw new Error(
      `pullRequest.title is ${String(title.length)} characters, past the ` +
        `${String(MAX_TITLE_CHARS)}-character cap`,
    );
  }

  return { pullRequest: { title } };
}

/**
 * The optional `concurrency` key: how many translatable pairs one run may
 * have in flight with the model at once. A declared resource policy, never a
 * knob anything model-shaped can turn: absent it is the conservative
 * starting point the pool's doctrine names, and anything that is not a
 * positive integer is refused — a config half-accepted would be half-run.
 *
 * @param {unknown} value
 * @returns {{ concurrency: number }}
 */
function parseConcurrency(value) {
  if (value === undefined) return { concurrency: DEFAULT_PAIR_CONCURRENCY };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    const shown = typeof value === "string" ? `"${value}"` : String(value);
    throw new Error(
      `concurrency must be a positive integer (got ${shown}) — how many translatable pairs ` +
        `the model works on at once; absent it defaults to ${String(DEFAULT_PAIR_CONCURRENCY)}`,
    );
  }
  return { concurrency: value };
}

/**
 * The optional `assets` block: today only `layouts`, the templates naming
 * where a repository keeps a language's variant of an image, relative to the
 * document's own directory. Absent means the built-in convention stands —
 * nothing about an existing consumer's run changes.
 *
 * A layout is deterministic string work over `{dir}`, `{base}`, `{ext}` and
 * `{lang}`. Every brace that is not one of those placeholders is a refusal —
 * a typo like `{locale}` must be a red config, never literal text in a path
 * nobody meant — and so is a template that could only ever produce a path
 * outside the document's directory: absolute, a drive, `..`, an empty
 * segment. Whether a rendered candidate exists is decided later, against the
 * branch's real tree; a layout that misses for one reference simply never
 * wins for it. `harmonise` never creates, uploads, renames or rewrites asset
 * files — it only points references at localized variants that already exist.
 *
 * @param {unknown} value
 * @returns {{ assets?: { layouts: AssetLayout[] } }}
 */
function parseAssets(value) {
  if (value === undefined) return {};
  const block = expectObject(value, "assets");

  for (const key of Object.keys(block)) {
    if (key !== "layouts") {
      throw new Error(`unknown assets key '${key}' — the block holds layouts`);
    }
  }

  const rawLayouts = block["layouts"];
  if (!Array.isArray(rawLayouts)) {
    throw new Error("assets.layouts must be an array of layout template strings");
  }
  if (rawLayouts.length > MAX_ASSET_LAYOUTS) {
    throw new Error(
      `assets.layouts holds ${String(rawLayouts.length)} layouts — at most ` +
        `${String(MAX_ASSET_LAYOUTS)} fit`,
    );
  }

  /** @type {AssetLayout[]} */
  const layouts = [];
  const seen = new Set();
  for (const entry of rawLayouts) {
    if (typeof entry !== "string" || entry === "") {
      throw new Error("assets.layouts entries must be non-empty template strings");
    }
    if (seen.has(entry)) {
      throw new Error(`assets.layouts names '${entry}' twice — refused, not deduplicated`);
    }
    seen.add(entry);
    layouts.push(parseAssetLayout(entry, `assets.layouts[${String(layouts.length)}]`));
  }

  return { assets: { layouts } };
}

/**
 * The `instructions` block, validated against the languages the map declares:
 * prose for every pair, plus per-language overrides. A language the map does
 * not declare is refused — prose aimed at a language that cannot come up is a
 * bug waiting to be wondered about.
 *
 * @param {unknown} value
 * @param {Record<string, LanguagePattern>} languages
 * @returns {HarmoniseInstructions}
 */
function parseInstructions(value, languages) {
  /** @type {HarmoniseInstructions} */
  const instructions = { languages: {} };
  if (value === undefined) return instructions;
  const block = expectObject(value, "instructions");

  for (const key of Object.keys(block)) {
    if (key !== "instruction" && key !== "language-instructions") {
      throw new Error(
        `unknown instructions key '${key}' — the block holds instruction and language-instructions`,
      );
    }
  }

  const general = block["instruction"];
  if (general !== undefined) {
    if (typeof general !== "string" || general === "") {
      throw new Error("instructions.instruction must be a path");
    }
    instructions.instruction = general;
  }

  const perLanguage = block["language-instructions"];
  if (perLanguage !== undefined) {
    const map = expectObject(perLanguage, "instructions.language-instructions");
    for (const [lang, path] of Object.entries(map)) {
      if (!Object.hasOwn(languages, lang)) {
        throw new Error(
          `instructions.language-instructions names '${lang}', which languages does not declare`,
        );
      }
      if (typeof path !== "string" || path === "") {
        throw new Error(`instructions.language-instructions.'${lang}' must be a path`);
      }
      instructions.languages[lang] = path;
    }
  }

  return instructions;
}

/**
 * Reads the instruction documents a run's prompts will carry, from the
 * default branch: the all-pairs document, plus each language's own. Every
 * document is optional — the convention path is tried when no override is
 * configured, and a missing document is fine. A document past its cap is
 * refused rather than truncated.
 *
 * @param {object} input
 * @param {ContentsReader} input.forge
 * @param {HarmoniseConfig} input.config the validated config (paths already resolved)
 * @returns {Promise<{ instruction?: string, languages: Record<string, string> }>}
 */
export async function loadInstructions({ forge, config }) {
  /** @type {{ instruction?: string, languages: Record<string, string> }} */
  const documents = { languages: {} };

  const generalPath = config.instructions.instruction ?? DEFAULT_INSTRUCTION_PATHS["instruction"];
  const general = await readInstruction(forge, generalPath);
  if (general !== null) documents.instruction = general;

  for (const [lang, path] of Object.entries(config.instructions.languages).sort()) {
    const text = await readInstruction(forge, path);
    if (text !== null) documents.languages[lang] = text;
  }

  return documents;
}

/**
 * @param {ContentsReader} forge
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function readInstruction(forge, path) {
  const file = await forge.getContents(path);
  if (file === null) return null;
  const bytes = new TextEncoder().encode(file.content).byteLength;
  if (bytes > MAX_INSTRUCTION_BYTES) {
    throw new Error(
      `'${path}' is ${String(bytes)} bytes, past the ${String(MAX_INSTRUCTION_BYTES)}-byte ` +
        `cap — an instruction document that overflows is refused rather than truncated`,
    );
  }
  return file.content;
}

/** @param {unknown} value @param {string} name @returns {Record<string, unknown>} */
function expectObject(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}
