// Tests for the dogfood review workflow's SARIF consumer (audit PR5, §8–§9
// T14). The workflow, not the action, owns the upload: the action writes the
// projection under `runner.temp` and surfaces `sarif-path`. These pins hold
// the consumer to the terminal × projection matrix's SARIF column — published
// runs only, confirmed findings only (the projection's own pin) — to the
// repository's SHA-pinning rule, and to §7.5's permission split: the upload
// step's job holds `security-events: write`, the action itself never does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(
  fileURLToPath(new URL("../.github/workflows/review.yml", import.meta.url)),
  "utf8",
);

/** The workflow's step blocks: each `      - ` line opens one. */
const steps = workflow.split(/^ {6}(?=- )/m).filter((chunk) => chunk.startsWith("- "));

test("the review step is addressable so a consumer can read its outputs", () => {
  assert.match(workflow, /- id: review\n {8}uses: \.\/review\n/);
});

test("the SARIF upload exists and is pinned by full SHA with its version comment", () => {
  const upload = steps.find((chunk) => chunk.includes("github/codeql-action/upload-sarif"));
  assert.ok(upload, "an upload-sarif step exists in review.yml");
  assert.match(upload, /uses: github\/codeql-action\/upload-sarif@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
});

test("the upload consumes the action's sarif-path under an explicit category", () => {
  const upload = steps.find((chunk) => chunk.includes("github/codeql-action/upload-sarif"));
  assert.ok(upload, "an upload-sarif step exists in review.yml");
  assert.match(upload, /sarif_file: \$\{\{ steps\.review\.outputs\.sarif-path \}\}/);
  assert.match(upload, /^ {10}category: \S+$/m);
});

test("the upload runs on published terminals only — never on a non-published one", () => {
  const upload = steps.find((chunk) => chunk.includes("github/codeql-action/upload-sarif"));
  assert.ok(upload, "an upload-sarif step exists in review.yml");
  // `sarif-path` is set only after a published review whose projection write
  // succeeded (§8's SARIF column is empty on every other row). The bare
  // default `if:` — no `always()` — also keeps the step off runs whose review
  // step failed: a refused, failed or skipped run uploads nothing and raises
  // no false alarm.
  assert.match(upload, /if: steps\.review\.outputs\.sarif-path != ''/);
  assert.doesNotMatch(upload, /if: always\(\)/);
});

test("the Code Scanning write stays in the job that uploads, per §7.5", () => {
  // Only the uploading job holds the write; the workflow-level floor grants
  // nothing (analysis.yml's rule — a job-level block replaces, not merges).
  assert.match(workflow, /^permissions: read-all$/m);
  const job = workflow.split(/^ {2}review:\n/m)[1] ?? "";
  assert.match(job, /security-events: write/);
  assert.match(job, /actions: read/);
});
