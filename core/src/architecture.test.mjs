// Tests for the Archkeep evidence reader boundary.
//
// Canned bytes only: every envelope here is written by hand from the
// measured contract at the pinned Archkeep, every manifest is the recipe's
// shape, and no test spawns, dials or reads a clock. The reader's whole job
// is judgement over bytes it is handed, so the tests are the judgement's
// cases: the caps, the precedence law, the family and schema markers, the
// coherence table, the staleness law, and the frozen shape of what survives.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { WorkspaceRefusal, createWorkspace } from "./workspace.mjs";
import {
  ArchitectureReaderError,
  DELTA_COMMAND,
  ENVELOPE_SCHEMA_VERSION,
  MAX_MANIFEST_BYTES,
  MAX_REPORT_BYTES,
  TOOL_NAME,
  readArchitectureReport,
} from "./architecture.mjs";

/** The head every fresh read expects — the commit the run reviews. */
const HEAD = "a".repeat(40);
/** The baseline side of every compare. */
const BASE = "b".repeat(40);
/** A foreign head a stale report may be pinned to. */
const OTHER = "c".repeat(40);

const REPORT = "arch-report.json";
const MANIFEST = "arch-manifest.json";

/** @type {string[]} */
const roots = [];

/**
 * A fresh workspace holding the named files — the reader's whole filesystem.
 *
 * @param {Record<string, string>} files
 * @returns {{ workspace: ReturnType<typeof createWorkspace>, root: string }}
 */
function setup(files) {
  const root = mkdtempSync(p.join(tmpdir(), "arch-reader-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(p.join(root, name), content);
  }
  return { workspace: createWorkspace({ root }), root };
}

/**
 * Deep-merges canned envelopes: nested objects merge, everything else
 * (arrays included) is replaced by the override.
 *
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} over
 * @returns {Record<string, unknown>}
 */
function merge(base, over) {
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prior = out[key];
    out[key] =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      prior !== null &&
      typeof prior === "object" &&
      !Array.isArray(prior)
        ? merge(
            /** @type {Record<string, unknown>} */ (prior),
            /** @type {Record<string, unknown>} */ (value),
          )
        : value;
  }
  return out;
}

/**
 * The recipe's manifest — the exit record every precedence judgement reads.
 *
 * @param {number} exitCode
 * @returns {string}
 */
function manifest(exitCode) {
  return JSON.stringify({
    exitCode,
    stderrDigest: "0".repeat(64),
    base: { capturePath: ".archkeep/base.json", commit: BASE },
    head: { commit: HEAD },
  });
}

/**
 * A coherent `ok` delta envelope — the smallest honest shape every case
 * starts from, measured from the pinned Archkeep's own writer.
 *
 * @param {Record<string, unknown>} [over]
 * @returns {string}
 */
