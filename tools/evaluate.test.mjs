// Tests for tools/evaluate.mjs — the offline evaluator (issue #278, wave W5).
//
// The metric math runs on synthetic inputs only; the corpus validation and
// double behavior run on small fixtures written to a temp directory; and the
// determinism case replays the real corpus twice and demands the same bytes.
// What is deliberately NOT tested is `main`'s process.exitCode plumbing.
//
// Thresholds are pinned here at their documented loose values: tightening one
// is a reviewed change to `THRESHOLDS`, and this test is what makes that a
// conscious edit rather than a drift.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { test } from "node:test";

import {
  CorpusDefect,
  THRESHOLDS,
  anchoringIntegrity,
  countMutationSurface,
  evaluate,
  falsePositiveRate,
  loadCorpus,
  makeChat,
  makeForge,
  precision,
  refusalRate,
  renderReport,
  scoreFindings,
  severityAgreement,
  share,
  validateAnswerFile,
  validateExpected,
  validateSnapshot,
  verificationAccuracy,
  verificationAccuracyRate,
  verifierAgreement,
} from "./evaluate.mjs";

const REPO_ROOT = p.join(import.meta.dirname, "..");
const CORPUS_ROOT = p.join(REPO_ROOT, "evaluation", "corpus");

/**
 * Runs `work` and returns the CorpusDefect message it raised, failing the
 * test when the work does not raise one.
 *
 * @param {() => unknown} work
 * @returns {string}
 */
function defectMessage(work) {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof CorpusDefect, `expected a CorpusDefect, got ${String(error)}`);
    return error.message;
  }
  assert.fail("expected the work to raise a CorpusDefect");
}

/**
 * @param {() => Promise<unknown>} work
 * @returns {Promise<string>}
 */
async function defectMessageAsync(work) {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof CorpusDefect, `expected a CorpusDefect, got ${String(error)}`);
    return /** @type {CorpusDefect} */ (error).message;
  }
  return assert.fail("expected the work to raise a CorpusDefect");
}

test("share divides and returns null on an empty denominator", () => {
  assert.equal(share(3, 5), 0.6);
  assert.equal(share(0, 4), 0);
  assert.equal(share(7, 0), null);
});

test("precision is tp over tp+fp", () => {
  assert.equal(precision(3, 1), 0.75);
  assert.equal(precision(0, 0), null);
});

test("false-positive-rate is fp over fp+tn, tn the unreported distractors", () => {
  assert.equal(falsePositiveRate(0, 2), 0);
  assert.equal(falsePositiveRate(1, 3), 0.25);
  assert.equal(falsePositiveRate(0, 0), null);
});

test("severity-agreement is agreeing true positives over true positives", () => {
  assert.equal(severityAgreement(5, 5), 1);
  assert.equal(severityAgreement(2, 4), 0.5);
  assert.equal(severityAgreement(0, 0), null);
});

test("verifier-agreement keeps unresolved in the denominator", () => {
  assert.equal(verifierAgreement({ confirmed: 3, refuted: 1, uncertain: 1, unresolved: 1 }), 0.5);
  assert.equal(verifierAgreement({ confirmed: 5, refuted: 0, uncertain: 0, unresolved: 0 }), 1);
  assert.equal(verifierAgreement({ confirmed: 0, refuted: 0, uncertain: 0, unresolved: 4 }), 0);
});

test("verification-accuracy is matching verdicts over produced verdicts", () => {
  assert.equal(verificationAccuracyRate({ matches: 4, total: 4 }), 1);
  assert.equal(verificationAccuracyRate({ matches: 1, total: 4 }), 0.25);
  assert.equal(verificationAccuracyRate({ matches: 0, total: 0 }), null);
});

test("anchoring-integrity subtracts re-derivation failures from the numerator", () => {
  assert.equal(anchoringIntegrity(6, 0), 1);
  assert.ok(Math.abs(/** @type {number} */ (anchoringIntegrity(6, 1)) - 5 / 6) < 1e-12);
  assert.equal(anchoringIntegrity(0, 0), null);
});

test("refusal-rate is refusal runs over model-answered runs", () => {
  assert.ok(Math.abs(/** @type {number} */ (refusalRate(2, 3)) - 2 / 3) < 1e-12);
  assert.equal(refusalRate(0, 0), null);
});

