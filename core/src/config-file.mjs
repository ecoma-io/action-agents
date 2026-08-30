/**
 * Loading a policy config file from the resolved policy source — the shape
 * `triage`, `review` and `harmonise` all share, factored into one home so the
 * cap, the refusal language and the schema check cannot drift between them.
 *
 * The one behaviour that differs between actions is what an absent set of
 * default locations means:
 *
 * - `triage` and `review` treat it as an empty policy — they have honest work
 *   to do with no file at all;
 * - `harmonise` refuses at startup — it keeps no documents in step without a
 *   map of them.
 *
 * That divergence is the `absent` switch. Everything else — the byte cap, the
 * JSON5 parse, the object shape check, the schema-major refusal — is the same
 * refusal for every action and lives here once.
 */
import { json5Parse } from "./json5-parse.mjs";
import { assertPolicySchemaVersion } from "./policy.mjs";

/**
 * The slice of the forge the config loaders use — a test doubles only the
 * reading half.
 *
 * @typedef {{ getContents: (path: string) => Promise<{ content: string } | null> }} ContentsReader
 */
/** A config file larger than this is a red refusal, not a truncated policy. */
export const MAX_CONFIG_BYTES = 64 * 2 ** 10;

/**
 * @param {object} input
 * @param {ContentsReader} input.forge pinned to the resolved policy source
 * @param {string} input.configPath the `config-path` input, "" for the default locations
 * @param {import("#core/policy.mjs").PolicySource} input.source the resolved policy source, named in refusals
 * @param {string[]} input.locations the default locations to try when `configPath` is "", in order
 * @param {"empty" | "refuse"} [input.absent] what an absent default set means; "empty" returns `raw: null`, "refuse" throws (default "empty")
 * @param {string} [input.absentMessage] the refusal text for an absent set under `absent: "refuse"`, when the caller wants to name why it refuses
 * @param {number | number[]} input.supportedMajor the schema major(s) this action understands
 * @returns {Promise<{ raw: Record<string, unknown> | null, path: string }>}
 */
export async function loadConfigFile({
  forge,
  configPath,
  source,
  locations,
  absent = "empty",
  absentMessage,
  supportedMajor,
}) {
  if (configPath !== "") {
    const file = await forge.getContents(configPath);
    if (file === null) {
      throw new Error(
        `config-path names '${configPath}', which does not exist on branch '${source.branch}' ` +
          `at ${source.sha} — the policy source resolved for this run`,
      );
    }
    return {
      raw: parsePolicyFile(file.content, configPath, source, supportedMajor),
      path: configPath,
    };
  }

  /** @type {{ path: string, content: string }[]} */
  const found = [];
  for (const path of locations) {
    const file = await forge.getContents(path);
    if (file !== null) found.push({ path, content: file.content });
  }
  if (found.length === 2) {
    throw new Error(
      `the policy is declared twice — both ${locations[0]} and ${locations[1]} exist; remove one`,
    );
  }
  if (found.length === 0) {
    if (absent === "empty") return { raw: null, path: "" };
    throw new Error(
      absentMessage ??
        `no config file exists — expected one of ${locations.join(" or ")} on ` +
          `${source.branch} at ${source.sha}, the policy source resolved for this run`,
    );
  }
  const first = found[0];
  if (first === undefined) throw new Error("a config file was found and then lost");
  return {
    raw: parsePolicyFile(first.content, first.path, source, supportedMajor),
    path: first.path,
  };
}

/**
 * Parses, caps, and schema-checks one policy file. The schema check lives
 * here so every read — explicit `config-path` or default location — refuses
 * an unsupported `schemaVersion` before any model call.
 *
 * @param {string} content
 * @param {string} path the file's location, named in refusals
 * @param {import("#core/policy.mjs").PolicySource} source the resolved policy source, named in the refusal
 * @param {number | number[]} supportedMajor the schema major(s) this action understands
 * @returns {Record<string, unknown>}
 */
function parsePolicyFile(content, path, source, supportedMajor) {
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
  const raw = /** @type {Record<string, unknown>} */ (parsed);
  assertPolicySchemaVersion({ raw, supportedMajor, path, source });
  return raw;
}
