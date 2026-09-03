#!/usr/bin/env node
/**
 * Invariant I8 — action shape.
 *
 * An action here is a directory a consumer pins by ref: `node24` straight at
 * src/index.mjs. There is no build and there are no runtime dependencies —
 * no dist/, no node_modules on the consumer's runner, no install step, and
 * what that forbids in package.json is a `dependencies` block. This gate
 * walks the whole tree and judges three facts:
 *
 *   1. No package.json — at any depth — declares a `dependencies` block.
 *      (devDependencies are the dev toolchain and stay allowed.)
 *   2. No dist/ directory exists anywhere. Built output in the tree is the
 *      build that does not exist.
 *   3. Every action.yaml runs on exactly node24. (The root action.yml stub
 *      is composite and is owned by the release gate, not this one.)
 *
 * The entry-point half (runs.main resolvable, runs.using a supported Node
 * runtime) is enforced by tools/check-release-invariants.mjs and is not
 * duplicated here — this gate adds the stricter shape the release gate does
 * not see.
 *
 * Usage:
 *   node tools/check-action-shape.mjs            judge the real tree
 *   node tools/check-action-shape.mjs <dir>      judge a fixture tree
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Real-tree walk skips these directory names wherever they appear. */
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage"]);

/** The real-tree walk also skips this subtree: fixtures are judged by name. */
const FIXTURES_DIR = "tools/fixtures";

/** The only runtime a child action.yaml may declare. */
const ONLY_RUNTIME = "node24";

/**
 * A directory-walk result, grouped the way evaluate() consumes it.
 *
 * @typedef {object} Tree
 * @property {{ path: string, json: unknown | null, malformed: boolean }[]} manifests
 * @property {string[]} distDirs
 * @property {{ path: string, text: string }[]} actions
 */

/**
 * Judges the walk result. Pure: reads no filesystem.
 *
 * @param {Tree} tree
 * @returns {{ failures: string[], checks: number }}
 */
export function evaluate(tree) {
  /** @type {string[]} */
  const failures = [];
  let checks = 0;

  for (const manifest of tree.manifests) {
    checks += 1;
    if (manifest.malformed) {
      failures.push(manifest.path + ":0: package.json is not valid JSON (invariant I8)");
      continue;
    }
    if (
      typeof manifest.json === "object" &&
      manifest.json !== null &&
      Object.hasOwn(manifest.json, "dependencies")
    ) {
      failures.push(
        manifest.path +
          ':0: declares a "dependencies" block — there are no runtime dependencies (invariant I8)',
      );
    }
  }

  for (const dist of tree.distDirs) {
    checks += 1;
    failures.push(dist + ":0: built dist/ directory exists — there is no build (invariant I8)");
  }

  for (const action of tree.actions) {
    checks += 1;
    const runtimes = [...action.text.matchAll(/\busing:\s*(\S+)/g)].map((m) => m[1]);
    if (runtimes.length === 0) {
      failures.push(
        action.path + ":0: no runs.using — the runner cannot start the action (invariant I8)",
      );
      continue;
    }
    for (const runtime of runtimes) {
      if (runtime !== ONLY_RUNTIME) {
        failures.push(
          action.path +
            ':0: runs.using "' +
            runtime +
            '" — child actions run on node24 only (invariant I8)',
        );
      }
    }
  }

  return { failures, checks };
}

/**
 * Walks `dir` collecting package.json manifests, dist/ directories and
 * action.yaml files. Pure-ish: it reads, it never writes.
 *
 * @param {string} dir directory to walk
 * @param {string} prefix reported-path prefix
 * @param {Tree} tree accumulator
 * @param {boolean} fixtureMode skip the real-tree fixtures subtree
 */
export function walkTree(dir, prefix, tree, fixtureMode) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (fixtureMode && prefix === "" && entry.name === FIXTURES_DIR) continue;
    const at = join(dir, entry.name);
    const path = prefix === "" ? entry.name : prefix + "/" + entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "dist") {
        tree.distDirs.push(path);
        continue;
      }
      walkTree(at, path, tree, fixtureMode);
      continue;
    }
    if (entry.name === "package.json") {
      let json = null;
      let malformed = false;
      try {
        json = JSON.parse(readFileSync(at, "utf8"));
      } catch {
        malformed = true;
      }
      tree.manifests.push({ path, json, malformed });
      continue;
    }
    if (entry.name === "action.yaml") {
      tree.actions.push({ path, text: readFileSync(at, "utf8") });
    }
  }
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
  const rootArg = process.argv[2];
  const fixtureMode = rootArg !== undefined;
  /** @type {Tree} */
  const tree = { manifests: [], distDirs: [], actions: [] };

  if (!existsSync(rootArg ?? ".")) {
    console.error("✗ root does not exist: " + (rootArg ?? "."));
    process.exit(1);
  }
  walkTree(rootArg ?? ".", "", tree, fixtureMode);

  if (!fixtureMode) {
    // Coverage: the walk must have seen the surfaces this gate exists for.
    if (tree.manifests.length === 0 || tree.actions.length === 0) {
      console.error(
        "✗ walk found no package.json or no action.yaml — refusing to pass vacuously (run from the repository root)",
      );
      process.exit(1);
    }
  }

  const { failures, checks } = evaluate(tree);
  if (failures.length > 0) {
    for (const f of failures) console.error("✗ " + f);
    console.error(
      "\n" +
        String(failures.length) +
        " action-shape violation(s) (" +
        String(checks) +
        " checks, " +
        String(tree.manifests.length) +
        " manifests, " +
        String(tree.actions.length) +
        " actions).",
    );
    process.exit(1);
  }

  console.log(
    "✔ " +
      String(checks) +
      " action-shape checks passed (" +
      String(tree.manifests.length) +
      " manifests, " +
      String(tree.actions.length) +
      " actions, no dist/) — invariant I8 holds",
  );
}

if (isProgramEntry(import.meta.url)) main();