test("mutation-surface counts absolute write ops by action and kind", () => {
  const counts = countMutationSurface([
    {
      kind: "triage",
      writes: [
        { op: "addLabels", args: [501, ["bug"]] },
        { op: "addLabels", args: [502, ["docs"]] },
      ],
    },
    { kind: "review", writes: [{ op: "createComment", args: [4107, "body"] }] },
  ]);
  assert.deepEqual(counts, { "review.createComment": 1, "triage.addLabels": 2 });
});

test("scoreFindings separates true positives, false positives and unreported distractors", () => {
  const expected = [
    { file: "src/a.js", line: 7, severity: "concern", valid: true },
    { file: "src/a.js", line: 14, severity: "nit", valid: true },
    { file: "src/b.js", line: 4, severity: "concern", valid: false },
  ];
  const produced = [
    { file: "src/a.js", line: 7, severity: "concern", message: "m" },
    { file: "src/a.js", line: 14, severity: "concern", message: "m" },
    { file: "src/c.js", line: 2, severity: "nit", message: "m" },
  ];
  assert.deepEqual(scoreFindings(expected, produced), { tp: 2, fp: 1, tn: 1, severityAgree: 1 });
});

test("scoreFindings treats a produced distractor as a false positive, not a hit", () => {
  const expected = [{ file: "src/a.js", line: 2, severity: "nit", valid: false }];
  const produced = [{ file: "src/a.js", line: 2, severity: "nit", message: "m" }];
  assert.deepEqual(scoreFindings(expected, produced), { tp: 0, fp: 1, tn: 0, severityAgree: 0 });
});

test("verificationAccuracy requires an expected verdict for every produced one", () => {
  const artifact = {
    findings: [
      {
        file: "src/a.js",
        line: 7,
        severity: "concern",
        message: "m",
        verdict: "confirmed",
        lifecycle: "confirmed",
      },
      {
        file: "src/a.js",
        line: 9,
        severity: "nit",
        message: "m",
        verdict: "uncertain",
        lifecycle: "unresolved",
      },
    ],
  };
  const accuracy = verificationAccuracy(
    artifact,
    { "src/a.js:7": "confirmed", "src/a.js:9": "refuted" },
    "entry",
  );
  assert.deepEqual(accuracy, { matches: 1, total: 2 });
  assert.match(
    defectMessage(() => verificationAccuracy(artifact, { "src/a.js:7": "confirmed" }, "entry")),
    /holds a 'uncertain' verdict at src\/a\.js:9, but expected\.json holds no expected verdict/,
  );
});

test("the initial thresholds are the documented loose ones, with anchoring pinned", () => {
  assert.deepEqual(THRESHOLDS, {
    minPrecision: 0.5,
    maxFalsePositiveRate: 0.5,
    minSeverityAgreement: 0.5,
    minVerifierAgreement: 0.5,
    minVerificationAccuracy: 0.5,
    anchoringIntegrity: 1.0,
  });
  assert.equal(Object.isFrozen(THRESHOLDS), true);
});

// ── Fail-closed validation ──────────────────────────────────────────────

const VALID_TRIAGE_SNAPSHOT = {
  schemaVersion: 1,
  kind: "triage",
  repository: "ecoma-io/action-agents",
  model: "<recorded>",
  inputs: { dryRun: false, labels: [], verify: false },
  event: { name: "issues", action: "opened", payload: { action: "opened" } },
  thread: { type: "issue", number: 501, title: "t", body: "b", labels: [] },
  policy: {
    files: {
      ".github/action-agents/triage/triage.json5": "{}",
      ".github/action-agents/triage/instruction.md": null,
    },
  },
  world: { getRepository: { defaultBranch: "main" }, getRef: { main: "a".repeat(40) } },
};

const VALID_REVIEW_SNAPSHOT = {
  ...VALID_TRIAGE_SNAPSHOT,
  kind: "review",
  inputs: { configPath: "", contextWindow: 128_000, dryRun: false, maxTurns: 5 },
  headFiles: { "src/a.js": "const one = 1;\n" },
};

test("validateSnapshot accepts a well-formed triage snapshot", () => {
  const snapshot = validateSnapshot(structuredClone(VALID_TRIAGE_SNAPSHOT), "entry");
  assert.equal(snapshot["kind"], "triage");
});

