#!/usr/bin/env node
/**
 * Holds every `action.yaml` and the code behind it to the same list of inputs.
 *
 * An action's manifest is the only contract a consumer can read. The runner
 * enforces nothing: an input a workflow passes that the manifest never declared
 * is a warning in a log nobody opens, and an input the manifest declares that no
 * code reads is silently ignored. Both directions are a lie told to somebody
 * writing a workflow, and neither is visible to `pnpm lint`, `typecheck`, `arch`
 * or `test` — every one of them was green while `review/src/index.mjs` read a
 * `dry-run` that `review/action.yaml` did not offer.
 *
 * That is the defect this gate exists for, and it is why it judges BOTH
 * directions. A manifest that over-promises and one that under-declares fail
 * the same way from the reader's chair.
 *
 * HOW THE READ SET IS BUILT, and the one coupling that is not local. Inputs are
 * read through the four helpers in `core/src/runtime.mjs`, so a scan for
 * `getInput("…")`, `getBooleanInput("…")`, `getNumberInput("…")` and
 * `getListInput("…")` over an action's own `src/` finds what that action reads
 * directly. It does not find the four shared inputs, because those are read one
 * layer down in `core/src/inputs.mjs` on the action's behalf. So: an action
 * whose source mentions `readSharedInputs` is credited with every input name
 * found in that file.
 *
 * The limitation in that rule is worth stating rather than discovering. It
 * treats `core/src/inputs.mjs` as ONE bundle. If core ever grows a second
 * reader with a different set — `readReviewInputs` beside `readSharedInputs` —
 * this rule starts crediting an action with inputs it never reads, and must be
 * split per exported function at that point.
 *
 * WHAT A DYNAMIC NAME DOES. `getInput(name)` where `name` is a variable is
 * invisible to a text scan, and a scan that cannot see a read would report the
 * manifest's declaration as unread — a false failure — or miss a real one. It
 * is reported as a failure naming the line instead, because the honest answer
 * is that this gate cannot judge that action at all.
 *
 * WHY ZERO IS A FAILURE. Finding no actions, or finding an action that reads no
 * inputs, means the scan stopped reading the thing it exists to read — a
 * renamed helper, a moved directory, a manifest whose `inputs:` block is
 * spelled differently. A gate that reports green over nothing gets trusted, so
 * an empty scan goes red.
 *
 * The facts are gathered by the readers at the bottom; the judgment is the pure
 * function `evaluate`, which takes them as arguments, so the tests need no
 * repository and no mocking library.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The four readers in `core/src/runtime.mjs`, with a string-literal name. */
export const READ = /\bget(?:Boolean|Number|List)?Input\(\s*(?:"([^"]+)"|'([^']+)')/g;
/**
 * The same call with anything else as its first argument. The whitespace sits
 * INSIDE the lookahead on purpose: written as `\(\s*(?!["'])` the engine
 * backtracks `\s*` to zero and the assertion passes against the newline, so
 * every call Prettier split across lines reads as a dynamic name.
 */
