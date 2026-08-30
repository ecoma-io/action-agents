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
 * WHAT DEFAULT AND REQUIRED MEAN. Names are only half the contract. The
 * manifest's `required:` flag and `default:` value are what a consumer reads
 * off the manifest; the code's options literal is what actually happens. A
 * manifest that says `required: true` while the code reads the input
 * optionally forces a value the code is fine without, and a manifest that
 * leaves an input optional while the code's reader throws on absence
 * (a `getNumberInput` with no default) crashes the workflow that followed
 * the manifest. Defaults lie the same way in both directions: a default the
 * manifest promises but the code does not apply is a value that never lands,
 * and a default the code applies but the manifest never declares is a
 * behaviour nobody can see. The gate therefore compares both, treating an
 * empty string and an empty list as "no default" — a manifest `default: ""`
 * and a bare `getInput` describe the same behaviour.
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
 * @property {ManifestInput[]} manifest the manifest's per-input facts
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
 * A call of one of the four input readers, opening paren included. Matched
 * over the whole file; the argument list is scanned from the paren rather
 * than captured, because the name can sit on the next line after Prettier
 * wraps the call.
 */
export const INPUT_CALL = /\bget(?:Boolean|Number|List)?Input\(/g;

/**
 * @typedef {object} InputRead
 * @property {string} name the literal input name, unquoted
 * @property {"getInput" | "getBooleanInput" | "getNumberInput" | "getListInput"} kind
 * @property {string} options the options argument's raw text, or "" — enough
 *   for `optionsSemantics` to judge required/default against the manifest
 */

/**
 * Splits one call's argument list into raw texts, honouring nested brackets
 * and quoted strings, so an options object an edit spreads across lines is
 * still one fact rather than an unreadable one.
 *
 * @param {string} text
 * @param {number} open index of the "(" that opens the call
 * @returns {string[]}
 */
function scanArgs(text, open) {
  /** @type {string[]} */
  const args = [];
  let depth = 0;
  let current = "";
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      current += ch;
      if (ch === "\\") {
        current += text[i + 1] ?? "";
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    // Brackets only change depth; they never become argument text, so the
    // opening "(" of the call and the closing ")" are not captured into the
    // first and last argument.
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  return args;
}

/**
 * Every named input a file reads, with the options literal of each read.
 * A call whose first argument is not a string literal is skipped here and
 * reported by the READ_DYNAMIC scan instead — this gate's job is judging
 * literals, and guessing at a dynamic name would fabricate the fact it then
 * judged.
 *
 * @param {string} text
 * @returns {InputRead[]}
 */
export function readInputReads(text) {
  /** @type {InputRead[]} */
  const reads = [];
  for (const match of text.matchAll(INPUT_CALL)) {
    const args = scanArgs(text, match.index + match[0].length - 1);
    const raw = (args[0] ?? "").trim();
    if (raw === "" || !/^["'`]/.test(raw)) continue;
    reads.push({
      name: unquote(raw),
      kind:
        /** @type {"getInput" | "getBooleanInput" | "getNumberInput" | "getListInput"} */
        (match[0].slice(0, -1)),
      options: args[1] ?? "",
    });
  }
  return reads;
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const text = value.trim();
  if (
    text.length >= 2 &&
    (text[0] === '"' || text[0] === "'" || text[0] === "`") &&
    text[text.length - 1] === text[0]
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * What an options literal actually promises: whether the reader throws when
 * the input is absent, and the default it applies, normalised. A
 * `getNumberInput` with no default throws on absence — that is `required`
 * from the code's side even though the helper takes no `required` flag.
 *
 * @param {string} options
 * @param {"getInput" | "getBooleanInput" | "getNumberInput" | "getListInput"} [kind]
 * @returns {{ required: boolean, default: string }}
 */
export function optionsSemantics(options, kind = "getInput") {
  const literal = defaultLiteral(options);
  const defaults = literal === "" ? "" : normaliseDefault(literal);
  const codeRequired =
    /\brequired\s*:\s*true\b/.test(options) || (kind === "getNumberInput" && defaults === "");
  return { required: codeRequired, default: defaults };
}

/**
 * The text of the `default:` value out of an options literal, quoted or not,
 * spanning lines, stopping at the first comma or bracket that is not inside
 * a string. "" when the literal has no default.
 *
 * @param {string} options
 * @returns {string}
 */
function defaultLiteral(options) {
  const index = options.search(/\bdefault\s*:/);
  if (index === -1) return "";
  let i = options.indexOf(":", index) + 1;
  while (i < options.length && /\s/.test(options[i])) i++;
  let quote = null;
  let out = "";
  for (; i < options.length; i++) {
    const ch = options[i];
    if (quote !== null) {
      out += ch;
      if (ch === "\\") {
        out += options[i + 1] ?? "";
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "," || ch === "}" || ch === "]") break;
    out += ch;
  }
  return out.trim();
}

/**
 * The comparable form of a default value: quotes and numeric underscores
 * stripped, an empty list reduced to the empty string so `getListInput`
 * `{ default: [] }` reads the same as the manifest's `default: ""`.
 *
 * @param {string} value
 * @returns {string}
 */
function normaliseDefault(value) {
  let text = value.trim().replace(/_/g, "");
  if (text.startsWith("[")) return "";
  if (text === "undefined" || text === "null") return "";
  if (
    text.length >= 2 &&
    (text[0] === '"' || text[0] === "'") &&
    text[text.length - 1] === text[0]
  ) {
    text = text.slice(1, -1);
  }
  return text;
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
 * @typedef {object} ManifestInput
 * @property {string} name
 * @property {boolean} required what the manifest promises: default false
 * @property {string} default the declared default, unquoted and with the
 *   same empty-string equivalence the code side uses; "" when none is
 *   declared or it is explicitly the empty string
 */

/**
 * The `inputs:` block of a manifest, as the facts a consumer reads off it.
 * The block is delimited the same way `parseDeclared` delimits it; within an
 * entry only the 4-space `required:` and `default:` lines are facts, so a
 * description whose prose happens to contain "default:" is never read as
 * one.
 *
 * @param {string} text
 * @returns {ManifestInput[]}
 */
export function parseManifest(text) {
  /** @type {ManifestInput[]} */
  const inputs = [];
  /** @type {ManifestInput | null} */
  let current = null;
  let inside = false;
  for (const line of text.split(/\n/)) {
    if (/^inputs:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (line.trim() === "") continue;
    if (!line.startsWith(" ")) {
      if (current !== null) {
        inputs.push(current);
        current = null;
      }
      break;
    }
    const inputMatch = DECLARED_KEY.exec(line);
    if (inputMatch?.[1] !== undefined) {
      if (current !== null) inputs.push(current);
      current = { name: inputMatch[1], required: false, default: "" };
      continue;
    }
    if (current === null) continue;
    const requiredMatch = /^ {4}required:\s*(true|false)\s*$/.exec(line);
    if (requiredMatch?.[1] !== undefined) {
      current.required = requiredMatch[1] === "true";
      continue;
    }
    const defaultMatch = /^ {4}default:\s*(\S.*?)\s*$/.exec(line);
    if (defaultMatch?.[1] !== undefined) {
      current.default = normaliseDefault(unquote(defaultMatch[1]));
    }
  }
  if (current !== null) inputs.push(current);
  return inputs;
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
  const sharedReads = readInputReads(sharedInputs.text);
  const shared = new Set(sharedReads.map((read) => read.name));
  /** @type {Map<string, { required: boolean, default: string }>} */
  const sharedFacts = new Map(
    sharedReads.map((read) => [read.name, optionsSemantics(read.options, read.kind)]),
  );

  if (shared.size === 0) {
    failures.push(
      `${sharedInputs.path}: no input read found. The shared reader is where every ` +
        `action gets github-token, api-url, api-key and model, so a scan that finds ` +
        `none of them has stopped matching how inputs are read.`,
    );
  }

  // The shared reader is scanned for dynamic names too — a renamed helper
  // there would be invisible to the per-action loop below.
  for (const match of sharedInputs.text.matchAll(READ_DYNAMIC)) {
    const line = sharedInputs.text.slice(0, match.index).split(/\n/).length;
    failures.push(
      `${sharedInputs.path}:${String(line)}: an input is read with a name this gate ` +
        `cannot see. Pass a string literal, or no action can be checked ` +
        `against its manifest at all.`,
    );
  }

  let inputs = 0;

  for (const action of actions) {
    /** @type {Set<string>} */
    const read = new Set();
    /** @type {Map<string, { required: boolean, default: string }>} */
    const codeFacts = new Map();
    let creditedShared = false;

    for (const source of action.sources) {
      for (const inputRead of readInputReads(source.text)) {
        read.add(inputRead.name);
        codeFacts.set(inputRead.name, optionsSemantics(inputRead.options, inputRead.kind));
      }

      if (source.text.includes(SHARED_READER)) {
        creditedShared = true;
        for (const [name, facts] of sharedFacts) {
          read.add(name);
          codeFacts.set(name, facts);
        }
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

    // Default and required are a second lie dimension: the manifest is what a
    // consumer reads, the options literal is what runs. An empty manifest
    // entry list is tolerated so callers that only pass names get no
    // comparison at all; the real readActions always supplies it.
    const manifestFacts = new Map((action.manifest ?? []).map((entry) => [entry.name, entry]));
    for (const [name, code] of codeFacts) {
      const declared = manifestFacts.get(name);
      if (declared === undefined) continue; // the name checks above reported it
      if (code.required !== declared.required) {
        failures.push(
          code.required
            ? `${action.name}: '${name}' is required by the code (the reader throws when it ` +
                `is absent) but ${action.manifestPath} does not mark it required — a workflow ` +
                `that follows the manifest crashes at runtime.`
            : `${action.name}: '${name}' is marked required in ${action.manifestPath} but the ` +
                `code reads it as optional — the manifest demands a value the code is fine without.`,
        );
      }
      if (code.default !== declared.default) {
        failures.push(
          declared.default === ""
            ? `${action.name}: '${name}' applies a default the manifest does not declare: the ` +
                `code defaults it to '${code.default}' but ${action.manifestPath} declares none.`
            : code.default === ""
              ? `${action.name}: '${name}' is declared in ${action.manifestPath} with default ` +
                `'${declared.default}' but the code applies no default — a workflow that omits ` +
                `it gets the code's empty-or-throw behaviour, not the promised value.`
              : `${action.name}: '${name}' default differs: ${action.manifestPath} declares ` +
                `'${declared.default}' but the code applies '${code.default}'.`,
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
    const manifestText = readFileSync(manifestPath, "utf8");
    actions.push({
      name: entry.name,
      manifestPath,
      declared: parseDeclared(manifestText),
      manifest: parseManifest(manifestText),
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
