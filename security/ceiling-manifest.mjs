#!/usr/bin/env node
/**
 * The ceiling-to-fixture manifest gate.
 *
 * `run-adversarial.mjs` already fails closed on an empty corpus. This gate goes
 * further: it pins the DOCTRINE-to-PROOF mapping so a ceiling documented in
 * `SECURITY.md` cannot be claimed while no adversarial fixture exercises it,
 * and a fixture cannot quietly exist without pinning any ceiling the doctrine
 * states.
 *
 * The mapping lives in `ceiling-manifest.json`, a hand-maintained registry
 * (its schema is documented in `ceiling-manifest.README.md`). This script:
 *
 *   1. reads that manifest;
 *   2. globs every `*.test.mjs` file under `security/fixtures/` (the same
 *      discovery `run-adversarial.mjs` uses);
 *   3. fails if any ceiling key lists no fixture, or references a fixture file
 *      that does not exist (or is not a discovered adversarial test);
 *   4. reports a warning for any discovered fixture that no ceiling references
 *      — a fixture claiming to pin a ceiling the doctrine never states is a
 *      manifest gap, surfaced here rather than passed in silence;
 *   5. exits 0 on a fully-populated, consistent manifest and 1 otherwise.
 *
 * The default treats an unreferenced fixture as a warning, not a failure, so
 * a genuinely auxiliary fixture does not block the run; pass `--strict` to
 * promote that warning to a failure.
 *
 * Deterministic and offline: it reads one JSON file and globs a directory — no
 * network, no model, no timers. Runs with plain `node`, zero runtime deps.
 *
 * Run with:  node security/ceiling-manifest.mjs [--strict]
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the hand-maintained registry. */
const MANIFEST_PATH = join(here, "ceiling-manifest.json");

/** Glob of every adversarial test file, relative to this gate's directory. */
const FIXTURE_GLOB = join(here, "fixtures", "**", "*.test.mjs");

/** The path prefix, relative to this gate, that a fixture path is stored under. */
const FIXTURE_BASE = join(here, "fixtures");

/**
 * Normalise an absolute or relative path to the forward-slash, `fixtures/`-
 * relative spelling the manifest uses (e.g. `prompt-injection/off-sheet.test.mjs`).
 *
 * @param {string} absolutePath
 * @returns {string}
 */
export function toFixtureRel(absolutePath) {
  return absolutePath
    .slice(FIXTURE_BASE.length + 1)
    .split(sep)
    .join("/");
}

/**
 * Discover every adversarial test file under `security/fixtures/` as a set of
 * normalised `fixtures/`-relative paths. Deterministic: `globSync` returns
 * path order, and membership is what the gate cares about, so a Set is always
 * the same regardless of order.
 *
 * @returns {Set<string>}
 */
export function discoverFixtures() {
  return new Set(globSync(FIXTURE_GLOB).map(toFixtureRel));
}

/**
 * Load and parse the manifest JSON, failing loudly if it is unreadable or
 * malformed — a broken registry must never pass as "consistent".
 *
 * @returns {{ version: number, base: string, description: string, ceilings: Array<{ key: string, name: string, source: string, fixtures: string[] }> }}
 */
export function loadManifest() {
  /** @type {string} */
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  /** @type {{ version: number, base: string, description: string, ceilings: Array<{ key: string, name: string, source: string, fixtures: string[] }> }} */
  const manifest = JSON.parse(raw);
  return manifest;
}

/**
 * Check a manifest against the discovered fixture set. The registry path
 * prefix `base` is accepted but intentionally ignored for membership: a
 * manifest entry is stored relative to `security/fixtures/`, and references
 * are matched against the normalised discovered paths regardless of what
 * `base` claims, so a drift in the manifest's declared base can never paper
 * over a real gap.
 *
 * A ceiling fails if it lists no fixtures (an "empty reference") or if any of
 * its fixture paths is not present in the discovered set (a "missing
 * fixture"). A discovered fixture that no ceiling references produces a
 * warning.
 *
 * @param {{ version: number, base: string, description: string, ceilings: Array<{ key: string, name: string, source: string, fixtures: string[] }> }} manifest
 * @param {Set<string>} fixtureSet
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function checkManifest(manifest, fixtureSet) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  const referenced = new Set();

  for (const ceiling of manifest.ceilings) {
    if (!Array.isArray(ceiling.fixtures) || ceiling.fixtures.length === 0) {
      errors.push(
        `ceiling "${ceiling.key}" lists no fixtures — a doctrine ceiling with no adversarial proof must fail.`,
      );
      continue;
    }
    for (const ref of ceiling.fixtures) {
      referenced.add(ref);
      if (!fixtureSet.has(ref)) {
        errors.push(
          `ceiling "${ceiling.key}" references missing fixture "${ref}" — no such adversarial test exists under security/fixtures/.`,
        );
      }
    }
  }

  for (const path of fixtureSet) {
    if (!referenced.has(path)) {
      warnings.push(
        `fixture "${path}" is referenced by no ceiling — a test proving a ceiling the doctrine never documents; add it to ceiling-manifest.json or it is unaccounted.`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Render the gate's report and exit the process. Returns nothing; the exit
 * code is this call's side effect. `--strict` promotes the unreferenced
 * fixture warning to a failure.
 *
 * @param {{ status: "clean" | { ok: boolean, errors: string[], warnings: string[] }, strict: boolean }} options
 */
function report({ status, strict }) {
  if (status === "clean") {
    console.log(
      "ceiling-manifest: clean — every documented ceiling has an adversarial fixture, and none is unaccounted.",
    );
    return;
  }

  const { ok, errors, warnings } = status;
  for (const error of errors) {
    console.error(`ceiling-manifest: FAIL ${error}`);
  }
  for (const warning of warnings) {
    console.warn(`ceiling-manifest: warning ${warning}`);
  }

  const failed = !ok || (strict && warnings.length > 0);
  console.error(
    failed
      ? `ceiling-manifest: ${errors.length} error(s), ${warnings.length} warning(s); refusing to pass.`
      : `ceiling-manifest: ${errors.length} error(s), ${warnings.length} warning(s); warnings do not fail default mode.`,
  );
  process.exit(failed ? 1 : 0);
}

/**
 * Run the gate end to end. Returns `undefined` so this process's exit code is
 * this call's side effect (the same shape as `run-adversarial.mjs`'s `main`).
 *
 * @param {string[]} [argv]
 */
export function main(argv = process.argv.slice(2)) {
  const strict = argv.includes("--strict");

  const manifest = loadManifest();
  const fixtureSet = discoverFixtures();
  const status = checkManifest(manifest, fixtureSet);

  if (status.ok && status.warnings.length === 0) {
    report({ status: "clean", strict });
    return;
  }
  report({ status, strict });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
