#!/usr/bin/env node
/**
 * Invariant I3 — the forge monopoly.
 *
 * Two facts hold the write path together: GitHub writes (non-GET HTTP verbs)
 * may be issued only where the repository's write logic lives, and the
 * GitHub-write surface is exactly what a frozen manifest declares. This gate
 * enforces both halves:
 *
 *   1. A non-GET verb (`method: "POST" | "PATCH" | "PUT" | "DELETE"`) in call
 *      position may appear only in core/src/forge.mjs, core/src/chat.mjs
 *      (the provider POST) or core/transport/ (the seam). The list is
 *      literal, not derived, so a new file cannot join it unnoticed.
 *   2. security/forge-ops.json is the frozen declaration of the forge's
 *      GitHub-write surface, diffed in BOTH directions against the export
 *      surface extractForgeOps() reads off createForge's return object — in
 *      declaration order. An op the manifest does not declare, an op the
 *      manifest names that the surface does not have, and a reordering are
 *      all findings: the manifest is what a reviewer reads to know what the
 *      actions can do to a consumer repository.
 *
 * Test files are skipped by the verb scan, deliberately and narrowly: the
 * I2 import rule already makes a test module unimportable by production
 * code, and the raw-HTTP monopoly means a verb literal alone cannot reach
 * the wire outside the seam. core/src/forge.test.mjs asserts with a
 * `method: "DELETE"` literal in a toMatchObject — inert, and skipped here
 * rather than excluded everywhere.
 *
 * Usage:
 *   node tools/check-forge-monopoly.mjs           judge the real tree
 *   node tools/check-forge-monopoly.mjs <dir>     judge a fixture tree
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lineOf, maskCode } from "./code-scan.mjs";

/** The exact files and the one directory a non-GET verb may live in. */
const VERB_ALLOWED_FILES = ["core/src/forge.mjs", "core/src/chat.mjs"];
const VERB_ALLOWED_DIR = "core/transport";

/**
 * Scanned roots: every .mjs under them, regardless of filename.
 */
const SCAN_ROOTS = "core/src core/transport triage/src review/src harmonise/src".split(" ");

/**
 * Verbs the monopoly forbids outside the allowed positions. Matched
 * case-insensitively and reported as written: a lowercase literal would
 * still be a non-GET verb on the wire.
 */
const FORBIDDEN_VERBS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Verbs, read from the original text after a masked `method:` key. */
const METHOD_KEY = /method\s*:/g;

/**
 * The forge's GitHub-write surface, read off createForge's return object in
 * declaration order: the first two-space-indented `return {` after the
 * `export function createForge` line, whose members are four-space-indented
 * `(async )?name(` lines. Returns null when no such return object exists —
 * the gate fails closed on a forge whose shape it cannot read.
 *
 * @param {string} forgeSource the full text of core/src/forge.mjs
 * @returns {string[] | null} op names, declaration order
 */