function envelope(over = {}) {
  return JSON.stringify(
    merge(
      {
        schemaVersion: 2,
        tool: { name: "@ecoma-io/archkeep", version: "0.29.0" },
        command: "delta",
        workspace: {
          root: "/runner/workspace",
          provider: "native",
          marker: "archkeep.json",
          provenance: { commit: HEAD, remote: "git@github.com:acme/widgets.git", dirty: false },
        },
        status: "ok",
        exitCode: 0,
        coverage: {
          complete: true,
          projects: 2,
          analyzedFiles: 12,
          imports: 40,
          notAnalyzed: [],
          blindSpots: [],
          notes: [],
        },
        decision: { verdict: "pass", reason: "" },
        result: {
          baseline: {
            path: ".archkeep/base.json",
            tool: "0.29.0",
            provider: "native",
            provenance: { commit: BASE, remote: "", dirty: false },
            policyFingerprint: "fp-base",
            records: 3,
            projects: 2,
          },
          head: {
            provenance: { commit: HEAD, remote: "", dirty: false },
            policyFingerprint: "fp-head",
            records: 4,
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
      },
      over,
    ),
  );
}

/**
 * One introduced violation, the full measured item shape.
 *
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, unknown>}
 */
function violation(over = {}) {
  return merge(
    {
      messageId: "noRelativeOrAbsoluteImportsAcrossLibraries",
      sourceProject: "triage",
      target: "#review/src/index.mjs",
      targetIsSpecifier: true,
      constraint: "triage may not import review",
      baseCount: 0,
      headCount: 1,
      baseSites: [],
      headSites: [
        {
          file: "triage/src/index.mjs",
          line: 11,
          column: 1,
          specifier: "#review/src/index.mjs",
          kind: "value",
        },
      ],
      classification: "DRIFT",
      reason: "absent at base",
      waived: false,
      waivedBy: null,
    },
    over,
  );
}

/**
 * Reads through the seam, the way every case does.
 *
 * @param {{ report?: string | null, manifest?: string | null, headSha?: string }} [options]
 * @returns {import("./architecture.mjs").ArchitectureEvidence}
 */
function read(options = {}) {
  /** @type {Record<string, string>} */
  const files = {};
  if (options.manifest !== null) files[MANIFEST] = options.manifest ?? manifest(0);
  if (options.report !== null) files[REPORT] = options.report ?? envelope();
  const { workspace } = setup(files);
  return readArchitectureReport({
    workspace,
    reportPath: REPORT,
    manifestPath: MANIFEST,
    expect: { headSha: options.headSha ?? HEAD },
  });
}

/**
 * Asserts the read ends in the named refusal arm with a message containing
 * every needle — reason-parity: the refusal must name its reason.
 *
 * @param {() => unknown} act
 * @param {"reader" | "validation"} arm
 * @param {...string} needles
 */
function refuses(act, arm, ...needles) {
  let caught;
  try {
    act();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ArchitectureReaderError);
  const failure = /** @type {ArchitectureReaderError} */ (caught);
  expect(failure.arm).toBe(arm);
  expect(failure.path).toBe(REPORT);
  for (const needle of needles) expect(failure.message).toContain(needle);
}

afterAll(() => {
  // Left to the OS tmp cleaner; the trees are empty cans.
  roots.length = 0;
});

describe("the frozen protocol constants", () => {
  it("pins the byte caps, the schema major, the tool's npm name and the command", () => {
    expect(MAX_REPORT_BYTES).toBe(2 * 2 ** 20);
    expect(MAX_MANIFEST_BYTES).toBe(64 * 2 ** 10);
    expect(ENVELOPE_SCHEMA_VERSION).toBe(2);
    expect(TOOL_NAME).toBe("@ecoma-io/archkeep");
    expect(DELTA_COMMAND).toBe("delta");
  });

  it("refuses a call without a workspace seam, paths or an expected head", () => {
    const { workspace } = setup({});
    expect(() =>
      readArchitectureReport({
        workspace: /** @type {any} */ (null),
        reportPath: REPORT,
        manifestPath: MANIFEST,
        expect: { headSha: HEAD },
      }),
    ).toThrow(TypeError);
    expect(() =>
      readArchitectureReport({
        workspace,
        reportPath: "",
        manifestPath: MANIFEST,
        expect: { headSha: HEAD },
      }),
    ).toThrow(TypeError);
    expect(() =>
      readArchitectureReport({
        workspace,
        reportPath: REPORT,
        manifestPath: MANIFEST,
        expect: /** @type {any} */ ({}),
      }),
    ).toThrow(TypeError);
  });
});

describe("the manifest: the precedence fact", () => {
  it("refuses an absent manifest on the reader arm, naming it", () => {
    const { workspace } = setup({ [REPORT]: envelope() });
    let caught;
    try {
      readArchitectureReport({
        workspace,
        reportPath: REPORT,
        manifestPath: MANIFEST,
        expect: { headSha: HEAD },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ArchitectureReaderError);
    const failure = /** @type {ArchitectureReaderError} */ (caught);
    expect(failure.arm).toBe("reader");
    expect(failure.path).toBe(MANIFEST);
    expect(failure.message).toContain("absent");
  });

  it("refuses a manifest that is not the recipe's shape", () => {
    const { workspace } = setup({ [REPORT]: envelope(), [MANIFEST]: '{"exit": "zero"}' });
    expect(() =>
      readArchitectureReport({
        workspace,
        reportPath: REPORT,
        manifestPath: MANIFEST,
        expect: { headSha: HEAD },
      }),
    ).toThrow(/manifest shape/);
  });

  it("refuses a manifest past its byte cap", () => {
    const { workspace } = setup({
      [REPORT]: envelope(),
      [MANIFEST]: `${" ".repeat(MAX_MANIFEST_BYTES)}\n${manifest(0)}`,
    });
    expect(() =>
      readArchitectureReport({
        workspace,
        reportPath: REPORT,
        manifestPath: MANIFEST,
        expect: { headSha: HEAD },
      }),
    ).toThrow(/manifest cap/);
  });
});

describe("the byte cap: capacity before precedence", () => {
  it("refuses a report past the 2 MiB cap on the reader arm, whatever the exit", () => {
    const pad = " ".repeat(MAX_REPORT_BYTES + 1);
    refuses(
      () => read({ report: `{"pad":"${pad}"}` }),
      "reader",
      "byte cap",
      "refused as capacity",
    );
    refuses(
      () => read({ report: `{"pad":"${pad}"}`, manifest: manifest(3) }),
      "reader",
      "byte cap",
      "refused as capacity",
    );
  });
});

describe("the precedence law over absent and unparseable bytes", () => {
  it("refuses absent-though-configured: no report beside exit 0", () => {
    refuses(() => read({ report: null }), "reader", "absent", "exit 0", "absent-though-configured");
  });

  it("records unknown — incomplete — for an absent report beside a nonzero exit", () => {
    const evidence = read({ report: null, manifest: manifest(1) });
    expect(evidence.verdict).toBe("unknown");
    expect(evidence.incompleteness?.reason).toBe("incomplete");
    expect(evidence.incompleteness?.note).toContain("absent");
    expect(evidence.incompleteness?.note).toContain("1");
    expect(evidence.reportSha256).toBeNull();
    expect(evidence.introduced).toEqual([]);
    expect(evidence.coverage.complete).toBe(false);
  });

  it("refuses an unparseable report beside exit 0 — a contradiction, not evidence", () => {
    refuses(() => read({ report: "not json at all" }), "validation", "does not parse", "exit 0");
  });

  it("records unknown for an unparseable report beside a nonzero exit, with the digest kept", () => {
    const evidence = read({ report: "{broken", manifest: manifest(3) });
    expect(evidence.verdict).toBe("unknown");
    expect(evidence.incompleteness?.reason).toBe("incomplete");
    expect(evidence.incompleteness?.note).toContain("3");
    expect(evidence.reportSha256).toBe(
      createHash("sha256").update("{broken", "utf8").digest("hex"),
    );
  });

  it("refuses a report claiming an exit the manifest does not record — a coin-flip read", () => {
    refuses(() => read({ manifest: manifest(1) }), "validation", "manifest records 1");
  });

  it("records a coherent findings report's own fail verdict beside its matching nonzero exit", () => {
    const evidence = read({
      manifest: manifest(1),
      report: envelope({
        status: "findings",
        exitCode: 1,
        decision: { verdict: "fail", reason: "" },
        result: {
          summary: { introduced: 1, introducedWaived: 0, resolved: 0, unchanged: 0, unknown: 0 },
          violations: { introduced: [violation()], resolved: [], unchanged: [], unknown: [] },
        },
      }),
    });
    expect(evidence.verdict).toBe("fail");
    expect(evidence.coverage.complete).toBe(true);
    expect(evidence.coverage.analyzedFiles).toBe(12);
  });
});

describe("the family and schema markers", () => {
  it("refuses a report with no command — the evidence-snapshot family, not a delta", () => {
    const snapshot = JSON.parse(envelope());
    delete snapshot.command;
    snapshot.schemaVersion = 1;
    refuses(
      () => read({ report: JSON.stringify(snapshot) }),
      "validation",
      "no command",
      "evidence-snapshot",
    );
  });

  it("refuses a graph report, naming the consumer it belongs to", () => {
    refuses(
      () => read({ report: envelope({ command: "graph" }) }),
      "validation",
      '"graph"',
      "consumer",
    );
  });

  it("refuses a check report, naming the consumer's own gate", () => {
    refuses(
      () => read({ report: envelope({ command: "check" }) }),
      "validation",
      '"check"',
      "gate",
    );
  });

  it("refuses a newer schema major with the re-measure instruction", () => {
    refuses(() => read({ report: envelope({ schemaVersion: 3 }) }), "validation", "newer");
  });

  it("refuses a schema major no release ever wrote", () => {
    refuses(() => read({ report: envelope({ schemaVersion: 1 }) }), "validation", "never spoken");
  });

  it("refuses a report naming any other tool", () => {
    refuses(
      () => read({ report: envelope({ tool: { name: "archkeep", version: "0.29.0" } }) }),
      "validation",
      '"archkeep"',
      "@ecoma-io/archkeep",
    );
  });

  it("refuses a tool block without a version", () => {
    refuses(
      () => read({ report: envelope({ tool: { name: TOOL_NAME, version: "" } }) }),
      "validation",
      "version",
    );
  });
});

describe("the coherence table", () => {
  it("refuses a status the protocol does not name", () => {
    refuses(() => read({ report: envelope({ status: "great" }) }), "validation", "status");
  });

  it("refuses an exit that disagrees with the status", () => {
    refuses(
      () => read({ report: envelope({ status: "findings", exitCode: 0 }) }),
      "validation",
      "pins that status to exit 1",
    );
  });

  it("refuses a verdict that disagrees with the status", () => {
    refuses(
      () =>
        read({
          manifest: manifest(1),
          report: envelope({
            status: "findings",
            exitCode: 1,
            decision: { verdict: "pass", reason: "" },
          }),
        }),
      "validation",
      '"fail"',
    );
  });

  it("refuses an unknown verdict without a reason", () => {
    const noVerdict = {
      status: "no-verdict",
      exitCode: 3,
      decision: { verdict: "unknown" },
    };
    const coverage = {
      complete: false,
      analyzedFiles: 0,
      notAnalyzed: ["gen/"],
      blindSpots: [],
      notes: [],
    };
    refuses(
      () => read({ manifest: manifest(3), report: envelope({ ...noVerdict, coverage }) }),
      "validation",
      "without a reason",
    );
  });

  it("refuses an ok status over an incomplete coverage block", () => {
    refuses(
      () => read({ report: envelope({ coverage: { complete: false } }) }),
      "validation",
      "incomplete coverage",
    );
  });

  it("refuses a completeness claim over unanalyzed files", () => {
    refuses(
      () =>
        read({
          report: envelope({ coverage: { notAnalyzed: ["generated/"] } }),
        }),
      "validation",
      "did not judge",
    );
  });

  it("refuses a completeness claim over an unjudged blind spot, and tolerates a dynamic one", () => {
    const staticSpot = { file: "src/dynamic.mjs", reason: "unresolved" };
    refuses(
      () => read({ report: envelope({ coverage: { blindSpots: [staticSpot] } }) }),
      "validation",
      "unjudged blind spot",
    );
    const dynamic = read({
      report: envelope({ coverage: { blindSpots: [{ ...staticSpot, dynamic: true }] } }),
    });
    expect(dynamic.verdict).toBe("pass");
    expect(dynamic.coverage.blindSpotCount).toBe(1);
  });

  it("refuses a no-verdict report that carries a result block", () => {
    const coverage = {
      complete: false,
      analyzedFiles: 0,
      notAnalyzed: ["gen/"],
      blindSpots: [],
      notes: [],
    };
    refuses(
      () =>
        read({
          manifest: manifest(3),
          report: envelope({
            status: "no-verdict",
            exitCode: 3,
            decision: { verdict: "unknown", reason: "the graph could not be resolved" },
            coverage,
          }),
        }),
      "validation",
      "no result",
    );
  });

  it("refuses a summary that miscounts its own buckets", () => {
    refuses(
      () =>
        read({
          manifest: manifest(1),
          report: envelope({
            status: "findings",
            exitCode: 1,
            decision: { verdict: "fail", reason: "" },
            result: {
              violations: { introduced: [violation()], resolved: [], unchanged: [], unknown: [] },
            },
          }),
        }),
      "validation",
      "summary.introduced",
      "miscounts itself",
    );
  });

  it("refuses a summary whose introducedWaived disagrees with the waived rows", () => {
    const waived = violation({
      waived: true,
      waivedBy: { expiresAt: "2999-01-01", reason: "filed" },
    });
    refuses(
      () =>
        read({
          manifest: manifest(1),
          report: envelope({
            status: "findings",
            exitCode: 1,
            decision: { verdict: "fail", reason: "" },
            result: {
              summary: {
                introduced: 1,
                introducedWaived: 0,
                resolved: 0,
                unchanged: 0,
                unknown: 0,
              },
              violations: { introduced: [waived], resolved: [], unchanged: [], unknown: [] },
            },
          }),
        }),
      "validation",
      "introducedWaived",
      "miscounts itself",
    );
  });

  it("refuses a missing violation bucket and counts custom findings only with their block", () => {
    const dropped = JSON.parse(envelope());
    delete dropped.result.violations.unknown;
    refuses(
      () => read({ report: JSON.stringify(dropped) }),
      "validation",
      "unknown violations bucket",
    );

    const counted = JSON.parse(
      envelope({
        result: {
          summary: { customFindings: { introduced: 1, resolved: 0, unchanged: 0, unknown: 0 } },
        },
      }),
    );
    refuses(
      () => read({ report: JSON.stringify(counted) }),
      "validation",
      "custom findings",
      "without declaring a customRules block",
    );
  });

  it("refuses a missing unresolvable bucket and a summary that omits its counts", () => {
    const dropped = JSON.parse(envelope());
    delete dropped.result.unresolvable.unchanged;
    refuses(
      () => read({ report: JSON.stringify(dropped) }),
      "validation",
      "unchanged unresolvable bucket",
    );

    const counted = JSON.parse(envelope());
    delete counted.result.summary.unresolvable;
    refuses(() => read({ report: JSON.stringify(counted) }), "validation", "summary.unresolvable");
  });

  it("refuses a customRules block that is not what its summary says", () => {
    const notObject = JSON.parse(envelope({ result: { customRules: [] } }));
    refuses(
      () => read({ report: JSON.stringify(notObject) }),
      "validation",
      "customRules block that is not an object",
    );

    const noFindings = JSON.parse(envelope({ result: { customRules: {} } }));
    refuses(
      () => read({ report: JSON.stringify(noFindings) }),
      "validation",
      "customRules block without a findings object",
    );

    const countedWrong = JSON.parse(
      envelope({
        result: {
          summary: { customFindings: { introduced: 0, resolved: 0, unchanged: 0, unknown: 0 } },
          customRules: { findings: { introduced: [{}], resolved: [], unchanged: [], unknown: [] } },
        },
      }),
    );
    refuses(() => read({ report: JSON.stringify(countedWrong) }), "validation", "miscounts itself");

    const notCounted = JSON.parse(envelope({ result: { customRules: { findings: {} } } }));
    refuses(
      () => read({ report: JSON.stringify(notCounted) }),
      "validation",
      "without counting it in summary.customFindings",
    );

    const bucketNotArray = JSON.parse(
      envelope({
        result: {
          summary: { customFindings: { introduced: 0, resolved: 0, unchanged: 0, unknown: 0 } },
          customRules: { findings: { introduced: null, resolved: [], unchanged: [], unknown: [] } },
        },
      }),
    );
    refuses(
      () => read({ report: JSON.stringify(bucketNotArray) }),
      "validation",
      "bucket that is not an array",
    );
  });

  it("refuses a payload missing its structural blocks", () => {
    const noResult = JSON.parse(envelope());
    delete noResult.result;
    refuses(() => read({ report: JSON.stringify(noResult) }), "validation", "no result block");

    const noPolicyChanged = JSON.parse(envelope());
    delete noPolicyChanged.result.policyChanged;
    refuses(
      () => read({ report: JSON.stringify(noPolicyChanged) }),
      "validation",
      "policyChanged flag",
    );

    const noSide = JSON.parse(envelope());
    delete noSide.result.baseline;
    refuses(() => read({ report: JSON.stringify(noSide) }), "validation", "baseline side");

    const noSummary = JSON.parse(envelope());
    delete noSummary.result.summary;
    refuses(() => read({ report: JSON.stringify(noSummary) }), "validation", "no summary block");
  });

  it("refuses a top-level shape that is not an envelope object", () => {
    refuses(() => read({ report: '"a bare string"' }), "validation", "not a JSON object");
    refuses(() => read({ report: "[]" }), "validation", "not a JSON object");
  });

  it("refuses a missing decision block, an incomplete-flag-free coverage block, and whole missing bucket blocks", () => {
    const noDecision = JSON.parse(envelope());
    delete noDecision.decision;
    refuses(() => read({ report: JSON.stringify(noDecision) }), "validation", "no decision block");

    const noCompleteFlag = JSON.parse(envelope());
    delete noCompleteFlag.coverage.complete;
    refuses(() => read({ report: JSON.stringify(noCompleteFlag) }), "validation", "complete flag");

    const noViolationsBlock = JSON.parse(envelope());
    delete noViolationsBlock.result.violations;
    refuses(
      () => read({ report: JSON.stringify(noViolationsBlock) }),
      "validation",
      "no violations block",
    );

    const noUnresolvableBlock = JSON.parse(envelope());
    delete noUnresolvableBlock.result.unresolvable;
    refuses(
      () => read({ report: JSON.stringify(noUnresolvableBlock) }),
      "validation",
      "no unresolvable block",
    );
  });

  it("refuses a summary whose unresolvable counts miscount their buckets", () => {
    const evidence = JSON.parse(
      envelope({
        result: {
          summary: {
            unresolvable: { introduced: 1, resolved: 0, unchanged: 0, unknown: 0 },
          },
          unresolvable: {
            introduced: [
              { specifier: "#review/src/index.mjs", kind: "value", sourceProject: "triage" },
              { specifier: "#core/src/index.mjs", kind: "value", sourceProject: "triage" },
            ],
          },
        },
      }),
    );
    refuses(
      () => read({ report: JSON.stringify(evidence) }),
      "validation",
      "summary.unresolvable.introduced",
      "miscounts itself",
    );
  });

  it("refuses missing tool and coverage blocks and their required members", () => {
    const noTool = JSON.parse(envelope());
    delete noTool.tool;
    refuses(() => read({ report: JSON.stringify(noTool) }), "validation", "no tool block");

    const noCoverage = JSON.parse(envelope());
    delete noCoverage.coverage;
    refuses(() => read({ report: JSON.stringify(noCoverage) }), "validation", "no coverage block");

    const noNotAnalyzed = JSON.parse(envelope());
    delete noNotAnalyzed.coverage.notAnalyzed;
    refuses(
      () => read({ report: JSON.stringify(noNotAnalyzed) }),
      "validation",
      "notAnalyzed array",
    );

    const noNotes = JSON.parse(envelope());
    delete noNotes.coverage.notes;
    refuses(() => read({ report: JSON.stringify(noNotes) }), "validation", "notes array");

    const badBlindSpots = envelope({ coverage: { blindSpots: "none" } });
    refuses(() => read({ report: badBlindSpots }), "validation", "not an array");

    const notASpot = envelope({ coverage: { blindSpots: ["a string"] } });
    refuses(() => read({ report: notASpot }), "validation", "unjudged blind spot");
  });

  it("refuses a manifest that does not parse, and propagates a manifest confinement refusal", () => {
    const { workspace } = setup({ [REPORT]: envelope(), [MANIFEST]: "{nope" });
    expect(() =>
      readArchitectureReport({
        workspace,
        reportPath: REPORT,
        manifestPath: MANIFEST,
        expect: { headSha: HEAD },
      }),
    ).toThrow(/does not parse as JSON/);

    const confined = setup({ [REPORT]: envelope() });
    expect(() =>
      readArchitectureReport({
        workspace: confined.workspace,
        reportPath: REPORT,
        manifestPath: "../elsewhere.json",
        expect: { headSha: HEAD },
      }),
    ).toThrow(WorkspaceRefusal);
  });
});

describe("normalization: the frozen evidence shape", () => {
  it("records an ok report's facts verbatim and frozen", () => {
    const bytes = envelope();
    const evidence = read({ report: bytes });
    expect(evidence.verdict).toBe("pass");
    expect(evidence.stale).toBe(false);
    expect(evidence.incompleteness).toBeNull();
    expect(evidence.provenance).toEqual({
      head: { commit: HEAD, dirty: false },
      base: { commit: BASE, dirty: false },
    });
    expect(evidence.policyChanged).toBe(false);
    expect(evidence.provider).toBe("native");
    expect(evidence.toolVersion).toBe("0.29.0");
    expect(evidence.policyFingerprints).toEqual({ head: "fp-head", base: "fp-base" });
    expect(evidence.reportSha256).toBe(createHash("sha256").update(bytes, "utf8").digest("hex"));
    expect(evidence.unresolvable).toEqual({ introduced: 0, resolved: 0, unchanged: 0, unknown: 0 });
    expect(evidence.customRules).toBeNull();
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.introduced)).toBe(true);
  });

  it("normalizes one introduced violation field for field, with waived facts", () => {
    const evidence = read({
      manifest: manifest(1),
      report: envelope({
        status: "findings",
        exitCode: 1,
        decision: { verdict: "fail", reason: "" },
        result: {
          summary: { introduced: 2, introducedWaived: 1, resolved: 0, unchanged: 1, unknown: 0 },
          violations: {
            introduced: [
              violation(),
              violation({
                messageId: "noCycleAcrossLibraries",
                waived: true,
                waivedBy: { expiresAt: "2999-01-01", reason: "waived in #12" },
                headSites: [],
              }),
            ],
            resolved: [],
            unchanged: [
              violation({ note: "occurrencesReduced", baseCount: 4, headCount: 2, headSites: [] }),
            ],
            unknown: [],
          },
        },
      }),
    });
    expect(evidence.verdict).toBe("fail");
    expect(evidence.introduced).toHaveLength(2);
    expect(evidence.introduced[0]).toEqual({
      messageId: "noRelativeOrAbsoluteImportsAcrossLibraries",
      sourceProject: "triage",
      target: "#review/src/index.mjs",
      targetIsSpecifier: true,
      constraint: "triage may not import review",
      waived: false,
      waivedBy: null,
      baseCount: 0,
      headCount: 1,
      baseSites: [],
      headSites: [{ file: "triage/src/index.mjs", line: 11 }],
      reason: "absent at base",
      note: null,
    });
    expect(evidence.introduced[1]?.waived).toBe(true);
    expect(evidence.introduced[1]?.waivedBy).toEqual({
      expiresAt: "2999-01-01",
      reason: "waived in #12",
    });
    expect(evidence.introducedWaived).toBe(1);
    expect(evidence.unchangedCount).toBe(1);
    expect(evidence.occurrencesReduced).toEqual(["occurrencesReduced"]);
  });

  it("caps the site sample at twenty well-formed sites", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      file: `src/f${String(i)}.mjs`,
      line: i + 1,
    }));
    const evidence = read({
      manifest: manifest(1),
      report: envelope({
        status: "findings",
        exitCode: 1,
        decision: { verdict: "fail", reason: "" },
        result: {
          summary: { introduced: 1, introducedWaived: 0, resolved: 0, unchanged: 0, unknown: 0 },
          violations: {
            introduced: [violation({ headSites: many, headCount: 25 })],
            resolved: [],
            unchanged: [],
            unknown: [],
          },
        },
      }),
    });
    expect(evidence.introduced[0]?.headSites).toHaveLength(20);
    expect(evidence.introduced[0]?.headSites[0]).toEqual({ file: "src/f0.mjs", line: 1 });
    expect(evidence.introduced[0]?.headCount).toBe(25);
  });

  it("keeps a resolved violation's base sites — where the violation was", () => {
    const evidence = read({
      manifest: manifest(1),
      report: envelope({
        status: "findings",
        exitCode: 1,
        decision: { verdict: "fail", reason: "" },
        result: {
          summary: { introduced: 0, introducedWaived: 0, resolved: 1, unchanged: 0, unknown: 0 },
          violations: {
            introduced: [],
            resolved: [
              violation({
                baseCount: 1,
                headCount: 0,
                headSites: [],
                baseSites: [{ file: "triage/src/index.mjs", line: 11, column: 1 }],
                reason: "absent at head",
              }),
            ],
            unchanged: [],
            unknown: [],
          },
        },
      }),
    });
    expect(evidence.resolved).toHaveLength(1);
    expect(evidence.resolved[0]?.baseSites).toEqual([{ file: "triage/src/index.mjs", line: 11 }]);
    expect(evidence.resolved[0]?.headSites).toEqual([]);
  });

  it("drops malformed sites and non-string notes rather than refusing", () => {
    const evidence = read({
      manifest: manifest(1),
      report: envelope({
        status: "findings",
        exitCode: 1,
        decision: { verdict: "fail", reason: "" },
        coverage: { notes: ["one", 7, null, "two"] },
        result: {
          summary: { introduced: 1, introducedWaived: 0, resolved: 0, unchanged: 0, unknown: 0 },
          violations: {
            introduced: [
              violation({
                headSites: [
                  { file: "a.mjs", line: 1 },
                  { file: "b.mjs" },
                  { line: 2 },
                  "not a site",
                  { file: "c.mjs", line: 0 },
                  { file: "d.mjs", line: 3 },
                ],
              }),
            ],
            resolved: [],
            unchanged: [],
            unknown: [],
          },
        },
      }),
    });
    expect(evidence.introduced[0]?.headSites).toEqual([
      { file: "a.mjs", line: 1 },
      { file: "d.mjs", line: 3 },
    ]);
    expect(evidence.coverage.notes).toEqual(["one", "two"]);
  });

  it("carries unresolvable rows as counts only", () => {
    const evidence = read({
      manifest: manifest(1),
      report: envelope({
        status: "findings",
        exitCode: 1,
        decision: { verdict: "fail", reason: "" },
        result: {
          summary: {
            introduced: 0,
            introducedWaived: 0,
            resolved: 0,
            unchanged: 0,
            unknown: 0,
            unresolvable: { introduced: 2, resolved: 0, unchanged: 1, unknown: 0 },
          },
          unresolvable: {
            introduced: [
              { specifier: "#review/src/index.mjs", kind: "value", sourceProject: "triage" },
              { specifier: "#core/src/index.mjs", kind: "value", sourceProject: "triage" },
            ],
            resolved: [],
            unchanged: [
              { specifier: "#loom/src/index.mjs", kind: "value", sourceProject: "triage" },
            ],
            unknown: [],
          },
        },
      }),
    });
    expect(evidence.unresolvable).toEqual({ introduced: 2, resolved: 0, unchanged: 1, unknown: 0 });
  });

  it("carries custom-rule findings as capped bucket facts", () => {
    const evidence = read({
      manifest: manifest(1),
      report: envelope({
        status: "findings",
        exitCode: 1,
        decision: { verdict: "fail", reason: "" },
        result: {
          summary: {
            introduced: 0,
            introducedWaived: 0,
            resolved: 0,
            unchanged: 0,
            unknown: 0,
            customFindings: { introduced: 2, resolved: 0, unchanged: 0, unknown: 0 },
          },
          customRules: {
            findings: {
              introduced: [
                {
                  rule: "no-sql-in-view",
                  ruleId: "custom/no-sql-in-view/queries",
                  findingId: "q1",
                  project: "review",
                  message: "SQL in a view",
                  baseCount: 0,
                  headCount: 2,
                  headSites: [{ file: "review/src/view.mjs", line: 5, column: 1 }],
                  baseSites: [],
                },
                {
                  rule: "no-sql-in-view",
                  ruleId: "custom/no-sql-in-view/queries",
                  findingId: "q2",
                  project: "review",
                  message: "SQL in a view",
                  baseCount: 0,
                  headCount: 1,
                  headSites: [{ file: "review/src/other.mjs", line: 9, column: 1 }],
                  baseSites: [],
                },
              ],
              resolved: [],
              unchanged: [],
              unknown: [],
            },
          },
        },
      }),
    });
    expect(evidence.customRules).not.toBeNull();
    expect(evidence.customRules?.findings.introduced).toEqual({
      count: 2,
      ruleIds: ["custom/no-sql-in-view/queries"],
      sites: [
        { file: "review/src/view.mjs", line: 5 },
        { file: "review/src/other.mjs", line: 9 },
      ],
    });
    expect(evidence.customRules?.findings.resolved).toEqual({ count: 0, ruleIds: [], sites: [] });
  });
});

