// Tests for check-skills.mjs and sync-skills.mjs.
//
// `pinnedSourceVersion`, `sha256`, `evaluate`, `parseArgs` and `buildManifest`
// take every fact they need as an argument, so these run with no repository and
// no filesystem. What is deliberately NOT tested is `readFacts` and the two
// `main` functions: they exist to read and write real paths, and a test that
// stubbed them would only pin the stub. The real gate runs in CI against the
// real tree.
//
// Every failure case below goes red in the SILENT direction first. A vendored
// skill that drifted from upstream still looks like a working skill — the agent
// loads it and follows it — so the whole point of the gate is to make a
// difference that changes nothing visible read as a failure. The case that
// removes the check entirely is `evaluate` with an empty manifest, which must
// fail loudly rather than report a clean scan of nothing.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SKILL_TREES,
  SOURCE_PACKAGE,
  evaluate,
  pinnedSourceVersion,
  sha256,
} from "./check-skills.mjs";
import { DEFAULT_SOURCE, TREE_README, buildManifest, parseArgs } from "./sync-skills.mjs";

const CONTENTS = "---\nname: arch-check\n---\n\nBody.\n";
const DIGEST = sha256(CONTENTS);
const NOTE = "# Vendored — do not edit\n";

/** A tree map holding the same one skill in every directory the gate checks. */
function everyTree(files) {
  return Object.fromEntries(SKILL_TREES.map((tree) => [tree, files]));
}

/** A manifest recording exactly `arch-check/SKILL.md` at `version`. */
function manifestFor(version) {
  return { source: { version }, skills: { "arch-check/SKILL.md": DIGEST } };
}

/** The same, plus the README `sync-skills.mjs` writes into each tree. */
function manifestWithNote(version) {
  return { ...manifestFor(version), notes: { "README.md": sha256(NOTE) } };
}

test("pinnedSourceVersion reads an exact pin from devDependencies", () => {
  const result = pinnedSourceVersion({ devDependencies: { [SOURCE_PACKAGE]: "0.11.1" } });
  assert.deepEqual(result, { version: "0.11.1" });
});

test("pinnedSourceVersion accepts a prerelease pin", () => {
  const result = pinnedSourceVersion({ dependencies: { [SOURCE_PACKAGE]: "1.0.0-rc.1" } });
  assert.deepEqual(result, { version: "1.0.0-rc.1" });
});

test("pinnedSourceVersion refuses a range, which could move under the copies", () => {
  for (const range of ["^0.11.1", "~0.11.1", "*", ">=0.11.0 <0.12.0", "latest"]) {
    const result = pinnedSourceVersion({ devDependencies: { [SOURCE_PACKAGE]: range } });
    assert.ok("error" in result, `${range} should be refused`);
    assert.match(result.error, /range/);
  }
});

test("pinnedSourceVersion refuses a tree where the package is not a dependency at all", () => {
  const result = pinnedSourceVersion({ devDependencies: { prettier: "3.9.6" } });
  assert.ok("error" in result);
  assert.match(result.error, /not a dependency/);
});

test("evaluate passes when both trees match the manifest and the pin", () => {
  const { failures, lines } = evaluate({
    pinned: { version: "0.11.1" },
    manifest: manifestFor("0.11.1"),
    trees: everyTree({ "arch-check/SKILL.md": CONTENTS }),
  });
  assert.deepEqual(failures, []);
  assert.match(lines[0], /^1 skill vendored from @ecoma-io\/archkeep@0\.11\.1/);
});

test("evaluate fails on an edited vendored skill, in the tree that carries it", () => {
  const trees = everyTree({ "arch-check/SKILL.md": CONTENTS });
  trees[SKILL_TREES[0]] = { "arch-check/SKILL.md": `${CONTENTS}edited by hand\n` };

  const { failures } = evaluate({
    pinned: { version: "0.11.1" },
    manifest: manifestFor("0.11.1"),
    trees,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], new RegExp(`^${SKILL_TREES[0]}/arch-check/SKILL\\.md does not match`));
  assert.match(failures[0], /fix it there and re-sync/);
});