test("validateSnapshot rejects a model that is not the recorded placeholder", () => {
  const snapshot = structuredClone(VALID_TRIAGE_SNAPSHOT);
  snapshot["model"] = "gpt-x";
  assert.match(
    defectMessage(() => validateSnapshot(snapshot, "entry")),
    /placeholder/,
  );
});

test("validateSnapshot rejects a dry-run recording", () => {
  const snapshot = structuredClone(VALID_TRIAGE_SNAPSHOT);
  snapshot["inputs"]["dryRun"] = true;
  assert.match(
    defectMessage(() => validateSnapshot(snapshot, "entry")),
    /dryRun/,
  );
});

test("validateSnapshot rejects a world member outside the forge slice", () => {
  const snapshot = structuredClone(VALID_TRIAGE_SNAPSHOT);
  snapshot["world"]["mergePullRequest"] = {};
  assert.match(
    defectMessage(() => validateSnapshot(snapshot, "entry")),
    /outside the forge slice/,
  );
});

test("validateSnapshot rejects a ref sha that is not 40 hex", () => {
  const snapshot = structuredClone(VALID_TRIAGE_SNAPSHOT);
  snapshot["world"]["getRef"] = { main: "abc" };
  assert.match(
    defectMessage(() => validateSnapshot(snapshot, "entry")),
    /40-hex/,
  );
});

test("validateSnapshot rejects an unknown key and a missing key", () => {
  const extra = structuredClone(VALID_TRIAGE_SNAPSHOT);
  extra["surprise"] = 1;
  assert.match(
    defectMessage(() => validateSnapshot(extra, "entry")),
    /unknown key/,
  );
  const missing = structuredClone(VALID_TRIAGE_SNAPSHOT);
  delete missing["thread"];
  assert.match(
    defectMessage(() => validateSnapshot(missing, "entry")),
    /missing key/,
  );
});

test("validateSnapshot requires headFiles on a review snapshot only", () => {
  const withoutFiles = structuredClone(VALID_REVIEW_SNAPSHOT);
  delete withoutFiles["headFiles"];
  assert.match(
    defectMessage(() => validateSnapshot(withoutFiles, "entry")),
    /missing key\(s\) headFiles/,
  );
  assert.equal(validateSnapshot(structuredClone(VALID_REVIEW_SNAPSHOT), "entry")["kind"], "review");
});

test("validateSnapshot refuses a review config path that points at a named file", () => {
  const snapshot = structuredClone(VALID_REVIEW_SNAPSHOT);
  snapshot["inputs"]["configPath"] = "review.custom.json5";
  assert.match(
    defectMessage(() => validateSnapshot(snapshot, "entry")),
    /configPath/,
  );
});

test("validateExpected rejects an unknown verdict word and a malformed anchor", () => {
  const wrongVerdict = { findings: [], outcome: "published", verdicts: { "src/a.js:7": "maybe" } };
  assert.match(
    defectMessage(() => validateExpected(wrongVerdict, "entry", "review")),
    /confirmed, refuted or uncertain/,
  );
  const wrongAnchor = { findings: [], outcome: "published", verdicts: { "src/a.js": "confirmed" } };
  assert.match(
    defectMessage(() => validateExpected(wrongAnchor, "entry", "review")),
    /anchor/,
  );
  const unknownKey = { adds: [], outcome: "published", extra: 1, refusals: [] };
  assert.match(
    defectMessage(() => validateExpected(unknownKey, "entry", "triage")),
    /unknown key/,
  );
});

test("validateAnswerFile rejects any key set other than content/finishReason/toolCalls", () => {
  assert.match(
    defectMessage(() =>
      validateAnswerFile(
        { content: "", finishReason: "stop", toolCalls: [], usage: {} },
        "entry",
        "01-a.json",
      ),
    ),
    /unknown key/,
  );
  assert.match(
    defectMessage(() =>
      validateAnswerFile(
        { content: "", finishReason: "stop", toolCalls: [{ id: "1", name: "read_file" }] },
        "entry",
        "01-a.json",
      ),
    ),
    /arguments/,
  );
});

// ── The doubles ─────────────────────────────────────────────────────────

