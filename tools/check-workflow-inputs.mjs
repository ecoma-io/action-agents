#!/usr/bin/env node
/**
 * Holds the workflows under `.github/workflows` to the manifests of the actions
 * they run.
 *
 * `check-action-inputs` holds every `action.yaml` against the code behind it.
 * Nothing held the workflows to the manifests. A `with:` key the manifest never
 * declared reaches the action as a runner warning nobody reads, and a
 * `required: true` input no step passes fails only when a run actually starts —
 * both directions of drift were invisible to `pnpm lint`, `typecheck`, `arch`
 * and `test` alike, and every one of them was green while the gap existed.
 *
 * THE PARSER. No YAML library: this repository ships no runtime dependency, and
 * adding a development one to read a handful of workflow files would be the
 * wrong trade. What reads the files is a line/state machine over the shapes
 * these files actually use, and its assumptions are load-bearing:
 *
 * - indentation is spaces only (tabs are invalid YAML indentation anyway);
 * - mappings are `key:` or `key: value` — the space after the colon is required,
 *   as YAML requires it; keys are unquoted single words;
 * - sequence items are `- ` lines. Both spellings of a step are read the same:
 *   the inline key (`- uses: ./review`) and continuation keys at the dash's
 *   indent plus two (`with:` under it);
 * - a block scalar (`|` or `>`, with its modifiers) consumes every line deeper
 *   than the key that introduced it, so a shell script or a folded prose value
 *   is never read as structure;
 * - `#` starts a comment at line start or after a space, outside quotes. The
 *   one case this does not see is `#` inside an unquoted `${{ }}` expression,
 *   which no workflow in this tree contains;
 * - flow style (`[a, b]`, `{k: v}`) is tolerated as an opaque scalar value and
 *   never descended into — no check needs anything inside one;
 * - anything else — a line that is neither mapping, item nor block content — is
 *   reported as a failure naming file and line rather than skipped, because a
 *   line the gate cannot read may be hiding the very drift it exists to catch.
 *
 * Manifests are read from disk at run time and no input name is hard-coded: an
 * action that grows an input, or a workflow that starts passing one, is judged
 * against what the files say, not against this file's idea of them.
 *
 * WHY ZERO IS A FAILURE. Finding no workflow file, or no step running a local
 * action, means the gate stopped reading the thing it exists to read — a moved
 * directory, a renamed trigger, a glob that matches nothing. A gate that
 * reports green over nothing gets trusted anyway, so an empty scan goes red.
 *
 * The facts are gathered by the readers at the bottom; the judgment is the pure
 * function `evaluate`, which takes them as arguments, so the tests need no
 * repository and no mocking library.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The manifests an action may ship under. GitHub accepts either spelling. */
export const MANIFEST_NAMES = ["action.yaml", "action.yml"];
/** The directory the repository's own workflows live in. */
export const WORKFLOWS_DIR = join(".github", "workflows");
/** The file spellings GitHub loads as workflows. */
export const WORKFLOW_SUFFIXES = [".yml", ".yaml"];
/** A `uses:` value starting with this runs an action from this repository. */
const LOCAL = "./";

/** A mapping entry: `key:` alone, or `key: value`. YAML requires the space. */
const KEY = /^([^:\s]+):(?: +(.*))?$/;
/** A value that opens a block scalar; every deeper line belongs to it. */
const BLOCK = /^[|>][+-]?[0-9]*$/;

/**
 * A node of the parsed structure. Sequence items carry `key: null` and hold
 * their mapping entries as children; a bare scalar item carries `value`.
 *
 * @typedef {object} YamlNode
 * @property {number} indent the line's indentation, for the state machine
 * @property {string | null} key the mapping key, or null for a sequence item
 * @property {string | null} value the inline scalar, if any
 * @property {YamlNode[]} children nested entries, in file order
 */

/**
 * @typedef {object} ParseError
 * @property {number} line 1-based line number
 * @property {string} text the line the parser could not classify
 */

/**
 * @typedef {object} StepFacts
 * @property {string} job the enclosing job's key
 * @property {number} index 1-based position within the job's steps
 * @property {string | null} name the step's `name:`, for failure messages
 * @property {string | null} uses the `uses:` value, unquoted, or null
 * @property {string[]} withKeys the step's `with:` keys, in file order
 */

/**
 * @typedef {object} WorkflowFacts
 * @property {string} path path as it should be reported
 * @property {{ id: string, steps: StepFacts[] }[]} jobs
 * @property {ParseError[]} errors lines the parser could not classify
 */

/**
 * @typedef {object} InputFacts
 * @property {string} name
 * @property {boolean} required
 */

/**
 * @typedef {object} ManifestFacts
 * @property {string} action the action's directory — the pin path `./<action>`
 * @property {string} path path as it should be reported
 * @property {InputFacts[]} inputs declared inputs, in file order
 * @property {ParseError[]} errors lines the parser could not classify
 */

/**
 * The one mapping entry a line carries, or null when the line is not one.
 *
 * @param {string} content the line, comment-stripped and trimmed
 * @param {number} indent the indentation to record on the node
 * @returns {YamlNode | null}
 */
