// Tests for the SARIF projection: only confirmed findings publish, the
// same canonical result always projects byte-identical SARIF, fingerprints
// pass through as GitHub's partial fingerprints, rules dedupe per kind in
// first-appearance order, and locations carry the finding's anchor as Code
// Scanning expects it.

import { describe, expect, it } from "vitest";

import { createCanonicalResult } from "./canonical.mjs";
import { findingFingerprint } from "./identity.mjs";
import { toSarif } from "./sarif.mjs";

/** A publication finding as the verification pass leaves it. */
const finding = (over = {}) => ({
  kind: "correctness",
  file: "src/a.mjs",
  line: 12,
  severity: "concern",
  message: "the guard is missing",
  subject: "if (!x) return;",
  lifecycle: "confirmed",
  ...over,
});

const build = (over = {}) =>
  createCanonicalResult({
    head: "9c9473e",
    run: { state: "published", verdict: "pass" },
    findings: [finding()],
    ...over,
  });

describe("toSarif", () => {
  it("publishes only confirmed findings", () => {
    const result = build({
      findings: [
        finding({ subject: "kept", lifecycle: "confirmed", verdict: "confirmed" }),
        finding({
          file: "src/refuted.mjs",
          subject: "wrong",
          lifecycle: "refuted",
          verdict: "refuted",
        }),
        finding({
          file: "src/uncertain.mjs",
          subject: "maybe",
          lifecycle: "unresolved",
          verdict: "uncertain",
        }),
      ],
    });
    const sarif = toSarif(result);
    expect(sarif.runs[0]?.results).toHaveLength(1);
    expect(sarif.runs[0]?.results[0]?.message.text).toBe("the guard is missing");
    expect(JSON.stringify(sarif)).not.toContain("src/refuted.mjs");
    expect(JSON.stringify(sarif)).not.toContain("src/uncertain.mjs");
  });

  it("projects byte-identical SARIF for equal but distinct results", () => {
    const input = () =>
      build({
        findings: [
          finding(),
          finding({
            kind: "security",
            file: "src/b.mjs",
            line: 3,
            severity: "nit",
            message: "hardcoded secret",
            subject: 'const token = "s3cret";',
          }),
        ],
      });
    const aHash = findingFingerprint({
      file: "src/a.mjs",
      kind: "correctness",
      subject: "if (!x) return;",
    });
    const bHash = findingFingerprint({
      file: "src/b.mjs",
      kind: "security",
      subject: 'const token = "s3cret";',
    });
    const first = JSON.stringify(toSarif(input()));
    const second = JSON.stringify(toSarif(input()));
    expect(first).toBe(second);
    expect(first).toBe(
      JSON.stringify({
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [
          {
            tool: {
              driver: {
                name: "ecoma-io/action-agents/review",
                informationUri: "https://github.com/ecoma-io/action-agents",
                rules: [
                  { id: "correctness", shortDescription: { text: "correctness" } },
                  { id: "security", shortDescription: { text: "security" } },
                ],
              },
            },
            results: [
              {
                ruleId: "correctness",
                ruleIndex: 0,
                level: "warning",
                message: { text: "the guard is missing" },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "src/a.mjs", uriBaseId: "%SRCROOT%" },
                      region: { startLine: 12 },
                    },
                  },
                ],
                partialFingerprints: {
                  primaryLocationLineHash: aHash,
                  "reviewFindingFingerprint/v2": aHash,
                },
              },
              {
                ruleId: "security",
                ruleIndex: 1,
                level: "note",
                message: { text: "hardcoded secret" },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "src/b.mjs", uriBaseId: "%SRCROOT%" },
                      region: { startLine: 3 },
                    },
                  },
                ],
                partialFingerprints: {
                  primaryLocationLineHash: bHash,
                  "reviewFindingFingerprint/v2": bHash,
                },
              },
            ],
          },
        ],
      }),
    );
  });

  it("passes the finding's own fingerprint through", () => {
    const result = build();
    const sarif = toSarif(result);
    expect(sarif.runs[0]?.results[0]?.partialFingerprints["reviewFindingFingerprint/v2"]).toBe(
      findingFingerprint({ file: "src/a.mjs", kind: "correctness", subject: "if (!x) return;" }),
    );
    expect(sarif.runs[0]?.results[0]?.partialFingerprints["reviewFindingFingerprint/v2"]).toBe(
      result.findings[0]?.fingerprint,
    );
  });

  it("carries the Ecoma fingerprint under primaryLocationLineHash — the key GitHub deduplicates on", () => {
    const result = build();
    const sarif = toSarif(result);
    const fingerprints = sarif.runs[0]?.results[0]?.partialFingerprints;
    // Dual identity (audit T13): GitHub's consulted dedup key IS the Ecoma
    // canonical fingerprint — deterministic, byte-stable across replays.
    expect(fingerprints?.["primaryLocationLineHash"]).toBe(
      findingFingerprint({ file: "src/a.mjs", kind: "correctness", subject: "if (!x) return;" }),
    );
    // One identity, two consumers: the very string the canonical record
    // carries — the comment's record block anchors on the same value.
    expect(fingerprints?.["primaryLocationLineHash"]).toBe(result.findings[0]?.fingerprint);
    // Both keys, fixed order: the projection stays byte-deterministic (I9).
    expect(Object.keys(fingerprints ?? {})).toEqual([
      "primaryLocationLineHash",
      "reviewFindingFingerprint/v2",
    ]);
    expect(JSON.stringify(toSarif(result))).toBe(JSON.stringify(toSarif(build())));
  });

  it("dedupes rules per kind in first-appearance order of the sorted results", () => {
    const result = build({
      findings: [
        finding({ kind: "security", file: "src/b.mjs" }),
        finding({ kind: "style", file: "src/c.mjs" }),
        finding({ kind: "security", file: "src/d.mjs" }),
      ],
    });
    const sarif = toSarif(result);
    expect(sarif.runs[0]?.tool.driver.rules).toEqual([
      { id: "security", shortDescription: { text: "security" } },
      { id: "style", shortDescription: { text: "style" } },
    ]);
    const [security, style, securityAgain] = sarif.runs[0]?.results ?? [];
    expect(security?.ruleIndex).toBe(0);
    expect(style?.ruleIndex).toBe(1);
    expect(securityAgain?.ruleIndex).toBe(0);
  });

  it("sorts results by file, then line, then fingerprint", () => {
    const result = build({
      findings: [
        finding({ file: "src/b.mjs", line: 1 }),
        finding({ file: "src/a.mjs", line: 30 }),
        finding({ file: "src/a.mjs", line: 2, subject: "second" }),
        finding({ file: "src/a.mjs", line: 2, subject: "first" }),
      ],
    });
    const sarif = toSarif(result);
    const startLines = sarif.runs[0]?.results.map(
      (r) => r.locations[0]?.physicalLocation.region.startLine,
    );
    // src/a.mjs sorts before src/b.mjs; within a file, numeric line order.
    expect(startLines).toEqual([2, 2, 30, 1]);
    // The two claims sharing (src/a.mjs, line 2) break the tie on fingerprint.
    const subjects = sarif.runs[0]?.results
      .filter((r) => r.locations[0]?.physicalLocation.region.startLine === 2)
      .map((r) => r.message.text);
    expect(subjects).toHaveLength(2);
    expect(subjects).toEqual([.../** @type {string[]} */ (subjects)].sort());
  });

  it("spells the location the way Code Scanning resolves it", () => {
    const result = build({ findings: [finding({ file: "src\\nested\\a.mjs", line: 7 })] });
    const sarif = toSarif(result);
    const location = sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation;
    expect(location?.artifactLocation).toEqual({ uri: "src/nested/a.mjs", uriBaseId: "%SRCROOT%" });
    expect(location?.region.startLine).toBe(7);
  });

  it("projects an empty run when nothing is confirmed", () => {
    const sarif = toSarif(
      build({
        findings: [
          finding({ subject: "wrong", lifecycle: "refuted", verdict: "refuted" }),
          finding({ subject: "maybe", lifecycle: "unresolved", verdict: "uncertain" }),
        ],
      }),
    );
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0]?.results).toEqual([]);
    expect(sarif.runs[0]?.tool.driver.rules).toEqual([]);
    expect(sarif.runs[0]?.tool.driver.name).toBe("ecoma-io/action-agents/review");
    expect(sarif.$schema).toBe("https://json.schemastore.org/sarif-2.1.0.json");
    expect(sarif.version).toBe("2.1.0");
  });

  it("leaves the canonical result untouched", () => {
    const result = build({
      findings: [
        finding({ file: "src/b.mjs" }),
        finding({ file: "src/a.mjs", subject: "other claim" }),
      ],
    });
    const publicationOrder = result.findings.map((f) => f.file);
    toSarif(result);
    expect(result.findings.map((f) => f.file)).toEqual(publicationOrder);
    expect(publicationOrder).toEqual(["src/b.mjs", "src/a.mjs"]);
  });
});