test("makeChat serves the recording in order and refuses to serve past it", async () => {
  const chat = makeChat("entry", [
    { content: "first", finishReason: "stop", toolCalls: [] },
    { content: "second", finishReason: "stop", toolCalls: [] },
  ]);
  assert.equal(chat.asks(), 0);
  const first = await chat.complete();
  assert.equal(first["content"], "first");
  await chat.complete();
  assert.equal(chat.asks(), 2);
  assert.match(
    await defectMessageAsync(() => chat.complete()),
    /asked for provider answer 3, but the recording holds 2/,
  );
});

test("makeForge serves the recorded world and defects on an unrecorded read", async () => {
  const writes = [];
  const forge = makeForge(
    { getRepository: { defaultBranch: "main" }, getRef: { main: "b".repeat(40) } },
    { "policy.json5": "{}" },
    writes,
    "entry",
  );
  assert.deepEqual(await forge["getRepository"](), { defaultBranch: "main" });
  assert.deepEqual(await forge["getRef"]("main"), { sha: "b".repeat(40) });
  assert.match(
    defectMessage(() => forge["createPullRequest"]()),
    /called forge\.createPullRequest, which the snapshot does not record/,
  );
  assert.match(
    defectMessage(() => forge["getContents"]("policy.other.json5")),
    /read policy file 'policy\.other\.json5', which the snapshot does not record/,
  );
  assert.deepEqual(await forge["getContents"]("policy.json5"), { content: "{}" });
});

test("makeForge records write ops and answers createComment with an id", async () => {
  const writes = [];
  const forge = makeForge({}, {}, writes, "entry");
  await forge["addLabels"](501, ["bug"]);
  await forge["removeLabel"](501, "docs");
  const created = await forge["createComment"](501, "body");
  await forge["deleteComment"](1001);
  assert.deepEqual(
    writes.map((op) => op.op),
    ["addLabels", "removeLabel", "createComment", "deleteComment"],
  );
  assert.deepEqual(created, { id: 1003 });
  await forge["updateComment"](1003, "body");
  assert.equal(writes.length, 5);
});

test("makeForge reads the recorded absence of a policy file as null", async () => {
  const forge = makeForge({}, { "policy.json5": null }, [], "entry");
  assert.equal(await forge["getContents"]("policy.json5"), null);
});

// ── Corpus loading ──────────────────────────────────────────────────────

/**
 * Writes one valid triage entry into a temp corpus and returns its root.
 *
 * @param {string} name
 * @param {{answers?: string[], readme?: string, snapshot?: Record<string, unknown>, expected?: Record<string, unknown>}} [overrides]
 * @returns {string} the temp corpus root
 */
function writeTempCorpus(name, overrides = {}) {
  const root = mkdtempSync(p.join(tmpdir(), "eval-corpus-"));
  const entry = p.join(root, name);
  mkdirSync(p.join(entry, "answers"), { recursive: true });
  const snapshot = overrides.snapshot ?? structuredClone(VALID_TRIAGE_SNAPSHOT);
  writeFileSync(p.join(entry, "snapshot.json"), JSON.stringify(snapshot), "utf8");
  writeFileSync(
    p.join(entry, "expected.json"),
    JSON.stringify(
      overrides.expected ?? {
        adds: [],
        commentExpected: false,
        outcome: "published",
        refusals: [],
        removes: [],
        signalExpected: false,
      },
    ),
    "utf8",
  );
  writeFileSync(
    p.join(entry, "README.md"),
    overrides.readme ?? "One paragraph about what this entry exercises.\n",
    "utf8",
  );
  for (const [index, answer] of (overrides.answers ?? []).entries()) {
    writeFileSync(
      p.join(entry, "answers", String(index + 1).padStart(2, "0") + "-a.json"),
      answer,
      "utf8",
    );
  }
  return root;
}