export function extractForgeOps(forgeSource) {
  const lines = forgeSource.split("\n");
  const returnAt = lines.findIndex((line) => /^ {2}return \{$/.test(line));
  if (returnAt === -1) return null;
  /** @type {string[]} */
  const ops = [];
  for (let i = returnAt + 1; i < lines.length; i += 1) {
    if (/^ {2}};$/.test(lines[i])) break;
    const m = lines[i].match(/^ {4}(async )?(\w+)\(/);
    if (m && m[2]) ops.push(m[2]);
  }
  return ops;
}

/**
 * Whether `path` may carry a non-GET verb.
 *
 * @param {string} path repo-relative path of the module
 * @returns {boolean}
 */
export function isVerbAllowedPath(path) {
  return (
    VERB_ALLOWED_FILES.includes(path) ||
    path === VERB_ALLOWED_DIR ||
    path.startsWith(VERB_ALLOWED_DIR + "/")
  );
}

/**
 * Whether `path` is scanned by this gate.
 *
 * @param {string} path repo-relative path
 * @returns {boolean}
 */
export function isScannedPath(path) {
  return SCAN_ROOTS.some((root) => path === root || path.startsWith(root + "/"));
}

/**
 * The verb a `method:` key carries, read from the original text at the
 * offset the masked text names: the masked colon position plus the quoted
 * literal read from the original. Returns null when no quoted literal
 * follows — a computed verb, which the gate refuses rather than guesses.
 *
 * @param {string} source original module text
 * @param {string} masked code-only mask of the same text
 * @param {number} keyEnd offset just past the colon of a `method:` key
 * @returns {string | null} the verb as written, or null
 */
export function methodLiteral(source, masked, keyEnd) {
  let j = keyEnd;
  while (j < source.length && source[j] === " ") j += 1;
  const quote = source[j];
  if (quote !== '"' && quote !== "'") return null;
  let k = j + 1;
  let raw = "";
  while (k < source.length && source[k] !== quote) {
    if (source[k] === "\\") {
      k += 2;
      continue;
    }
    if (source[k] === "\n") return null;
    raw += source[k];
    k += 1;
  }
  return raw;
}

/**
 * Judges the module list plus the forge surface and its frozen manifest.
 * Pure: reads no filesystem.
 *
 * @param {{ modules: { path: string, source: string }[], forgeSource: string | null, manifest: unknown }} input
 * @returns {{ failures: string[], modulesScanned: number }}
 */
export function evaluate({ modules, forgeSource, manifest }) {
  /** @type {string[]} */
  const failures = [];

  const ops = forgeSource === null ? null : extractForgeOps(forgeSource);
  if (ops === null) {
    failures.push(
      "core/src/forge.mjs:0: createForge's return object could not be read — the gate fails closed (invariant I3)",
    );
  }

  const declared = readManifest(manifest, failures);
  if (ops !== null && declared !== null) {
    failures.push(...diffSurface(ops, declared));
  }

  for (const mod of modules) {
    if (isTestModule(mod.path)) continue;
    if (isVerbAllowedPath(mod.path)) continue;
    const masked = maskCode(mod.source);
    for (const m of masked.matchAll(METHOD_KEY)) {
      const verb = methodLiteral(mod.source, masked, m.index + m[0].length);
      const line = lineOf(masked, m.index);
      if (verb === null) {
        failures.push(
          mod.path +
            ":" +
            line +
            ": HTTP method is computed, not a literal the gate can read (invariant I3)",
        );
        continue;
      }
      if (FORBIDDEN_VERBS.has(verb.toUpperCase())) {
        failures.push(
          mod.path +
            ":" +
            line +
            ': non-GET verb "' +
            verb +
            '" outside the forge, chat or transport (invariant I3)',
        );
      }
    }
  }

  return { failures, modulesScanned: modules.length };
}

/**
 * Whether `path` is a test module the verb scan skips.
 *
 * @param {string} path repo-relative path
 * @returns {boolean}
 */
function isTestModule(path) {
  return path.endsWith(".test.mjs");
}

/**
 * Validates the manifest JSON the gate was given, failing closed with a
 * named failure when it is not the shape the invariant requires.
 *
 * @param {unknown} manifest parsed manifest JSON
 * @param {string[]} failures accumulator for named failures
 * @returns {string[] | null} declared ops in declaration order, or null
 */
function readManifest(manifest, failures) {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    failures.push("security/forge-ops.json:0: manifest is not a JSON object (invariant I3)");
    return null;
  }
  const record = /** @type {Record<string, unknown>} */ (manifest);
  if (record["invariant"] !== "I3") {
    failures.push('security/forge-ops.json:0: manifest "invariant" is not "I3" (invariant I3)');
    return null;
  }
  const ops = record["ops"];
  if (!Array.isArray(ops) || !ops.every((op) => typeof op === "string" && op !== "")) {
    failures.push(
      'security/forge-ops.json:0: manifest "ops" is not a list of op names (invariant I3)',
    );
    return null;
  }
  const unique = new Set(ops);
  if (unique.size !== ops.length) {
    failures.push('security/forge-ops.json:0: manifest "ops" contains duplicates (invariant I3)');
    return null;
  }
  return /** @type {string[]} */ (ops);
}

/**
 * The two-directional diff between the declared and the actual surface, in
 * declaration order: anything other than exact equality is a finding, named
 * by direction.
 *
 * @param {string[]} ops actual surface, declaration order
 * @param {string[]} declared manifest ops, declaration order
 * @returns {string[]}
 */