function readKey(content, indent) {
  const match = KEY.exec(content);
  if (match === null) return null;
  return {
    indent,
    key: match[1] ?? "",
    value: match[2] === undefined ? null : (match[2] ?? ""),
    children: [],
  };
}

/**
 * A `#` starts a comment at line start or after a space, outside quotes.
 *
 * @param {string} line
 * @returns {string} the line with any comment stripped, right-trimmed
 */
function stripComment(line) {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    else if (c === "#" && !single && !double && (i === 0 || line[i - 1] === " ")) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

/**
 * Parses the workflow/manifest subset of YAML into a tree.
 *
 * @param {string} text
 * @returns {{ root: YamlNode, errors: ParseError[] }}
 */
function parseStructure(text) {
  const root = { indent: -1, key: null, value: null, children: [] };
  const stack = [root];
  /** @type {ParseError[]} */
  const errors = [];
  /** The block scalar currently being consumed, if any. */
  let block = null;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i] ?? "");
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    // Deeper than the key that opened a block scalar: scalar text, not
    // structure. Anything at that key's indent or shallower ends it.
    if (block !== null) {
      if (indent > block.indent) continue;
      block = null;
    }

    const parent = () => stack[stack.length - 1] ?? root;

    if (content === "-" || content.startsWith("- ")) {
      while (stack.length > 1 && parent().indent >= indent) stack.pop();
      /** @type {YamlNode} */
      const item = { indent, key: null, value: null, children: [] };
      parent().children.push(item);
      // The item anchors the stack at the dash's indent, so a continuation key
      // at dash + 2 (`with:` under `- uses:`) lands inside the item, and the
      // next `- ` at the dash's indent closes it.
      stack.push(item);
      const inner = content === "-" ? "" : content.slice(2).trim();
      if (inner !== "") {
        const entry = readKey(inner, indent + 2);
        if (entry === null) {
          item.value = inner;
        } else {
          item.children.push(entry);
          if (entry.value !== null && BLOCK.test(entry.value)) block = entry;
          else stack.push(entry);
        }
      }
      continue;
    }

    while (stack.length > 1 && parent().indent >= indent) stack.pop();
    const entry = readKey(content, indent);
    if (entry === null) {
      errors.push({ line: i + 1, text: content });
      continue;
    }
    parent().children.push(entry);
    if (entry.value !== null && BLOCK.test(entry.value)) block = entry;
    else stack.push(entry);
  }

  return { root, errors };
}

/**
 * Matching quotes around a scalar are spelling, not content.
 *
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * A manifest's `inputs:` block, with each input's `required` flag. The action's
 * name comes from the path: `./<action>` pins a DIRECTORY, so the directory —
 * the manifest path's first segment, on either separator, because `collect`'s
 * `join` emits backslashes on win32 — is the contract's owner, not the
 * manifest's display `name:`.
 *
 * @param {string} text
 * @param {string} path
 * @returns {ManifestFacts}
 */
export function parseManifest(text, path) {
  const { root, errors } = parseStructure(text);
  const inputs = root.children.find((child) => child.key === "inputs");
  return {
    action: path.split(/[\\/]/)[0] ?? path,
    path,
    inputs: (inputs?.children ?? []).map((child) => ({
      name: child.key ?? "",
      required: child.children.some((flag) => flag.key === "required" && flag.value === "true"),
    })),
    errors,
  };
}

/**
 * Every job's steps of one workflow file, with each step's `uses:` and `with:`
 * keys. Steps that use no action still appear — the index is the step's
 * position, which is how a failure names it.
 *
 * @param {string} text
 * @param {string} path
 * @returns {WorkflowFacts}
 */
export function parseWorkflow(text, path) {
  const { root, errors } = parseStructure(text);
  const jobs = root.children.find((child) => child.key === "jobs");
  return {
    path,
    jobs: (jobs?.children ?? []).map((job) => {
      const steps = job.children.find((child) => child.key === "steps");
      return {
        id: job.key ?? "",
        steps: (steps?.children ?? []).map((item, index) => {
          const uses = item.children.find((child) => child.key === "uses");
          const withNode = item.children.find((child) => child.key === "with");
          const name = item.children.find((child) => child.key === "name");
          return {
            job: job.key ?? "",
            index: index + 1,
            name: name?.value === undefined || name?.value === null ? null : unquote(name.value),
            uses: uses?.value === undefined || uses?.value === null ? null : unquote(uses.value),
            withKeys: (withNode?.children ?? []).map((child) => child.key ?? ""),
          };
        }),
      };
    }),
    errors,
  };
}

/**
 * @param {object} input
 * @param {WorkflowFacts[]} input.workflows
 * @param {ManifestFacts[]} input.manifests
 * @returns {{ failures: string[], workflows: number, steps: number, keys: number }}
 */