test("loadCorpus accepts a minimal valid corpus directory", async () => {
  const root = writeTempCorpus("triage-entry");
  try {
    const entries = await loadCorpus(root, { floor: { triage: 1, review: 0 } });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]["kind"], "triage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadCorpus refuses a corpus below the seed floor", async () => {
  const root = writeTempCorpus("triage-entry");
  try {
    assert.match(await defectMessageAsync(() => loadCorpus(root)), /below its seed/);
    assert.match(
      await defectMessageAsync(() => loadCorpus(root, { floor: { triage: 2, review: 0 } })),
      /need 2/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadCorpus refuses a README that is not exactly one paragraph", async () => {
  const root = writeTempCorpus("triage-entry", {
    readme: "First paragraph.\n\nSecond paragraph.\n",
  });
  try {
    assert.match(await defectMessageAsync(() => loadCorpus(root)), /exactly one paragraph/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadCorpus refuses an answer file outside the NN-name shape", async () => {
  const root = writeTempCorpus("triage-entry", {
    answers: ['{"content":"","finishReason":"stop","toolCalls":[]}'],
  });
  try {
    rmSync(p.join(root, "triage-entry", "answers", "01-a.json"));
    writeFileSync(
      p.join(root, "triage-entry", "answers", "first.json"),
      '{"content":"","finishReason":"stop","toolCalls":[]}',
      "utf8",
    );
    assert.match(await defectMessageAsync(() => loadCorpus(root)), /not NN-name\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadCorpus refuses a missing required file", async () => {
  const root = writeTempCorpus("triage-entry");
  try {
    rmSync(p.join(root, "triage-entry", "expected.json"));
    assert.match(await defectMessageAsync(() => loadCorpus(root)), /missing expected\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadCorpus refuses malformed JSON", async () => {
  const root = writeTempCorpus("triage-entry");
  try {
    writeFileSync(p.join(root, "triage-entry", "snapshot.json"), "{ not json", "utf8");
    assert.match(await defectMessageAsync(() => loadCorpus(root)), /malformed JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── The real corpus: thresholds, pins, determinism ──────────────────────

test("evaluate replays the real corpus and clears every loose threshold", async () => {
  const result = await evaluate({ corpusRoot: CORPUS_ROOT });
  assert.deepEqual(result.defects, []);
  assert.deepEqual(result.corpusCounts, { triage: 4, review: 3 });
  assert.deepEqual(result.replayed, { triage: 4, review: 3 });
  const byMetric = new Map(result.rows.map((row) => [row.metric, row]));
  const refusal = byMetric.get("triage refusal-rate");
  assert.ok(refusal && refusal.value !== null && Math.abs(refusal.value - 2 / 3) < 1e-12);
  for (const [name, wanted] of [
    ["review precision", 1],
    ["review false-positive-rate", 0],
    ["review severity-agreement", 1],
    ["review verifier-agreement", 0.6],
    ["review verification-accuracy", 1],
    ["review anchoring-integrity", 1],
  ]) {
    const row = byMetric.get(name);
    assert.ok(row, `missing row ${name}`);
    assert.equal(row.value, wanted, name);
    assert.equal(row.met, true, `${name} must clear its threshold`);
  }
  assert.deepEqual(result.mutationCounts, { "review.createComment": 2, "triage.addLabels": 3 });
  assert.equal(result.ok, true);
});

test("the printed report is byte-identical across runs of the same corpus", async () => {
  const first = renderReport(await evaluate({ corpusRoot: CORPUS_ROOT }));
  const second = renderReport(await evaluate({ corpusRoot: CORPUS_ROOT }));
  assert.equal(first, second);
  assert.match(first, /# result: PASS/);
});

test("renderReport names every defect and fails the result line", async () => {
  const report = renderReport({
    rows: [
      { metric: "triage refusal-rate", value: 2 / 3, threshold: "unbounded (reported)", met: true },
      { metric: "review precision", value: 0.25, threshold: ">= 0.5", met: false },
      { metric: "review anchoring-integrity", value: null, threshold: "== 1 (pinned)", met: false },
    ],
    mutationCounts: { "triage.addLabels": 2 },
    defects: ["entry-x: the replay downgraded [add:docs], expected []"],
    corpusCounts: { triage: 4, review: 3 },
    replayed: { triage: 4, review: 2 },
    ok: false,
  });
  assert.match(report, /review precision\s+0\.2500\s+>= 0\.5\s+no/);
  assert.match(report, /anchoring-integrity\s+n\/a\s+== 1 \(pinned\)\s+—/);
  assert.match(report, /corpus defects \(1\):/);
  assert.match(report, /entry-x: the replay downgraded/);
  assert.match(report, /# result: FAIL/);
  assert.match(report, /triage\.addLabels\s+2/);
});

test("the corpus on disk is the seed the floor demands", () => {
  const entries = readFileSync(
    p.join(CORPUS_ROOT, "review-findings-verified", "expected.json"),
    "utf8",
  );
  assert.match(entries, /"verdicts"/);
});