test("evaluate fails when one tree was updated and the other forgotten", () => {
  // The direction that would otherwise ship Codex one version of a skill and
  // Claude Code another, with both files present and both looking fine.
  const stale = "---\nname: arch-check\n---\n\nOld body.\n";
  const trees = everyTree({ "arch-check/SKILL.md": CONTENTS });
  trees[SKILL_TREES[1]] = { "arch-check/SKILL.md": stale };

  const { failures } = evaluate({
    pinned: { version: "0.11.1" },
    manifest: manifestFor("0.11.1"),
    trees,
  });
  assert.equal(failures.length, 1);
  assert.ok(failures[0].startsWith(`${SKILL_TREES[1]}/`));
});

test("evaluate fails when a skill is missing from one tree", () => {
  const trees = everyTree({ "arch-check/SKILL.md": CONTENTS });
  trees[SKILL_TREES[0]] = {};

  const { failures } = evaluate({
    pinned: { version: "0.11.1" },
    manifest: manifestFor("0.11.1"),
    trees,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /is missing/);
});

test("evaluate fails on a file the vendored release does not contain", () => {
  const trees = everyTree({ "arch-check/SKILL.md": CONTENTS, "arch-local/SKILL.md": CONTENTS });

  const { failures } = evaluate({
    pinned: { version: "0.11.1" },
    manifest: manifestFor("0.11.1"),
    trees,
  });
  assert.equal(failures.length, SKILL_TREES.length);
  for (const failure of failures) assert.match(failure, /is not part of the vendored release/);
});

test("evaluate fails when the dependency moved and the copies did not", () => {
  // The stale case a byte-comparison cannot see: both trees agree perfectly
  // with each other and with the manifest, and all of them describe a CLI
  // this repository no longer installs.
  const { failures } = evaluate({
    pinned: { version: "0.12.0" },
    manifest: manifestFor("0.11.1"),
    trees: everyTree({ "arch-check/SKILL.md": CONTENTS }),
  });
  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /synced from @ecoma-io\/archkeep@0\.11\.1, but this repository now pins 0\.12\.0/,
  );
});

test("evaluate reports the pin's own error rather than judging against it", () => {
  const { failures } = evaluate({
    pinned: { error: "the pin is a range" },
    manifest: manifestFor("0.11.1"),
    trees: everyTree({ "arch-check/SKILL.md": CONTENTS }),
  });
  assert.deepEqual(failures, ["the pin is a range"]);
});

