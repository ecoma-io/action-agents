// Tests for check-release-invariants.mjs.
//
// `evaluate` takes every fact it needs as an argument — the fs functions and
// a list of discovered action directories — so these run with no repository
// and no git.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

test("changelog: passes when the CHANGELOG head matches the version files", () => {
  const { failures } = evaluate({
    ...stubFs({
      ...FULL_TREE,
      "release-please-config.json": JSON.stringify({
        packages: { ".": { "initial-version": "0.1.0" } },
      }),
      ".release-please-manifest.json": '{".":"0.5.0"}',
      "package.json": JSON.stringify({ version: "0.5.0" }),
      "CHANGELOG.md":
        "# Changelog\n\n## [0.5.0](https://example.com/compare/v0.4.0...v0.5.0) (2026-08-30)\n\n### Features\n\n* something ([#1](https://example.com/1))\n",
    }),
    discoveredDirs: ["triage", "review", "harmonise"],
  });
  assert.equal(failures.length, 0, `unexpected failures: ${failures.join(", ")}`);
});

test("changelog: flags a CHANGELOG head that disagrees with the version files", () => {
  const { failures } = evaluate({
    ...stubFs({
      ...FULL_TREE,
      "release-please-config.json": JSON.stringify({
        packages: { ".": { "initial-version": "0.1.0" } },
      }),
      ".release-please-manifest.json": '{".":"0.5.0"}',
      "package.json": JSON.stringify({ version: "0.5.0" }),
      "CHANGELOG.md":
        "# Changelog\n\n## [0.4.1](https://example.com/compare/v0.4.0...v0.4.1) (2026-08-29)\n",
    }),
    discoveredDirs: ["triage", "review", "harmonise"],
  });
  assert.ok(
    failures.some((f) => f.includes("CHANGELOG head describes '0.4.1'")),
    `expected CHANGELOG-head failure, got: ${failures.join(", ")}`,
  );
});

test("changelog: flags a CHANGELOG with no release heading", () => {
  const { failures } = evaluate({
    ...stubFs({
      ...FULL_TREE,
      "release-please-config.json": JSON.stringify({
        packages: { ".": { "initial-version": "0.1.0" } },
      }),
      ".release-please-manifest.json": '{".":"0.5.0"}',
      "package.json": JSON.stringify({ version: "0.5.0" }),
      "CHANGELOG.md": "# Changelog\n\nNothing released yet.\n",
    }),
    discoveredDirs: ["triage", "review", "harmonise"],
  });
  assert.ok(
    failures.some((f) => f.includes("no `## [<version>]` release heading")),
    `expected missing-head failure, got: ${failures.join(", ")}`,
  );
});

// ── Floating pin against the released version (release-only, #447) ────────

/**
 * A tree that passes every other invariant, carrying the version files and
 * the pins manifest the release-only invariant reads.
 *
 * @param {string} released the version `.release-please-manifest.json` records
 * @param {string} floating the floating pin `tools/action-pins.json` declares
 */
function releaseTree(released, floating) {
  return {
    ...FULL_TREE,
    "release-please-config.json": JSON.stringify({
      packages: { ".": { "initial-version": "0.1.0" } },
    }),
    ".release-please-manifest.json": JSON.stringify({ ".": released }),
    "package.json": JSON.stringify({ version: released }),
    "CHANGELOG.md": `# Changelog\n\n## [${released}](https://example.com/compare) (2026-09-08)\n`,
    "tools/action-pins.json": JSON.stringify({
      floating,
      exact: `v${released}`,
      rootExact: `v${released}`,
    }),
  };
}

const ALL_ACTIONS = ["triage", "review", "harmonise"];

test("pins: a patch release needs no pin edits — floating on the same minor line passes", () => {
  // Both shapes the rule has to keep green: the tree as it stands (0.11.1
  // against v0.11) and the next patch cut from it (0.11.2 against v0.11).
  for (const released of ["0.11.1", "0.11.2"]) {
    const { failures } = evaluate({
      ...stubFs(releaseTree(released, "v0.11")),
      discoveredDirs: ALL_ACTIONS,
      atRelease: true,
    });
    assert.deepEqual(failures, [], `0.11-line tree with ${released} should pass`);
  }
});