describe("the staleness law", () => {
  it("withholds the verdict of a report pinned to another head, naming both", () => {
    const evidence = read({
      report: envelope({
        workspace: { provenance: { commit: OTHER, remote: "", dirty: false } },
        result: {
          head: { provenance: { commit: OTHER, remote: "", dirty: false } },
        },
      }),
    });
    expect(evidence.verdict).toBe("unknown");
    expect(evidence.stale).toBe(true);
    expect(evidence.incompleteness?.reason).toBe("stale");
    expect(evidence.incompleteness?.note).toContain(OTHER);
    expect(evidence.incompleteness?.note).toContain(HEAD);
    // The baseline stays verbatim — staleness is a head-side fact.
    expect(evidence.provenance.base).toEqual({ commit: BASE, dirty: false });
  });

  it("withholds the verdict of a report with no head commit at all", () => {
    const evidence = read({
      report: envelope({
        result: { head: { provenance: { commit: null, remote: "", dirty: true } } },
      }),
    });
    expect(evidence.stale).toBe(true);
    expect(evidence.verdict).toBe("unknown");
    expect(evidence.incompleteness?.note).toContain("no head commit");
    expect(evidence.provenance.head).toEqual({ commit: null, dirty: true });
  });

  it("withholds the verdict of a report whose head side carries no provenance block", () => {
    const noProvenance = JSON.parse(envelope());
    delete noProvenance.result.head.provenance;
    const evidence = read({ report: JSON.stringify(noProvenance) });
    expect(evidence.stale).toBe(true);
    expect(evidence.provenance.head).toEqual({ commit: null, dirty: null });
    expect(evidence.incompleteness?.note).toContain("no head commit");
  });

  it("carries the head's dirty flag without letting it withhold", () => {
    const evidence = read({
      report: envelope({
        workspace: { provenance: { commit: HEAD, remote: "", dirty: true } },
        result: { head: { provenance: { commit: HEAD, remote: "", dirty: true } } },
      }),
    });
    expect(evidence.verdict).toBe("pass");
    expect(evidence.provenance.head).toEqual({ commit: HEAD, dirty: true });
  });

  it("carries a policy change as a recorded fact, not a refusal", () => {
    const evidence = read({
      report: envelope({
        result: {
          head: { policyFingerprint: "fp-other" },
          policyChanged: true,
        },
      }),
    });
    expect(evidence.policyChanged).toBe(true);
    expect(evidence.policyFingerprints).toEqual({ head: "fp-other", base: "fp-base" });
    expect(evidence.verdict).toBe("pass");
  });
});

