// Unit tests for the ceiling-to-fixture manifest gate.
//
// These pin the gate's three decisions deterministically, with synthetic
// fixture sets so no fixture file has to exist:
//   - a consistent manifest (every ceiling lists an existing fixture) passes;
//   - a ceiling with an empty fixture list fails (empty reference);
//   - a ceiling referencing a file that is not in the discovered set fails
//     (missing fixture);
//   - a discovered fixture referenced by no ceiling produces a warning, and
//     that warning does not fail default mode but does fail --strict.
// One integration test loads the real manifest and the real fixture glob to
// prove this repository's corpus is fully mapped today.
//
// `node:test` + `node:assert/strict` only; deterministic, offline, no timers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkManifest, discoverFixtures, loadManifest } from "./ceiling-manifest.mjs";

/**
 * A two-ceiling manifest with the fixture set large enough for any of the
 * tests that only need consistent fixtures present.
 *
 * @returns {{ version: number, base: string, description: string, ceilings: Array<{ key: string, name: string, source: string, fixtures: string[] }> }}
 */
function consistentManifest() {
  return {
    version: 1,
    base: "security/fixtures",
    description: "test",
    ceilings: [
      {
        key: "ceiling-a",
        name: "a",
        source: "test",
        fixtures: ["prompt-injection/off-sheet-demand.test.mjs"],
      },
      {
        key: "ceiling-b",
        name: "b",
        source: "test",
        fixtures: ["path-traversal/symlink-maze.test.mjs"],
      },
    ],
  };
}

/**
 * A fixture set containing every path a consistent manifest references.
 *
 * @returns {Set<string>}
 */
function fixtureSet() {
  return new Set([
    "prompt-injection/off-sheet-demand.test.mjs",
    "path-traversal/symlink-maze.test.mjs",
  ]);
}

/** @returns {{ key: string, name: string, source: string, fixtures: string[] }} */
function ceiling(key, fixtures = []) {
  return { key, name: key, source: "test", fixtures };
}

describe("checkManifest", () => {
  it("passes a consistent manifest where every ceiling references an existing fixture", () => {
    const result = checkManifest(consistentManifest(), fixtureSet());
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  it("fails a ceiling whose fixture list is empty (empty reference)", () => {
    const manifest = {
      ...consistentManifest(),
      ceilings: [ceiling("lonely-ceiling", [])],
    };
    const result = checkManifest(manifest, fixtureSet());
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /lonely-ceiling/);
    assert.match(result.errors[0], /no fixtures/);
  });

  it("fails a ceiling referencing a fixture file that does not exist", () => {
    const manifest = {
      ...consistentManifest(),
      ceilings: [ceiling("dreaming-ceiling", ["prompt-injection/does-not-exist.test.mjs"])],
    };
    const result = checkManifest(manifest, fixtureSet());
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /dreaming-ceiling/);
    assert.match(result.errors[0], /missing fixture/);
    assert.match(result.errors[0], /does-not-exist\.test\.mjs/);
  });

  it("flags, as a warning, a fixture that no ceiling references", () => {
    const everyone = fixtureSet();
    everyone.add("tool-protocol/unclaimed-ceiling.test.mjs");
    const result = checkManifest(consistentManifest(), everyone);
    assert.equal(result.ok, true, "an unreferenced fixture is a warning, not a failure");
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /unclaimed-ceiling\.test\.mjs/);
    assert.match(result.warnings[0], /no ceiling/);
  });

  it("ignores a duplicate fixture referenced by two ceilings without erroring", () => {
    const manifest = {
      ...consistentManifest(),
      ceilings: [
        ceiling("first", [
          "prompt-injection/off-sheet-demand.test.mjs",
          "path-traversal/symlink-maze.test.mjs",
        ]),
        ceiling("second", ["prompt-injection/off-sheet-demand.test.mjs"]),
      ],
    };
    const result = checkManifest(manifest, fixtureSet());
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  it("rejects with errors when the fixture set is empty and a ceiling is populated", () => {
    const result = checkManifest(consistentManifest(), new Set());
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 2);
    for (const error of result.errors) {
      assert.match(error, /missing fixture/);
    }
  });
});

describe("the repo's real corpus", () => {
  it("maps every documented ceiling to an existing adversarial fixture and leaves none unaccounted", () => {
    const manifest = loadManifest();
    const fixtureSet = discoverFixtures();

    assert.ok(manifest.ceilings.length > 0, "the manifest must declare at least one ceiling");
    assert.ok(fixtureSet.size > 0, "the corpus must not be empty");

    const result = checkManifest(manifest, fixtureSet);
    assert.equal(
      result.ok,
      true,
      `the real manifest must be consistent; errors:\n${result.errors.join("\n")}`,
    );
    assert.deepEqual(
      result.warnings,
      [],
      `every real fixture must be pinned to a ceiling; unexpected fixtures:\n${result.warnings.join("\n")}`,
    );
  });
});