function diffSurface(ops, declared) {
  /** @type {string[]} */
  const failures = [];
  const declaredSet = new Set(declared);
  for (const op of ops) {
    if (!declaredSet.has(op)) {
      failures.push(
        'core/src/forge.mjs:0: forge op "' +
          op +
          '" is not declared in security/forge-ops.json (invariant I3)',
      );
    }
  }
  const opsSet = new Set(ops);
  for (const op of declared) {
    if (!opsSet.has(op)) {
      failures.push(
        'security/forge-ops.json:0: manifest names op "' +
          op +
          '" the forge surface does not have (invariant I3)',
      );
    }
  }
  if (
    failures.length === 0 &&
    (ops.length !== declared.length || ops.some((op, i) => op !== declared[i]))
  ) {
    failures.push(
      "core/src/forge.mjs:0: forge surface and security/forge-ops.json disagree on declaration order (invariant I3)",
    );
  }
  if (failures.length === 0 && ops.length === 0) {
    failures.push(
      "core/src/forge.mjs:0: forge surface is empty — refusing to pass vacuously (invariant I3)",
    );
  }
  return failures;
}

/**
 * Whether this file was RUN rather than imported, compared on real paths.
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

/**
 * Reads and parses the manifest at `path`, or null when absent.
 *
 * @param {string} path manifest path (repo-relative or fixture-relative)
 * @returns {unknown | null}
 */
function readManifestJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error("✗ security/forge-ops.json is not valid JSON: " + String(error));
    process.exit(1);
  }
}

function main() {
  const rootArg = process.argv[2];
  const fixtureMode = rootArg !== undefined;
  /** @type {{ path: string, source: string }[]} */
  const modules = [];

  const forgePath = fixtureMode ? join(rootArg, "core/src/forge.mjs") : "core/src/forge.mjs";
  const manifestPath = fixtureMode
    ? join(rootArg, "security/forge-ops.json")
    : "security/forge-ops.json";
  if (!existsSync(forgePath)) {
    console.error("✗ " + forgePath + " not found — the gate fails closed");
    process.exit(1);
  }
  const forgeSource = readFileSync(forgePath, "utf8");
  if (fixtureMode) {
    collectModules(rootArg, "", modules);
  } else {
    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) {
        console.error("✗ scan root missing — run this gate from the repository root: " + root);
        process.exit(1);
      }
      collectModules(root, root + "/", modules);
    }
    for (const root of SCAN_ROOTS) {
      if (!modules.some((mod) => mod.path.startsWith(root + "/"))) {
        console.error("✗ scan root produced no modules — refusing to pass vacuously: " + root);
        process.exit(1);
      }
    }
  }

  const manifest = readManifestJson(manifestPath);
  if (manifest === null) {
    console.error("✗ " + manifestPath + " not found — the frozen declaration is missing");
    process.exit(1);
  }

  const { failures, modulesScanned } = evaluate({
    modules,
    forgeSource,
    manifest,
  });
  if (failures.length > 0) {
    for (const f of failures) console.error("✗ " + f);
    console.error(
      "\n" +
        String(failures.length) +
        " forge-monopoly violation(s) across " +
        String(modulesScanned) +
        " modules.",
    );
    process.exit(1);
  }

  const ops = extractForgeOps(forgeSource) ?? [];
  console.log(
    "✔ " +
      String(modulesScanned) +
      " modules scanned, forge surface frozen at " +
      String(ops.length) +
      " ops (invariant I3 holds)",
  );
}

/**
 * Collects every .mjs under `dir`, recursively, skipping node_modules and
 * .git. Paths are reported relative to the scanned root.
 *
 * @param {string} dir directory to walk
 * @param {string} prefix reported-path prefix
 * @param {{ path: string, source: string }[]} out collected modules
 */
function collectModules(dir, prefix, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const at = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectModules(at, prefix + entry.name + "/", out);
    } else if (entry.name.endsWith(".mjs")) {
      out.push({ path: prefix + entry.name, source: readFileSync(at, "utf8") });
    }
  }
}

if (isProgramEntry(import.meta.url)) main();