export const READ_DYNAMIC = /\bget(?:Boolean|Number|List)?Input\((?!\s*["'])/g;
/** A key of the manifest's `inputs:` block: two spaces, a name, nothing after. */
export const DECLARED_KEY = /^ {2}([a-z][a-z0-9-]*):\s*$/;
/** The manifests an action may ship under. GitHub accepts either spelling. */
export const MANIFEST_NAMES = ["action.yaml", "action.yml"];
/** The function in `core/src/inputs.mjs` that reads on an action's behalf. */
export const SHARED_READER = "readSharedInputs";

/**
 * @typedef {object} SourceFile
 * @property {string} path path as it should be reported
 * @property {string} text the file's contents
 */

/**
 * @typedef {object} ActionFacts
 * @property {string} name the action's directory
 * @property {string} manifestPath path of the manifest, for reporting
 * @property {string[]} declared input names the manifest offers, in file order
 * @property {SourceFile[]} sources the action's own non-test source files
 */

/**
 * Every input name a file reads by string literal.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function readNames(text) {
  return [...text.matchAll(READ)].map((match) => match[1] ?? match[2] ?? "");
}

/**
 * The `inputs:` block of a manifest, as a list of names.
 *
 * Hand-parsed rather than taken from a YAML library, because this repository
 * ships no runtime dependency and adding a development one to read four short
 * files would be the wrong trade. The block is delimited the way YAML delimits
 * it: it starts at a top-level `inputs:` and ends at the next line that is
 * neither blank nor indented.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseDeclared(text) {
  /** @type {string[]} */
  const names = [];
  let inside = false;
  for (const line of text.split(/\n/)) {
    if (/^inputs:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (line.trim() === "") continue;
    if (!line.startsWith(" ")) break;
    const match = DECLARED_KEY.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

/**
 * @param {object} input
 * @param {ActionFacts[]} input.actions
 * @param {SourceFile} input.sharedInputs `core/src/inputs.mjs`
 * @returns {{ failures: string[], actions: number, inputs: number }}
 */
export function evaluate({ actions, sharedInputs }) {
  /** @type {string[]} */
  const failures = [];
  const shared = new Set(readNames(sharedInputs.text));

  if (shared.size === 0) {
    failures.push(
      `${sharedInputs.path}: no input read found. The shared reader is where every ` +
        `action gets github-token, api-url, api-key and model, so a scan that finds ` +
        `none of them has stopped matching how inputs are read.`,
    );
  }

  let inputs = 0;

  for (const action of actions) {
    /** @type {Set<string>} */
    const read = new Set();
    let creditedShared = false;

    for (const source of action.sources) {
      for (const name of readNames(source.text)) read.add(name);

      if (source.text.includes(SHARED_READER)) {
        creditedShared = true;
        for (const name of shared) read.add(name);
      }

      // Scanned over the whole file rather than line by line: Prettier splits a
      // long call so `getInput(` ends one line and its literal opens the next,
      // and a per-line test reads that as a name it cannot see.
      for (const match of source.text.matchAll(READ_DYNAMIC)) {
        const line = source.text.slice(0, match.index).split(/\n/).length;
        failures.push(
          `${source.path}:${String(line)}: an input is read with a name this gate ` +
            `cannot see. Pass a string literal, or ${action.name} cannot be checked ` +
            `against its manifest at all.`,
        );
      }
    }

    if (read.size === 0) {
      failures.push(
        `${action.name}: reads no input at all. Either the action stopped reading its ` +
          `inputs, or this gate's READ pattern no longer matches how they are read.`,
      );
      continue;
    }
    inputs += read.size;

    for (const name of read) {
      if (!action.declared.includes(name)) {
        failures.push(
          `${action.name}: reads '${name}', which ${action.manifestPath} does not declare. ` +
            `A workflow passing it gets a warning from the runner and nothing else; ` +
            `declare it${shared.has(name) && creditedShared ? " — it comes from the shared reader" : ""}.`,
        );
      }
    }

    for (const name of action.declared) {
      if (!read.has(name)) {
        failures.push(
          `${action.name}: ${action.manifestPath} declares '${name}', which no code reads. ` +
            `A workflow setting it would be silently ignored; read it, or remove it.`,
        );
      }
    }
  }

  // See "WHY ZERO IS A FAILURE" in this file's header.
  if (actions.length === 0) {
    failures.push(
      "no action directory was found. An action is a directory holding an " +
        `${MANIFEST_NAMES.join(" or ")}, and finding none means this gate read nothing.`,
    );
  }

  return { failures, actions: actions.length, inputs };
}

/**
 * Every directory at the repository root holding a manifest.
 *
 * @returns {ActionFacts[]}
 */
function readActions() {
  /** @type {ActionFacts[]} */
  const actions = [];
  for (const entry of readdirSync(".", { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifestName = MANIFEST_NAMES.find((name) => existsSync(join(entry.name, name)));
    if (manifestName === undefined) continue;
    const manifestPath = join(entry.name, manifestName);
    actions.push({
      name: entry.name,
      manifestPath,
      declared: parseDeclared(readFileSync(manifestPath, "utf8")),
      sources: readSources(join(entry.name, "src")),
    });
  }
  return actions;
}

/**
 * An action's own source, tests excluded — a test naming an input is describing
 * a read rather than performing one.
 *
 * @param {string} dir
 * @returns {SourceFile[]}
 */
function readSources(dir) {
  if (!existsSync(dir)) return [];
  /** @type {SourceFile[]} */
  const files = [];
  for (const entry of readdirSync(dir, { recursive: true })) {
    const rel = String(entry);
    if (!rel.endsWith(".mjs") || rel.endsWith(".test.mjs")) continue;
    const path = join(dir, rel);
    files.push({ path, text: readFileSync(path, "utf8") });
  }
  return files;
}

function main() {
  const path = join("core", "src", "inputs.mjs");
  const { failures, actions, inputs } = evaluate({
    actions: readActions(),
    sharedInputs: { path, text: readFileSync(path, "utf8") },
  });

  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    console.error(`\n${String(failures.length)} manifest/code input mismatch(es).`);
    process.exit(1);
  }

  console.log(
    `✔ ${String(actions)} action manifest(s) match the code behind them ` +
      `(${String(inputs)} input read(s) checked)`,
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
