#!/usr/bin/env node
/**
 * Validates the release invariants that a consumer-facing release must satisfy.
 *
 * This gate runs against the working tree (in CI and pre-commit) and can also
 * be pointed at a release SHA for post-release verification.  It checks:
 *
 *   1. Root action.yml exists and satisfies the stub contract
 *   2. Every declared child action has a manifest with a resolvable entry point
 *   3. No undocumented action directory exists (surprise surface detection)
 *   4. release-please config and manifest are internally consistent
 *   5. Every consumer-resolvable path (`ecoma-io/action-agents/<X>@<tag>`)
 *      resolves against the tree
 *   6. The root action stub cannot accidentally execute a child action
 *
 * WHY THIS FILE EXISTS.  The release workflow's inline validation runs once
 * at release time and can only fail.  This gate runs on every commit and
 * catches invariant drift _before_ it reaches a release PR.  A broken root
 * stub, a missing manifest, or an undocumented action directory is caught
 * here first.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The public action surfaces: root stub plus every child action. */
export const PUBLIC_ACTIONS = ["root", "triage", "review", "harmonise"];

/** Child actions only (excludes the root stub). */
export const CHILD_ACTIONS = ["triage", "review", "harmonise"];

/** Manifest file names GitHub accepts. */
export const MANIFEST_NAMES = ["action.yaml", "action.yml"];

/** GitHub Marketplace caps the action description at this many characters. */
export const MAX_DESCRIPTION_LENGTH = 125;

/**
 * @param {object} input
 * @param {(path: string) => string} input.read  read a file relative to root
 * @param {(path: string) => boolean} input.exists  check file existence
 * @param {string[]} [input.discoveredDirs]  directories with action.yaml found by the caller
 * @returns {{ failures: string[], checks: number }}
 */
export function evaluate({ read, exists, discoveredDirs = [] }) {
  /** @type {string[]} */
  const failures = [];
  let checks = 0;

  const hasFile = (/** @type {string} */ p) => exists(p);
  const readFile = (/** @type {string} */ p) => {
    if (!exists(p)) return "";
    return read(p);
  };

  // ── 1. Root action stub ────────────────────────────────────────────────

  checks += 1;
  if (!hasFile("action.yml") && !hasFile("action.yaml")) {
    failures.push("Root action manifest missing: 'ecoma-io/action-agents@v0.1.0' cannot resolve.");
  } else {
    const rootManifest = hasFile("action.yml") ? readFile("action.yml") : readFile("action.yaml");

    // Required metadata — check for top-level `name:` (not indented step names)
    if (!/^name:\s/m.test(rootManifest)) {
      failures.push("Root action.yml: missing 'name' field.");
    }
    if (!/^description:\s/m.test(rootManifest)) {
      failures.push("Root action.yml: missing 'description' field.");
    } else {
      const description = descriptionText(rootManifest);
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        failures.push(
          `Root action.yml: description is ${description.length} characters, over the ` +
            `${MAX_DESCRIPTION_LENGTH}-character GitHub Marketplace limit.`,
        );
      }
    }
    if (!rootManifest.includes("runs:")) {
      failures.push("Root action.yml: missing 'runs' block.");
    }

    // Must be composite (not node24 — a composite stub can't accidentally
    // execute JavaScript).
    const usesMatch = rootManifest.match(/using:\s*(\S+)/);
    if (usesMatch && usesMatch[1] !== "composite") {
      failures.push(`Root action.yml runs.using must be 'composite', got '${usesMatch[1]}'.`);
    }

    // Must not declare a `main:` entry point — a stub that declares code
    // could accidentally execute something.
    if (rootManifest.includes("main:")) {
      failures.push(
        "Root action.yml declares a 'main:' entry point — a stub must not execute code.",
      );
    }
  }

  // ── 2. Child action manifests ──────────────────────────────────────────

  for (const action of CHILD_ACTIONS) {
    checks += 1;
    const manifestPath = `${action}/action.yaml`;
    if (!hasFile(manifestPath)) {
      failures.push(`'${action}' has no ${manifestPath} — consumers pinning @v0.1 would break.`);
      continue;
    }

    const manifest = readFile(manifestPath);

    // runs.main must exist and resolve
    const mainMatch = manifest.match(/main:\s*(\S+)/);
    if (!mainMatch) {
      failures.push(`'${action}/action.yaml' has no 'runs.main' — the runner cannot start it.`);
      continue;
    }
    const mainFile = `${action}/${mainMatch[1]}`;
    checks += 1;
    if (!hasFile(mainFile)) {
      failures.push(`'${action}/action.yaml' entry point '${mainMatch[1]}' does not exist.`);
    }

    // runs.using must be a valid runtime
    const usingMatch = manifest.match(/using:\s*(\S+)/);
    if (usingMatch && !["node20", "node22", "node24"].includes(usingMatch[1])) {
      failures.push(
        `'${action}/action.yaml' runs.using '${usingMatch[1]}' is not a supported Node.js runtime.`,
      );
    }
  }

  // ── 3. Unexpected action surface detection ─────────────────────────────

  checks += 1;
  for (const dir of discoveredDirs) {
    if (!CHILD_ACTIONS.includes(dir)) {
      failures.push(
        `'${dir}' carries action.yaml but is not a declared public action — ` +
          `add it to the public action list or remove it from the tree.`,
      );
    }
  }

  // ── 4. Version consistency ─────────────────────────────────────────────

  checks += 1;
  if (hasFile("release-please-config.json")) {
    const config = JSON.parse(readFile("release-please-config.json"));
    const pkg = hasFile("package.json") ? JSON.parse(readFile("package.json")) : null;
    const manifest = hasFile(".release-please-manifest.json")
      ? JSON.parse(readFile(".release-please-manifest.json"))
      : null;

    if (config.packages?.["."]) {
      const rpVersion = config.packages["."]["initial-version"];
      if (rpVersion && rpVersion !== "0.1.0") {
        failures.push(
          `release-please initial-version is '${rpVersion}', expected '0.1.0' for v0.x.`,
        );
      }
    }

    if (manifest?.["."] && pkg?.version) {
      if (manifest["."] !== pkg.version) {
        failures.push(
          `Version mismatch: .release-please-manifest.json has '${manifest["."]}', package.json has '${pkg.version}'.`,
        );
      }
    }
  }
  return { failures, checks };
}

