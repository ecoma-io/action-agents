// Tests for the output contract: tolerant parsing, intolerant anchoring.
// Every rejection reason the spec names is pinned by the finding that
// triggers it; ordering, dedup and the cap are pinned by exact outputs.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { createWorkspace } from "#core/workspace.mjs";

import { MAX_FINDINGS, parseAnswer, validateAnswer } from "./answer.mjs";

/** @type {string} */
let root;
/** @type {ReturnType<typeof createWorkspace>} */
let workspace;

beforeAll(() => {
  root = mkdtempSync(p.join(tmpdir(), "answer-test-"));
  mkdirSync(p.join(root, "src"));
  writeFileSync(p.join(root, "src", "a.mjs"), "l1\nl2\nl3\n");
  writeFileSync(p.join(root, "src", "b.mjs"), "one\n");
  workspace = createWorkspace({ root });
});

/**
 * Asserts non-ok and returns the reason — the union narrowing no test
 * should re-type eight times.
 *
 * @param {string} content
 * @returns {string}
 */
function defectOf(content) {
  const parsed = parseAnswer(content);
  if (parsed.ok) throw new Error(`expected a structural failure for: ${content}`);
  return parsed.defect;
}

const reviewed = [
  { filename: "src/a.mjs", status: "modified", additions: 2, deletions: 1 },
  { filename: "src/b.mjs", status: "added", additions: 1, deletions: 0 },
];

describe("parseAnswer", () => {
  it("parses a bare object, a fenced object, and prose-wrapped JSON5", () => {
    const bare = `{"findings": [], "summary": "clean"}`;
    expect(parseAnswer(bare)).toEqual({ ok: true, summary: "clean", rawFindings: [] });

    const fenced = "```json\n" + bare + "\n```";
    expect(parseAnswer(fenced).ok).toBe(true);

    // Single quotes AND a brace inside a quoted string: the scanner tracks
    // both styles or this balance breaks.
    const json5 = `here is my review:\n{ findings: [{ severity: 'nit', file: "s{weird.mjs", line: 1, message: 'it{ breaks' }], summary: 'ok' }`;
    const parsed = parseAnswer(json5);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rawFindings).toHaveLength(1);
  });

  it("refuses structural defects with named reasons", () => {
    expect(defectOf("no object here")).toMatch(/no JSON object/);
    expect(defectOf("{findings: []}")).toMatch(/no summary string/);
    expect(defectOf("{summary: 'x'}")).toMatch(/no findings array/);
    expect(defectOf("{summary: 'x', verdict: 'approve', findings: []}")).toMatch(
      /unknown key 'verdict'/,
    );
    expect(defectOf("{summary: 'x', findings: [{severity:'concern'}]}")).toMatch(
      /missing severity/,
    );
    expect(
      defectOf("{summary: 'x', findings: [{severity:'concern',file:'a',line:1.5,message:'m'}]}"),
    ).toMatch(/line/);
    expect(defectOf("[]")).toMatch(/no JSON object|not a JSON object/);
  });
});

describe("validateAnswer", () => {
  it("keeps valid anchors and drops invalid ones individually with reasons", () => {
    const result = validateAnswer({
      rawFindings: [
        { severity: "concern", file: "src/a.mjs", line: 2, message: "real problem" },
        { severity: "major", file: "src/a.mjs", line: 1, message: "off-vocabulary" },
        { severity: "nit", file: "src/gone.mjs", line: 1, message: "not in inventory" },
        { severity: "nit", file: "src/a.mjs", line: 99, message: "line past EOF" },
        { severity: "nit", file: "src/a.mjs", line: 0, message: "line zero" },
      ],
      summary: "mixed",
      reviewed,
      workspace,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ file: "src/a.mjs", line: 2 });
    expect(result.rejections).toHaveLength(4);
    expect(result.rejections[0]).toContain("outside the vocabulary");
    expect(result.rejections[1]).toContain("not in the changed inventory");
    expect(result.rejections[2]).toContain("does not exist");
  });

  it("cannot anchor on deleted files even when the listing carries them", () => {
    const result = validateAnswer({
      rawFindings: [{ severity: "nit", file: "removed.txt", line: 1, message: "m" }],
      summary: "s",
      reviewed: [{ filename: "removed.txt", status: "removed", additions: 0, deletions: 5 }],
      workspace,
    });
    expect(result.rejections[0]).toMatch(/deleted by this pull request/);
  });

  it("deduplicates exact logical duplicates only — same line, different message survives", () => {
    const result = validateAnswer({
      rawFindings: [
        { severity: "nit", file: "src/b.mjs", line: 1, message: "same" },
        { severity: "nit", file: "src/b.mjs", line: 1, message: "same" },
        { severity: "nit", file: "src/b.mjs", line: 1, message: "different" },
        { severity: "concern", file: "src/b.mjs", line: 1, message: "same" },
      ],
      summary: "dedup",
      reviewed,
      workspace,
    });
    expect(result.findings).toHaveLength(3);
  });

  it("orders by severity, then path bytes, then line, then message bytes", () => {
    const result = validateAnswer({
      rawFindings: [
        { severity: "nit", file: "src/b.mjs", line: 1, message: "b-nit" },
        { severity: "nit", file: "src/a.mjs", line: 3, message: "a-nit-3" },
        { severity: "concern", file: "src/b.mjs", line: 1, message: "b-concern" },
        { severity: "nit", file: "src/a.mjs", line: 1, message: "a-nit-1" },
      ],
      summary: "order",
      reviewed,
      workspace,
    });
    expect(result.findings.map((f) => `${f.severity}:${f.file}:${f.line}`)).toEqual([
      "concern:src/b.mjs:1",
      "nit:src/a.mjs:1",
      "nit:src/a.mjs:3",
      "nit:src/b.mjs:1",
    ]);
  });

  it("caps findings at fifty and names the overflow", () => {
    const rawFindings = Array.from({ length: MAX_FINDINGS + 7 }, (_, index) => ({
      severity: "nit",
      file: "src/b.mjs",
      line: 1,
      message: `m${String(index).padStart(3, "0")}`,
    }));
    const result = validateAnswer({ rawFindings, summary: "cap", reviewed, workspace });
    expect(result.findings).toHaveLength(MAX_FINDINGS);
    expect(result.rejections.some((reason) => reason.includes("past the"))).toBe(true);
  });
});

describe("anchor read cap alignment", () => {
  it("rejects findings for lines past the model's own read_file cap", () => {
    // Regression for REVIEW-002: countLines used a 2 MiB cap while read_file
    // used 1 MiB, allowing the model to anchor findings on lines it never read.
    // 700K lines × 2 bytes = 1.4 MiB. countLines now reads only 1 MiB (524K
    // lines), so line 600K — which would have passed the old 2 MiB cap — is
    // now rejected.
    const big = "x\n".repeat(700_000);
    writeFileSync(p.join(root, "src", "big.mjs"), big);
    const result = validateAnswer({
      rawFindings: [{ severity: "nit", file: "src/big.mjs", line: 600_000, message: "m" }],
      summary: "big",
      reviewed: [{ filename: "src/big.mjs", status: "modified", additions: 700_000, deletions: 0 }],
      workspace,
    });
    // Line 600K is past the 1 MiB read cap — the model never read it.
    expect(result.findings).toHaveLength(0);
    expect(result.rejections.some((r) => r.includes("does not exist"))).toBe(true);
  });
});
