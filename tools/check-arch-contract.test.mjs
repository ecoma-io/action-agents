// Tests for the contract gate's own refusal behaviour.
//
// The gate exists to fail loudly when the pinned Archkeep contract moves,
// so the property under test here is the failure itself: a tampered golden
// must be reported as a divergence naming its scenario, a missing golden
// must be reported as unpinned, and a key-reordered golden must NOT be one
// (the comparison is over canonical text, not raw bytes). No spawns: these
// exercise the gate's pure halves against canned inputs; the real runs are
// what `pnpm arch:contract` does in CI.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { SCENARIOS, compareGolden, normalizeResult } from "./check-arch-contract.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

test("the gate pins one golden per scenario, each named", () => {
  assert.deepEqual(
    SCENARIOS.map((scenario) => scenario.name),
    ["pass", "findings", "resolved", "no-verdict", "no-envelope", "family"],
  );
});

test("an identical golden is not a divergence", () => {
  const actual = { exitCode: 0, envelope: { status: "ok" }, reader: { verdict: "pass" } };
  assert.equal(
    compareGolden("pass", actual, {
      exitCode: 0,
      envelope: { status: "ok" },
      reader: { verdict: "pass" },
    }),
    null,
  );
});

test("a tampered golden is a divergence naming the scenario", () => {
  const actual = { exitCode: 1, envelope: null, reader: { verdict: "unknown" } };
  const tampered = { exitCode: 0, envelope: null, reader: { verdict: "unknown" } };
  const divergence = compareGolden("findings", actual, tampered);
  assert.match(String(divergence), /^findings:/);
  assert.match(String(divergence), /diverged from the pinned golden/);
});

test("a missing golden is reported as unpinned, with the bless instruction", () => {
  const divergence = compareGolden("family", { exitCode: 3 }, undefined);
  assert.match(String(divergence), /^family: no golden/);
  assert.match(String(divergence), /--bless/);
});

test("a key-reordered golden is not a divergence — the comparison is canonical", () => {
  const actual = { exitCode: 0, reader: { verdict: "pass", stale: false }, envelope: null };
  const reordered = { envelope: null, reader: { stale: false, verdict: "pass" }, exitCode: 0 };
  assert.equal(compareGolden("pass", actual, reordered), null);
});

