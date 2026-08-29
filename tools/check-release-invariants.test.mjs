// Tests for check-release-invariants.mjs.
//
// `evaluate` takes every fact it needs as an argument — the fs functions and
// a list of discovered action directories — so these run with no repository
// and no git.

import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate } from "./check-release-invariants.mjs";

/**
 * Minimal fs stub: a map of path → content.
 *
 * @param {Record<string, string>} files
 */
function stubFs(files) {
  return {
    read: (/** @type {string} */ p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    exists: (/** @type {string} */ p) => p in files,
  };
}

const ROOT_STUB = [
  "name: Action Agents (select an action)",
  "description: >-",
  "  This repository contains three separate actions.",
  "runs:",
  "  using: composite",
  "  steps:",
  "    - name: Fail",
  "      shell: bash",
  '      run: echo "::error::Select an action." && exit 1',
].join("\n");

function childManifest(entry = "src/index.mjs") {
  return [
    "name: Test Action",
    "description: A test action.",
    "runs:",
    "  using: node24",
    `  main: ${entry}`,
  ].join("\n");
}

const ENTRY_POINT = "export {}";

/** All files needed for a passing state with 3 child actions. */
const FULL_TREE = {
  "action.yml": ROOT_STUB,
  "triage/action.yaml": childManifest(),
  "triage/src/index.mjs": ENTRY_POINT,
  "review/action.yaml": childManifest(),
  "review/src/index.mjs": ENTRY_POINT,
  "harmonise/action.yaml": childManifest(),
  "harmonise/src/index.mjs": ENTRY_POINT,
};

// ── Root action stub ──────────────────────────────────────────────────────

test("root: fails when root action.yml is missing", () => {
  const { failures } = evaluate({
    ...stubFs({ "triage/action.yaml": childManifest() }),
    discoveredDirs: ["triage"],
  });
  assert.ok(
    failures.some((f) => f.includes("Root action manifest missing")),
    `expected root-missing failure, got: ${failures.join(", ")}`,
  );
});

test("root: passes when root action.yml is a valid composite stub", () => {
  const { failures } = evaluate({
    ...stubFs(FULL_TREE),
    discoveredDirs: ["triage", "review", "harmonise"],
  });
  assert.equal(failures.length, 0, `unexpected failures: ${failures.join(", ")}`);
});

test("root: rejects root action with node24 runtime", () => {
  const bad = ROOT_STUB.replace("using: composite", "using: node24");
  const { failures } = evaluate({
    ...stubFs({ "action.yml": bad }),
    discoveredDirs: [],
  });
  assert.ok(
    failures.some((f) => f.includes("must be 'composite'")),
    `expected composite failure, got: ${failures.join(", ")}`,
  );
});

test("root: rejects root action that declares a main entry point", () => {
  const bad = ROOT_STUB + "\n  main: src/index.mjs";
  const { failures } = evaluate({
    ...stubFs({ "action.yml": bad }),
    discoveredDirs: [],
  });
  assert.ok(
    failures.some((f) => f.includes("must not execute code")),
    `expected no-code failure, got: ${failures.join(", ")}`,
  );
});

test("root: rejects root action missing name field", () => {
  const bad = ROOT_STUB.replace("name: Action Agents (select an action)", "");
  const { failures } = evaluate({
    ...stubFs({
      "action.yml": bad,
      "triage/action.yaml": childManifest(),
      "triage/src/index.mjs": ENTRY_POINT,
      "review/action.yaml": childManifest(),
      "review/src/index.mjs": ENTRY_POINT,
      "harmonise/action.yaml": childManifest(),
      "harmonise/src/index.mjs": ENTRY_POINT,
    }),
    discoveredDirs: ["triage", "review", "harmonise"],
  });
  assert.ok(
    failures.some((f) => f.includes("missing 'name'")),
    `expected name-missing failure, got: ${failures.join(", ")}`,
  );
});

test("root: rejects root action missing description field", () => {
  const bad = ROOT_STUB.replace("description: >-", "").replace(
    "  This repository contains three separate actions.",
    "",
  );
  const { failures } = evaluate({
    ...stubFs({ "action.yml": bad }),
    discoveredDirs: [],
  });
  assert.ok(
    failures.some((f) => f.includes("missing 'description'")),
    `expected description-missing failure, got: ${failures.join(", ")}`,
  );
});

test("root: rejects a root description longer than 125 characters", () => {
  const bad = ROOT_STUB.replace(
    "  This repository contains three separate actions.",
    `  ${"y".repeat(126)}`,
  );
  const { failures } = evaluate({
    ...stubFs({ "action.yml": bad }),
    discoveredDirs: [],
  });
  assert.ok(
    failures.some((f) => f.includes("Root action.yml") && f.includes("125-character")),
    `expected over-limit failure, got: ${failures.join(", ")}`,
  );
});

test("root: passes with a root description of exactly 125 characters", () => {
  const stub = ROOT_STUB.replace("description: >-", `description: ${"y".repeat(125)}`).replace(
    "  This repository contains three separate actions.",
    "",
  );
  const { failures } = evaluate({
    ...stubFs({ ...FULL_TREE, "action.yml": stub }),
    discoveredDirs: ["triage", "review", "harmonise"],
  });
  assert.equal(failures.length, 0, `unexpected failures: ${failures.join(", ")}`);
});

test("root: rejects a folded-join description over the limit (62 + space + 63 = 126)", () => {
  const over = [
    "name: Action Agents",
    "description: >-",
    `  ${"a".repeat(62)}`,
    `  ${"b".repeat(63)}`,
    "runs:",
    "  using: composite",
  ].join("\n");
  const { failures } = evaluate({
    ...stubFs({ "action.yml": over }),
    discoveredDirs: [],
  });
  assert.ok(
    failures.some(
      (f) =>
        f.includes("Root action.yml") &&
        f.includes("126 characters") &&
        f.includes("125-character"),
    ),
    `expected folded join to measure 126 and fail, got: ${failures.join(", ")}`,
  );
});

test("root: passes with a folded-join description of exactly 125 characters", () => {
  const atLimit = [
    "name: Action Agents",
    "description: >-",
    `  ${"a".repeat(62)}`,
    `  ${"b".repeat(62)}`,
    "runs:",
    "  using: composite",
  ].join("\n");
  const { failures } = evaluate({
    ...stubFs({ ...FULL_TREE, "action.yml": atLimit }),
    discoveredDirs: ["triage", "review", "harmonise"],
  });
  assert.equal(failures.length, 0, `unexpected failures: ${failures.join(", ")}`);
});

test("root: rejects a quoted single-line description over the limit (130)", () => {
  const quoted = [
    "name: Action Agents",
    `description: ${JSON.stringify("w".repeat(130))}`,
    "runs:",
    "  using: composite",
  ].join("\n");
  const { failures } = evaluate({
    ...stubFs({ "action.yml": quoted }),
    discoveredDirs: [],
  });
  assert.ok(
    failures.some(
      (f) =>
        f.includes("Root action.yml") &&
        f.includes("130 characters") &&
        f.includes("125-character"),
    ),
    `expected quoted scalar to measure 130 and fail, got: ${failures.join(", ")}`,
  );
});

test("root: rejects a blank-line folded block whose rendered value exceeds the limit", () => {
  const blankFolded = [
    "name: Action Agents",
    "description: >-",
    `  ${"x".repeat(100)}`,
    "",
    `  ${"z".repeat(100)}`,
    "runs:",
    "  using: composite",
  ].join("\n");
  const { failures } = evaluate({
    ...stubFs({ "action.yml": blankFolded }),
    discoveredDirs: [],
  });
  assert.ok(
    failures.some(
      (f) =>
        f.includes("Root action.yml") &&
        f.includes("201 characters") &&
        f.includes("125-character"),
    ),
    `expected blank-line folded block to measure 201 and fail, got: ${failures.join(", ")}`,
  );
});

test("root: rejects a multi-line plain scalar whose rendered value exceeds the limit", () => {
  const plainFolded = [
    "name: Action Agents",
    `description: ${"p".repeat(100)}`,
    `  ${"q".repeat(100)}`,
    "runs:",
    "  using: composite",
  ].join("\n");
  const { failures } = evaluate({
    ...stubFs({ "action.yml": plainFolded }),
    discoveredDirs: [],
  });
  assert.ok(
    failures.some(
      (f) =>
        f.includes("Root action.yml") &&
        f.includes("201 characters") &&
        f.includes("125-character"),
    ),
    `expected multi-line plain scalar to measure 201 and fail, got: ${failures.join(", ")}`,
  );
});

// ── Child action manifests ────────────────────────────────────────────────

test("children: fails when a declared action has no manifest", () => {
  const { failures } = evaluate({
    ...stubFs({ "action.yml": ROOT_STUB }),
    discoveredDirs: [],
  });
  assert.ok(
    failures.some((f) => f.includes("has no triage/action.yaml")),
    `expected missing-manifest failure, got: ${failures.join(", ")}`,
  );
});

test("children: fails when entry point does not exist", () => {
  const { failures } = evaluate({
    ...stubFs({
      ...FULL_TREE,
      "triage/action.yaml": childManifest("src/nonexistent.mjs"),
    }),
    discoveredDirs: ["triage", "review", "harmonise"],
  });
  assert.ok(
    failures.some((f) => f.includes("entry point 'src/nonexistent.mjs'")),
    `expected missing-entry failure, got: ${failures.join(", ")}`,
  );
});

test("children: fails when runs.main is missing", () => {
  const manifest = "name: Test\nruns:\n  using: node24\n";
  const { failures } = evaluate({
    ...stubFs({
      "action.yml": ROOT_STUB,
      "triage/action.yaml": manifest,
    }),
    discoveredDirs: ["triage"],
  });
  assert.ok(
    failures.some((f) => f.includes("has no 'runs.main'")),
    `expected no-main failure, got: ${failures.join(", ")}`,
  );
});

test("children: rejects unsupported Node.js runtime", () => {
  const manifest = childManifest().replace("node24", "node16");
  const { failures } = evaluate({
    ...stubFs({
      "action.yml": ROOT_STUB,
      "triage/action.yaml": manifest,
    }),
    discoveredDirs: ["triage"],
  });
  assert.ok(
    failures.some((f) => f.includes("not a supported Node.js runtime")),
    `expected runtime failure, got: ${failures.join(", ")}`,
  );
});

test("children: passes when all actions have valid manifests and entry points", () => {
  const { failures } = evaluate({
    ...stubFs(FULL_TREE),
    discoveredDirs: ["triage", "review", "harmonise"],
  });
  assert.equal(failures.length, 0, `unexpected failures: ${failures.join(", ")}`);
});

// ── Unexpected action surface ─────────────────────────────────────────────

test("surprise: fails when a directory has action.yaml but is not declared", () => {
  const { failures } = evaluate({
    ...stubFs(FULL_TREE),
    discoveredDirs: ["triage", "review", "harmonise", "experimental"],
  });
  assert.ok(
    failures.some((f) => f.includes("'experimental' carries action.yaml")),
    `expected surprise failure, got: ${failures.join(", ")}`,
  );
});

test("surprise: passes when only declared directories have action.yaml", () => {
  const { failures } = evaluate({
    ...stubFs(FULL_TREE),
    discoveredDirs: ["triage", "review", "harmonise"],
  });
  assert.equal(failures.length, 0, `unexpected failures: ${failures.join(", ")}`);
});

// ── Version consistency ───────────────────────────────────────────────────

test("version: flags mismatched versions between manifest and package.json", () => {
  const { failures } = evaluate({
    ...stubFs({
      ...FULL_TREE,
      "release-please-config.json": JSON.stringify({
        packages: { ".": { "initial-version": "0.1.0" } },
      }),
      ".release-please-manifest.json": '{".":"0.1.0"}',
      "package.json": JSON.stringify({ version: "0.0.0" }),
    }),
    discoveredDirs: ["triage", "review", "harmonise"],
  });
  assert.ok(
    failures.some((f) => f.includes("Version mismatch")),
    `expected version-mismatch failure, got: ${failures.join(", ")}`,
  );
});

test("version: passes when versions are consistent", () => {
  const { failures } = evaluate({
    ...stubFs({
      ...FULL_TREE,
      "release-please-config.json": JSON.stringify({
        packages: { ".": { "initial-version": "0.1.0" } },
      }),
      ".release-please-manifest.json": '{".":"0.0.0"}',
      "package.json": JSON.stringify({ version: "0.0.0" }),
    }),
    discoveredDirs: ["triage", "review", "harmonise"],
  });
  assert.equal(failures.length, 0, `unexpected failures: ${failures.join(", ")}`);
});

test("version: flags wrong initial-version", () => {
  const { failures } = evaluate({
    ...stubFs({
      "release-please-config.json": JSON.stringify({
        packages: { ".": { "initial-version": "1.0.0" } },
      }),
      "package.json": JSON.stringify({ version: "0.0.0" }),
      ".release-please-manifest.json": '{".":"0.0.0"}',
    }),
    discoveredDirs: [],
  });
  assert.ok(
    failures.some((f) => f.includes("expected '0.1.0'")),
    `expected initial-version failure, got: ${failures.join(", ")}`,
  );
});

// ── Checks count ──────────────────────────────────────────────────────────

test("checks: counts at least one check per invariant category", () => {
  const { checks } = evaluate({
    ...stubFs(FULL_TREE),
    discoveredDirs: ["triage", "review", "harmonise"],
  });
  // 1 root + 3 children (each with 2 checks: manifest + entry point) + 1 surprise + 1 version
  assert.ok(checks >= 5, `expected at least 5 checks, got ${checks}`);
});
