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
 *   7. At the release SHA only (`--at-release`): the floating pin declared in
 *      tools/action-pins.json shares the released version's minor line, so a
 *      patch release needs no pin edits and a minor release whose pins were
 *      not refreshed fails loud with the fix in the message
 *
 * WHY THIS FILE EXISTS.  The release workflow's inline validation runs once
 * at release time and can only fail.  This gate runs on every commit and
 * catches invariant drift _before_ it reaches a release PR.  A broken root
 * stub, a missing manifest, or an undocumented action directory is caught
 * here first.
 *
 * WHY INVARIANT 7 IS RELEASE-ONLY.  A minor release's pins refresh cannot
 * precede the release: a release pull request is an ordinary pull request,
 * check-uses-refs resolves every documented `uses:` ref against tags that
 * exist, and the v0.12 tag cannot exist before release.yml cuts v0.12.0 — so
 * demanding the refresh pre-merge would make every minor release pull request
 * unsatisfiable rather than merely red. The two directions CI can judge
 * pre-merge are already judged there (check-action-pins: documents and
 * manifest agree; check-uses-refs: every documented ref is published); the
 * one direction only a release can reveal — the version moved to a line the
 * pins do not describe — is judged at the release SHA, where the exact tag
 * exists and the floating tag is about to move. A failure there leaves the
 * release created but the floating tag unmoved (floating-tag needs the
 * release job green), which is the recoverable order, and the failure message
 * carries the convergence sequence.
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

/** The pins manifest the covered consumer documents are judged against. */
export const PINS_MANIFEST = "tools/action-pins.json";

/** The release-please manifest holding the last released version under ".". */
export const RELEASE_MANIFEST = ".release-please-manifest.json";

/**
 * The one flag, passed by release.yml, that turns on the release-only
 * invariants. Unknown arguments are refused rather than ignored, so a
 * misspelled flag fails the run instead of silently checking less.
 *
 * @type {string}
 */
export const AT_RELEASE_FLAG = "--at-release";

/** The shape a floating pin has: `v0.11` — the grammar check-action-pins judges. */
const FLOATING_PIN = /^v\d+\.\d+$/;

/** The shape of a released semver version: `0.11.1`. */
const RELEASED_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * @param {object} input
 * @param {(path: string) => string} input.read  read a file relative to root
 * @param {(path: string) => boolean} input.exists  check file existence
 * @param {string[]} [input.discoveredDirs]  directories with action.yaml found by the caller
 * @param {boolean} [input.atRelease]  the release-only invariants run (release.yml, at the release SHA)
 * @returns {{ failures: string[], checks: number }}
 */
export function evaluate({ read, exists, discoveredDirs = [], atRelease = false }) {
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

    // The CHANGELOG head must say the same version the version files do.
    // release-please writes .release-please-manifest.json, package.json and
    // the CHANGELOG together in the one release pull request it opens, so
    // divergence means a release's files were edited independently — a
    // consumer reading the CHANGELOG is told one version while package.json
    // and the manifest report another. Running at the tag SHA (release.yml's
    // "Verify every action resolves at this tag") this is what proves the
    // released tree's changelog and its version files describe the same tag.
    if (hasFile("CHANGELOG.md") && manifest?.["."]) {
      checks += 1;
      const changelog = readFile("CHANGELOG.md");
      const head = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
      if (head === null) {
        failures.push(
          "CHANGELOG.md has no `## [<version>]` release heading to compare against the version files.",
        );
      } else if (head[1] !== manifest["."]) {
        failures.push(
          `CHANGELOG head describes '${head[1]}' but .release-please-manifest.json has ` +
            `'${manifest["."]}' — a release cut with its changelog and version files out of step.`,
        );
      }
    }
  }

  // ── 5. The floating pin is the line this release delivers (#447) ────────
  //
  // Runs only at the release SHA; the header of this file carries the reason
  // the check is release-only rather than a pre-merge gate. The rule is the
  // minor-line rule: a patch release (0.11.2 against floating `v0.11`) shares
  // the line and passes with no pin edits at all, and a minor release whose
  // pins were left behind fails loud with the convergence sequence in the
  // message. The pins the documents may show have their own gate
  // (tools/check-action-pins.mjs); this is the one direction that gate cannot
  // see — the version moved without the manifest following.
  if (atRelease) {
    checks += 1;
    if (!hasFile(PINS_MANIFEST) || !hasFile(RELEASE_MANIFEST)) {
      failures.push(
        !hasFile(PINS_MANIFEST)
          ? `${PINS_MANIFEST} is missing — the pins manifest is the source of truth the covered ` +
              `documents are judged against, and this release ships without it.`
          : `${RELEASE_MANIFEST} is missing — the released version this gate judges the pins ` +
              `against does not exist at this SHA.`,
      );
    } else {
      const pins = JSON.parse(readFile(PINS_MANIFEST));
      const released = /** @type {Record<string, unknown>} */ (
        JSON.parse(readFile(RELEASE_MANIFEST))
      )["."];

      if (typeof pins.floating !== "string" || !FLOATING_PIN.test(pins.floating)) {
        failures.push(
          `${PINS_MANIFEST}: 'floating' must be a minor-line pin like 'v0.11', got ` +
            `${JSON.stringify(pins.floating) ?? "undefined"} — the same grammar ` +
            `tools/check-action-pins.mjs judges, so one bump keeps both gates green.`,
        );
      } else if (typeof released !== "string" || !RELEASED_VERSION.test(released)) {
        failures.push(
          `${RELEASE_MANIFEST}: expected the released version like '0.11.1' under '.', got ` +
            `${JSON.stringify(released) ?? "undefined"}.`,
        );
      } else {
        const pinLine = pins.floating.replace(/^v/, "");
        const releasedLine = released.split(".").slice(0, 2).join(".");
        if (pinLine !== releasedLine) {
          failures.push(
            `${PINS_MANIFEST}: floating pin '${pins.floating}' is not on the minor line of the ` +
              `released version '${released}' — a minor release moved the floating line without ` +
              `refreshing the pins consumers copy out of the documents. The refresh cannot ` +
              `precede the tag (check-uses-refs refuses a documented ref no tag publishes yet), ` +
              `so converge after this release: bump floating, exact and rootExact in ` +
              `${PINS_MANIFEST} to the v${releasedLine} line and update every pin the covered ` +
              `documents show, in one pull request — the tags exist now, so it merges green — ` +
              `then move the floating tag at this release: ` +
              `gh api -X PATCH repos/<owner>/<repo>/git/refs/tags/v${releasedLine} ` +
              `-f sha="$(git rev-parse HEAD)" -F force=true. Until then this release ships with ` +
              `no floating tag and consumers pinned to ${pins.floating} stay on their line.`,
          );
        }
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
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== AT_RELEASE_FLAG);
  if (unknown.length > 0) {
    console.error(
      `✗ unknown argument(s): ${unknown.join(" ")} — the only flag is ${AT_RELEASE_FLAG}, the ` +
        `one release.yml passes to turn on the release-only invariants at the release SHA.`,
    );
    process.exit(1);
  }

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
    atRelease: args.includes(AT_RELEASE_FLAG),
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