/**
 * The rendered text of a manifest `description:` field, read off the raw
 * manifest text the way every check here reads manifests — no YAML parser.
 *
 * Handles every form a root `action.yml` description takes:
 *   - single-line plain scalar (surrounding quotes stripped)
 *   - multi-line plain scalar — continuation lines fold with single spaces,
 *     blank lines fold to newlines, per YAML plain-scalar folding
 *   - `>` / `|` block scalars with indent/chomping indicators — blank lines
 *     inside the block belong to the block; folded joins adjacent non-blank
 *     lines with single spaces and folds blank lines to newlines, literal
 *     preserves line breaks
 *
 * Collection stops at the first non-indented, non-blank line (the next
 * manifest key).  Trailing whitespace is clipped, which chomping clips
 * anyway.
 *
 * @param {string} manifest  raw manifest text
 * @returns {string} the rendered description, "" when absent
 */
function descriptionText(manifest) {
  const lines = manifest.split("\n");
  const key = lines.findIndex((line) => /^description:\s/.test(line));
  if (key === -1) return "";
  const head = lines[key].replace(/^description:\s*/, "");

  // Block scalar: the head line is the `>` / `|` indicator; the value lives
  // on the following lines, blanks included.
  if (/^[>|][0-9]?[+-]?$/.test(head)) {
    const parts = collectScalarLines(lines, key);
    return (head.startsWith("|") ? parts.join("\n") : foldLines(parts)).trimEnd();
  }

  // Plain or quoted scalar: the head line carries the first line's text.  A
  // quoted value is single-line here; a plain value may continue on
  // more-indented lines.
  const headText = head.trim().replace(/^['"]|['"]$/g, "");
  if (/^['"]/.test(head.trim())) return headText.trimEnd();
  return foldLines([headText, ...collectScalarLines(lines, key)]).trimEnd();
}

/**
 * The continuation lines of a `description:` value: every line from `key + 1`
 * that is blank or indented, stopping at the first non-indented non-blank
 * line.  Blank lines are kept as empty strings so the caller can fold them —
 * a blank line inside a block scalar belongs to the block, not to the end of
 * the value, which is exactly the under-measurement #139 fixed.
 *
 * @param {string[]} lines  manifest split on newlines
 * @param {number} key      index of the `description:` line
 * @returns {string[]} trimmed continuation lines, "" for blank lines
 */
function collectScalarLines(lines, key) {
  const parts = [];
  for (let i = key + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      parts.push("");
      continue;
    }
    if (!/^\s+\S/.test(line)) break;
    parts.push(line.trim());
  }
  return parts;
}

/**
 * Fold collected scalar lines the way GitHub renders them: adjacent non-blank
 * lines join with a single space, and a run of blank lines between content
 * folds to that many newlines.  Leading and trailing blank lines contribute
 * nothing — chomping clips them.
 *
 * @param {string[]} parts  trimmed lines, "" for blank lines
 * @returns {string} the folded text
 */
function foldLines(parts) {
  let out = "";
  let blanks = 0;
  let started = false;
  for (const part of parts) {
    if (part === "") {
      if (started) blanks += 1;
      continue;
    }
    if (!started) {
      out = part;
      started = true;
    } else if (blanks === 0) {
      out += ` ${part}`;
    } else {
      out += "\n".repeat(blanks) + part;
    }
    blanks = 0;
  }
  return out;
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

function main() {
  const read = (/** @type {string} */ p) => readFileSync(p, "utf8");
  const exists = (/** @type {string} */ p) => existsSync(p);

  // Discover action directories for surprise detection
  /** @type {string[]} */
  const discoveredDirs = [];
  for (const entry of readdirSync(".", { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      entry.name !== "node_modules" &&
      (existsSync(join(entry.name, "action.yaml")) || existsSync(join(entry.name, "action.yml")))
    ) {
      discoveredDirs.push(entry.name);
    }
  }

  const { failures, checks } = evaluate({
    read,
    exists,
    discoveredDirs,
  });

  if (failures.length > 0) {
    for (const f of failures) console.error(`✗ ${f}`);
    console.error(
      `\n${String(failures.length)} release invariant violation(s) ` +
        `(${String(checks)} checks, ${String(discoveredDirs.length)} action directories found).`,
    );
    process.exit(1);
  }

  console.log(
    `✔ ${String(checks)} release invariants satisfied ` +
      `(${String(discoveredDirs.length)} action directories found)`,
  );
}

if (isProgramEntry(import.meta.url)) main();