export function evaluate({ workflows, manifests }) {
  /** @type {string[]} */
  const failures = [];
  const byAction = new Map(manifests.map((manifest) => [manifest.action, manifest]));

  for (const wf of workflows) {
    for (const error of wf.errors) {
      failures.push(
        `${wf.path}:${String(error.line)}: a line this gate cannot parse (\`${error.text}\`). ` +
          `A line it cannot read may be hiding the very drift it exists to catch.`,
      );
    }
  }
  for (const manifest of manifests) {
    for (const error of manifest.errors) {
      failures.push(
        `${manifest.path}:${String(error.line)}: a line this gate cannot parse ` +
          `(\`${error.text}\`). An unread line may be hiding an input, so the manifest cannot be judged.`,
      );
    }
  }

  // See "WHY ZERO IS A FAILURE" in this file's header.
  if (workflows.length === 0) {
    failures.push(
      `no workflow file was found under ${WORKFLOWS_DIR}. ` +
        `A gate that read nothing and reported green would be trusted anyway, so an empty scan goes red.`,
    );
  }

  let steps = 0;
  let keys = 0;
  /** Every `with:` key any step passed to each action, across all workflows. */
  const passed = new Map();

  for (const wf of workflows) {
    for (const job of wf.jobs) {
      for (const step of job.steps) {
        if (step.uses === null || !step.uses.startsWith(LOCAL)) continue;
        steps += 1;
        const action = step.uses.slice(LOCAL.length);
        const where =
          `${wf.path}, job '${step.job}', step ${String(step.index)}` +
          `${step.name === null ? "" : ` (${step.name})`}`;
        const manifest = byAction.get(action);
        if (manifest === undefined) {
          failures.push(
            `${where} runs './${action}', which has no ${MANIFEST_NAMES.join(" or ")} in this ` +
              `repository. Either the path is wrong or the action ships without a contract; ` +
              `nothing here can check its inputs.`,
          );
          continue;
        }
        const declared = new Set(manifest.inputs.map((input) => input.name));
        const seen = passed.get(action) ?? new Set();
        passed.set(action, seen);
        for (const key of step.withKeys) {
          keys += 1;
          seen.add(key);
          if (!declared.has(key)) {
            failures.push(
              `${where} passes '${key}', which ${manifest.path} does not declare. The runner logs ` +
                `a warning nobody reads and the action never sees the value; declare it or remove it.`,
            );
          }
        }
      }
    }
  }

  if (steps === 0 && workflows.length > 0) {
    failures.push(
      "no step in any workflow runs a local action (a uses: value starting with " +
        `${LOCAL}). Nothing binds the workflows to the manifests, ` +
        `which is the only thing this gate exists to do.`,
    );
  }

  // An action no dogfood workflow runs imposes no obligation here — its
  // contract is judged by `check-action-inputs`, and consumers pass its inputs
  // in their own repositories.
  for (const manifest of manifests) {
    const seen = passed.get(manifest.action);
    if (seen === undefined) continue;
    for (const input of manifest.inputs) {
      if (!input.required || seen.has(input.name)) continue;
      failures.push(
        `${manifest.path} requires '${input.name}', but no step in ${WORKFLOWS_DIR} that runs ` +
          `'./${manifest.action}' passes it. The runner starts the action without it and the ` +
          `action fails on its own first read; pass it or make it optional.`,
      );
    }
  }

  return { failures, workflows: workflows.length, steps, keys };
}

/**
 * Every workflow file under `.github/workflows`, and every root-level
 * directory holding a manifest — the same scan `check-action-inputs` does.
 *
 * @returns {{ workflows: WorkflowFacts[], manifests: ManifestFacts[] }}
 */
export function collect() {
  /** @type {ManifestFacts[]} */
  const manifests = [];
  for (const entry of readdirSync(".", { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifestName = MANIFEST_NAMES.find((name) => existsSync(join(entry.name, name)));
    if (manifestName === undefined) continue;
    const path = join(entry.name, manifestName);
    manifests.push(parseManifest(readFileSync(path, "utf8"), path));
  }

  /** @type {WorkflowFacts[]} */
  const workflows = [];
  if (existsSync(WORKFLOWS_DIR)) {
    for (const entry of readdirSync(WORKFLOWS_DIR).sort()) {
      if (!WORKFLOW_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue;
      const path = join(WORKFLOWS_DIR, entry);
      workflows.push(parseWorkflow(readFileSync(path, "utf8"), path));
    }
  }

  return { workflows, manifests };
}

function main() {
  const files = collect();
  const { failures, workflows, steps, keys } = evaluate(files);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    console.error(`\n${String(failures.length)} workflow/manifest input mismatch(es).`);
    process.exit(1);
  }

  console.log(
    `✔ ${String(workflows)} workflow file(s) agree with the manifests behind them over ` +
      `${String(steps)} local step(s) (${String(keys)} with-key(s) checked)`,
  );
}

/**
 * Whether this file was RUN rather than imported, compared on real paths. The
 * same shape as the gates beside it, and not shared with them for the same
 * reason: a helper imported across the gates would make each one's failure
 * depend on a third file.
 *
 * @param {string} moduleUrl
 * @param {string | undefined} [argv1]
 * @returns {boolean}
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (/** @type {string} */ path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();