describe("the no-verdict lane", () => {
  it("records a withheld verdict with its reason and no compare facts", () => {
    // A withheld verdict carries no result block — the builder's is removed
    // by hand, exactly as the real writer omits it.
    const withheld = JSON.parse(
      envelope({
        status: "no-verdict",
        exitCode: 3,
        decision: { verdict: "unknown", reason: "the graph could not be resolved" },
        coverage: {
          complete: false,
          analyzedFiles: 0,
          notAnalyzed: ["generated/"],
          blindSpots: [],
          notes: [],
        },
      }),
    );
    delete withheld.result;
    const evidence = read({ manifest: manifest(3), report: JSON.stringify(withheld) });
    expect(evidence.verdict).toBe("unknown");
    expect(evidence.stale).toBe(false);
    expect(evidence.incompleteness?.reason).toBe("incomplete");
    expect(evidence.incompleteness?.note).toContain("the graph could not be resolved");
    expect(evidence.policyChanged).toBeNull();
    expect(evidence.provenance.head).toEqual({ commit: HEAD, dirty: false });
    expect(evidence.introduced).toEqual([]);
    expect(evidence.coverage).toEqual({
      complete: false,
      analyzedFiles: 0,
      notAnalyzedCount: 1,
      blindSpotCount: 0,
      notes: [],
    });
  });
});