test("pins: a minor release whose pins were left behind fails loud and names the fix", () => {
  const { failures } = evaluate({
    ...stubFs(releaseTree("0.12.0", "v0.11")),
    discoveredDirs: ALL_ACTIONS,
    atRelease: true,
  });
  const pins = failures.find((f) => f.includes("tools/action-pins.json"));
  assert.ok(pins, `expected a pins failure, got: ${failures.join(", ")}`);
  assert.match(pins, /v0\.11' is not on the minor line of the released version '0\.12\.0'/);
  // The message carries the convergence sequence, not just the verdict: what
  // to bump, why it cannot happen earlier, and how the floating tag moves.
  assert.match(pins, /bump floating, exact and rootExact/);
  assert.match(pins, /check-uses-refs refuses a documented ref no tag publishes yet/);
  assert.match(pins, /gh api -X PATCH repos\/<owner>\/<repo>\/git\/refs\/tags\/v0\.12/);
});

test("pins: the invariant is release-only — the same drifted tree without the flag stays green", () => {
  // The gating itself is pinned here: a pre-merge run (CI's Verify job, a
  // release pull request) must not demand a pins refresh the tag-existence
  // rule makes unsatisfiable before the release exists.
  const { failures } = evaluate({
    ...stubFs(releaseTree("0.12.0", "v0.11")),
    discoveredDirs: ALL_ACTIONS,
  });
  assert.deepEqual(failures, []);
});

test("pins: a release shipping without the pins manifest fails", () => {
  const tree = releaseTree("0.11.1", "v0.11");
  delete tree["tools/action-pins.json"];
  const { failures } = evaluate({
    ...stubFs(tree),
    discoveredDirs: ALL_ACTIONS,
    atRelease: true,
  });
  assert.ok(
    failures.some((f) => f.includes("tools/action-pins.json is missing")),
    `expected missing-manifest failure, got: ${failures.join(", ")}`,
  );
});

test("pins: a release shipping without the release-please manifest fails", () => {
  const tree = releaseTree("0.11.1", "v0.11");
  delete tree[".release-please-manifest.json"];
  const { failures } = evaluate({
    ...stubFs(tree),
    discoveredDirs: ALL_ACTIONS,
    atRelease: true,
  });
  assert.ok(
    failures.some((f) => f.includes(".release-please-manifest.json is missing")),
    `expected missing-manifest failure, got: ${failures.join(", ")}`,
  );
});

test("pins: a floating pin off the vX.Y grammar fails rather than comparing garbage", () => {
  const { failures } = evaluate({
    ...stubFs(releaseTree("0.11.1", "latest")),
    discoveredDirs: ALL_ACTIONS,
    atRelease: true,
  });
  const pins = failures.find((f) => f.includes("'floating' must be"));
  assert.ok(pins, `expected a shape failure, got: ${failures.join(", ")}`);
  assert.match(pins, /"latest"/);
});

test("pins: a release-please manifest with no version under '.' fails", () => {
  const tree = releaseTree("0.11.1", "v0.11");
  tree[".release-please-manifest.json"] = "{}";
  const { failures } = evaluate({
    ...stubFs(tree),
    discoveredDirs: ALL_ACTIONS,
    atRelease: true,
  });
  assert.ok(
    failures.some((f) => f.includes("expected the released version")),
    `expected released-version failure, got: ${failures.join(", ")}`,
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

// ── Wiring ────────────────────────────────────────────────────────────────

test("wiring: release.yml turns the release-only invariant on at the release SHA", () => {
  // The flag is the difference between invariant 7 running and not: without
  // it the release verification silently narrows back to invariants 1–6, and
  // a minor release could ship its pins behind. Pinned here so unwiring it
  // is a failed test rather than a quiet return to the #447 status quo.
  const release = readFileSync(
    fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url)),
    "utf8",
  );
  assert.match(release, /run: node tools\/check-release-invariants\.mjs --at-release/);
});