test("evaluate fails loudly on an empty manifest instead of passing an empty tree", () => {
  const { failures } = evaluate({
    pinned: { version: "0.11.1" },
    manifest: { source: { version: "0.11.1" }, skills: {} },
    trees: everyTree({}),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /records no skills/);
});

test("evaluate fails when the manifest is unreadable", () => {
  const { failures } = evaluate({
    pinned: { version: "0.11.1" },
    manifest: null,
    trees: everyTree({ "arch-check/SKILL.md": CONTENTS }),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /nothing pins the vendored skills to a release/);
});

test("sha256 is content-addressed, so a reformat is a difference", () => {
  assert.notEqual(sha256("a\n"), sha256("a\n\n"));
  assert.equal(sha256("a\n"), sha256("a\n"));
});

test("parseArgs defaults to the installed package's skills directory", () => {
  assert.deepEqual(parseArgs([]), { from: DEFAULT_SOURCE });
});

test("parseArgs takes the directory after --from", () => {
  assert.deepEqual(parseArgs(["--from", "../archkeep/skills"]), { from: "../archkeep/skills" });
});

test("parseArgs refuses a --from with no directory after it", () => {
  for (const argv of [["--from"], ["--from", "--other"]]) {
    const result = parseArgs(argv);
    assert.ok("error" in result, `${JSON.stringify(argv)} should be refused`);
  }
});

test("buildManifest records the source and one hash per skill, sorted", () => {
  const manifest = buildManifest("0.11.1", {
    "arch-review/SKILL.md": "b\n",
    "arch-check/SKILL.md": CONTENTS,
  });
  assert.equal(manifest.source.package, SOURCE_PACKAGE);
  assert.equal(manifest.source.version, "0.11.1");
  assert.equal(manifest.source.ref, "v0.11.1");
  assert.deepEqual(Object.keys(manifest.skills), ["arch-check/SKILL.md", "arch-review/SKILL.md"]);
  assert.equal(manifest.skills["arch-check/SKILL.md"], DIGEST);
});

test("buildManifest output is what evaluate accepts, so the writer and the law agree", () => {
  const skills = { "arch-check/SKILL.md": CONTENTS };
  const { failures } = evaluate({
    pinned: { version: "0.11.1" },
    manifest: buildManifest("0.11.1", skills),
    trees: everyTree(skills),
  });
  assert.deepEqual(failures, []);
});

test("evaluate accepts the note sync-skills writes beside the copies", () => {
  const { failures, lines } = evaluate({
    pinned: { version: "0.11.1" },
    manifest: manifestWithNote("0.11.1"),
    trees: everyTree({ "arch-check/SKILL.md": CONTENTS, "README.md": NOTE }),
  });
  assert.deepEqual(failures, []);
  // The note is held to its hash but is not a skill, so it must not be counted
  // as one — a summary line that says "2 skills" when one is a README is a
  // gate reporting a roster nobody shipped.
  assert.match(lines[0], /^1 skill vendored/);
});

test("evaluate fails on an edited note, and says to change the script", () => {
  const trees = everyTree({ "arch-check/SKILL.md": CONTENTS, "README.md": NOTE });
  trees[SKILL_TREES[0]] = { "arch-check/SKILL.md": CONTENTS, "README.md": `${NOTE}tweak\n` };

  const { failures } = evaluate({
    pinned: { version: "0.11.1" },
    manifest: manifestWithNote("0.11.1"),
    trees,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /written by scripts\/sync-skills\.mjs/);
  assert.doesNotMatch(failures[0], /copy of ecoma-io\/archkeep/);
});

test("evaluate fails when the note is missing from one tree", () => {
  const trees = everyTree({ "arch-check/SKILL.md": CONTENTS, "README.md": NOTE });
  trees[SKILL_TREES[1]] = { "arch-check/SKILL.md": CONTENTS };

  const { failures } = evaluate({
    pinned: { version: "0.11.1" },
    manifest: manifestWithNote("0.11.1"),
    trees,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /README\.md is missing/);
});

test("evaluate still fails loudly when only notes are recorded and no skill is", () => {
  // The note must not be able to stand in for the roster: a manifest holding
  // nothing but a README would otherwise pass a tree with no skills in it.
  const { failures } = evaluate({
    pinned: { version: "0.11.1" },
    manifest: { source: { version: "0.11.1" }, skills: {}, notes: { "README.md": sha256(NOTE) } },
    trees: everyTree({ "README.md": NOTE }),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /records no skills/);
});

test("buildManifest keeps upstream copies and the written note in separate maps", () => {
  const manifest = buildManifest(
    "0.11.1",
    { "arch-check/SKILL.md": CONTENTS },
    { "README.md": NOTE },
  );
  assert.deepEqual(Object.keys(manifest.skills), ["arch-check/SKILL.md"]);
  assert.deepEqual(Object.keys(manifest.notes), ["README.md"]);
});

test("the shipped note names both trees and says not to edit", () => {
  // It is the only thing a reader who lands inside one tree ever sees, so the
  // two facts it exists to carry are pinned rather than left to a later edit.
  for (const tree of SKILL_TREES) assert.ok(TREE_README.includes(tree.replace(/\/$/, "")));
  assert.match(TREE_README, /do not edit/i);
  assert.match(TREE_README, /check-skills/);
});