describe("forward compatibility and determinism", () => {
  it("strips volatile *Ms and sampleTime fields before they can reach evidence", () => {
    const volatile = envelope({
      workspace: { remainingMs: 4_000, sampleTime: "2026-09-12T00:00:00Z" },
      coverage: { notes: [], durationMs: 91 },
      result: { head: { elapsedMs: 3 } },
    });
    const evidence = read({ report: volatile });
    expect(evidence.verdict).toBe("pass");
    // The digest is over the raw bytes as written; the evidence carries no
    // volatile key anywhere.
    expect(evidence.reportSha256).toBe(createHash("sha256").update(volatile, "utf8").digest("hex"));
    expect(JSON.stringify(evidence)).not.toContain("Ms");
    expect(JSON.stringify(evidence)).not.toContain("sampleTime");
  });

  it("produces byte-identical evidence for identical inputs, twice", () => {
    const first = read({ report: envelope() });
    const second = read({ report: envelope() });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("refuses a report path that escapes the workspace — confinement holds", () => {
    const { workspace } = setup({ [MANIFEST]: manifest(0), [REPORT]: envelope() });
    expect(() =>
      readArchitectureReport({
        workspace,
        reportPath: "../outside.json",
        manifestPath: MANIFEST,
        expect: { headSha: HEAD },
      }),
    ).toThrow(WorkspaceRefusal);
  });
});