test("normalization substitutes run-relative facts and records the reader's verdict", () => {
  const root = mkdtempSync(join(tmpdir(), "arch-contract-test-"));
  try {
    const envelope = {
      schemaVersion: 2,
      tool: { name: "@ecoma-io/archkeep", version: "9.9.9" },
      command: "delta",
      workspace: {
        root,
        provider: "native",
        marker: "archkeep.json",
        provenance: { commit: HEAD, remote: null, dirty: false },
      },
      status: "ok",
      exitCode: 0,
      coverage: {
        complete: true,
        projects: 2,
        analyzedFiles: 2,
        imports: 0,
        notAnalyzed: [],
        blindSpots: [],
        notes: [],
      },
      decision: { verdict: "pass", reason: "" },
      result: {
        baseline: {
          path: join(root, "base.json"),
          tool: { name: "@ecoma-io/archkeep", version: "9.9.9" },
          provider: "native",
          provenance: { commit: BASE, remote: null, dirty: false },
          policyFingerprint: "fp-base",
          records: 0,
          projects: 2,
        },
        head: {
          provenance: { commit: HEAD, remote: null, dirty: false },
          policyFingerprint: "fp-head",
          records: 0,
          projects: 2,
        },
        policyChanged: false,
        summary: {
          introduced: 0,
          introducedWaived: 0,
          resolved: 0,
          unchanged: 0,
          unknown: 0,
          unresolvable: { introduced: 0, resolved: 0, unchanged: 0, unknown: 0 },
        },
        violations: { introduced: [], resolved: [], unchanged: [], unknown: [] },
        unresolvable: { introduced: [], resolved: [], unchanged: [], unknown: [] },
        classifications: [],
        affected: { projects: [], boundaries: [], constraints: [], decisions: [] },
      },
    };
    const scenario = SCENARIOS.find((candidate) => candidate.name === "pass");
    assert.notEqual(scenario, undefined);
    const normalized = normalizeResult(/** @type {{ name: "pass" }} */ (scenario), {
      root,
      baseCommit: BASE,
      headCommit: HEAD,
      capture: { exit: 0, stdout: "" },
      delta: { exitCode: 0, stdout: JSON.stringify(envelope), stderr: `${root}/law: refused` },
      repeatable: true,
    });
    assert.equal(normalized.exitCode, 0);
    assert.equal(normalized.envelope.tool.version, "@version@");
    assert.equal(normalized.envelope.result.baseline.tool.version, "@version@");
    assert.equal(normalized.envelope.workspace.root, "@tree@");
    assert.equal(normalized.envelope.workspace.provenance.commit, "@head-commit@");
    assert.equal(normalized.envelope.result.baseline.provenance.commit, "@base-commit@");
    assert.equal(normalized.envelope.result.baseline.path, "@tree@/base.json");
    assert.deepEqual(normalized.reader, { verdict: "pass", stale: false, incompleteness: null });
    assert.ok(normalized.repeatable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the empty-stdout lane records no envelope and an incomplete unknown verdict", () => {
  const root = mkdtempSync(join(tmpdir(), "arch-contract-test-"));
  try {
    const scenario = SCENARIOS.find((candidate) => candidate.name === "no-envelope");
    assert.notEqual(scenario, undefined);
    const normalized = normalizeResult(/** @type {{ name: "no-envelope" }} */ (scenario), {
      root,
      baseCommit: BASE,
      headCommit: HEAD,
      capture: { exit: 0, stdout: "" },
      delta: {
        exitCode: 3,
        stdout: "",
        stderr: `${root}/module-boundaries.config.mjs is malformed`,
      },
      repeatable: true,
    });
    assert.equal(normalized.exitCode, 3);
    assert.equal(normalized.stdoutBytes, 0);
    assert.equal(normalized.envelope, null);
    assert.equal(normalized.reader.verdict, "unknown");
    assert.equal(normalized.reader.incompleteness?.reason, "incomplete");
    assert.match(String(normalized.reader.incompleteness?.note), /exit is 3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an envelope contradicting the manifest's exit is refused, never blessed", () => {
  const root = mkdtempSync(join(tmpdir(), "arch-contract-test-"));
  try {
    writeFileSync(join(root, "does-not-matter"), "");
    const scenario = SCENARIOS.find((candidate) => candidate.name === "pass");
    assert.notEqual(scenario, undefined);
    assert.throws(
      () =>
        normalizeResult(/** @type {{ name: "pass" }} */ (scenario), {
          root,
          baseCommit: BASE,
          headCommit: HEAD,
          capture: { exit: 0, stdout: "" },
          // Exit 1 recorded, exit 0 claimed: the coin-flip pair the reader
          // refuses, and the gate must not paper over it.
          delta: { exitCode: 1, stdout: coherentEnvelope(0), stderr: "" },
          repeatable: true,
        }),
      /manifest records 1/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A minimal coherent `ok` envelope claiming the given exit.
 *
 * @param {number} exitCode
 * @returns {string}
 */
function coherentEnvelope(exitCode) {
  return JSON.stringify({
    schemaVersion: 2,
    tool: { name: "@ecoma-io/archkeep", version: "9.9.9" },
    command: "delta",
    workspace: {
      root: "/nowhere",
      provider: "native",
      marker: "archkeep.json",
      provenance: { commit: HEAD, remote: null, dirty: false },
    },
    status: "ok",
    exitCode,
    coverage: {
      complete: true,
      projects: 2,
      analyzedFiles: 2,
      imports: 0,
      notAnalyzed: [],
      blindSpots: [],
      notes: [],
    },
    decision: { verdict: "pass", reason: "" },
    result: {
      baseline: {
        path: "/nowhere/base.json",
        tool: { name: "@ecoma-io/archkeep", version: "9.9.9" },
        provider: "native",
        provenance: { commit: BASE, remote: null, dirty: false },
        policyFingerprint: "fp-base",
        records: 0,
        projects: 2,
      },
      head: {
        provenance: { commit: HEAD, remote: null, dirty: false },
        policyFingerprint: "fp-head",
        records: 0,
        projects: 2,
      },
      policyChanged: false,
      summary: {
        introduced: 0,
        introducedWaived: 0,
        resolved: 0,
        unchanged: 0,
        unknown: 0,
        unresolvable: { introduced: 0, resolved: 0, unchanged: 0, unknown: 0 },
      },
      violations: { introduced: [], resolved: [], unchanged: [], unknown: [] },
      unresolvable: { introduced: [], resolved: [], unchanged: [], unknown: [] },
      classifications: [],
      affected: { projects: [], boundaries: [], constraints: [], decisions: [] },
    },
  });
}
