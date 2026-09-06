// Guards the run record's delivery (#378). An `actions/upload-artifact`
// step whose path targets a hidden record directory must set
// `include-hidden-files: true` — the action prunes hidden files by default,
// so the step matches zero files and still reports success, the exact
// silent-delivery signature #378 was filed against — and must not answer a
// missing record with `if-no-files-found: ignore`: a declared write that
// lands nowhere has to be loud. Runs over every workflow under
// `.github/workflows` so a new record upload cannot reintroduce the
// silent delivery, and over synthetic steps so the guard is proven to
// catch the rot it exists for.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workflowsDir = fileURLToPath(new URL("../.github/workflows", import.meta.url));

/** Every workflow file: `.yml` and `.yaml`, as GitHub loads them. */
const workflows = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => ({ name, text: readFileSync(`${workflowsDir}/${name}`, "utf8") }));

/** The workflow's step blocks: each `      - ` line opens one. */
const steps = (text) => text.split(/^ {6}(?=- )/m).filter((chunk) => chunk.startsWith("- "));

/** Whether the step runs `actions/upload-artifact`. */
const isUpload = (step) => /^ {8}uses: actions\/upload-artifact@/m.test(step);

/** The step's first `path:` line, or null when the step names no path. */
const pathValue = (step) => step.match(/^ {10}path: (.+)$/m)?.[1] ?? null;

/** The step's `name:`, for failure messages. */
const stepName = (step) => step.match(/^- name: (.+)$/m)?.[1]?.trim() ?? "unnamed step";

/**
 * The delivery violations one workflow text carries: every upload-artifact
 * step whose first path component is hidden — `${{ }}` expressions are not
 * paths, so they are stripped before the check — while missing
 * `include-hidden-files: true` or swallowing the miss with
 * `if-no-files-found: ignore`. One human-readable string per offending step.
 *
 * @param {string} text the workflow file's text
 * @param {string} name the file's name, for messages
 * @returns {string[]}
 */
function deliveryViolations(text, name) {
  const found = [];
  for (const step of steps(text).filter(isUpload)) {
    const value = pathValue(step)
      ?.replace(/\$\{\{[^}]*\}\}/g, "")
      .trim();
    if (value === undefined || value === null || !value.startsWith(".")) continue;
    const label = `${name}: "${stepName(step)}" uploads the hidden record path ${value}`;
    if (!/^ {10}include-hidden-files: true$/m.test(step)) {
      found.push(`${label} without include-hidden-files: true`);
    }
    if (/^ {10}if-no-files-found: ignore$/m.test(step)) {
      found.push(`${label} and swallows a missing record with if-no-files-found: ignore`);
    }
  }
  return found;
}

/** A minimal workflow wrapping one upload step's lines. */
const workflow = (stepLines) => ["jobs:", "  r:", "    steps:", ...stepLines].join("\n");

/** The upload step as it stood before #378's fix — glob, no hidden handling. */
const preFix = workflow([
  "      - name: Upload the run record",
  "        if: always()",
  "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
  "        with:",
  "          name: run-record",
  "          path: .records/run-*.json",
  "          if-no-files-found: ignore",
]);

test("every workflow delivers hidden record paths loudly — include-hidden-files on, never ignore", () => {
  assert.deepEqual(
    workflows.flatMap(({ name, text }) => deliveryViolations(text, name)),
    [],
  );
});

test("the guard flags a step that repeats #378 — hidden glob under the default hidden pruning", () => {
  assert.deepEqual(deliveryViolations(preFix, "regression.yml"), [
    'regression.yml: "Upload the run record" uploads the hidden record path .records/run-*.json without include-hidden-files: true',
    'regression.yml: "Upload the run record" uploads the hidden record path .records/run-*.json and swallows a missing record with if-no-files-found: ignore',
  ]);
});

test("the guard flags a step that finds hidden files but still silences the miss", () => {
  const silent = preFix.replace("          path: .records/run-*.json\n", "");
  const withHidden = silent.replace(
    "          name: run-record\n",
    "          name: run-record\n          path: .records/run-*.json\n          include-hidden-files: true\n",
  );
  assert.deepEqual(deliveryViolations(withHidden, "regression.yml"), [
    'regression.yml: "Upload the run record" uploads the hidden record path .records/run-*.json and swallows a missing record with if-no-files-found: ignore',
  ]);
});

test("a conforming hidden-record step — include-hidden-files on, warn on empty — is clean", () => {
  const fixed = preFix
    .replace(
      "          path: .records/run-*.json\n",
      "          path: .records/run-*.json\n          include-hidden-files: true\n",
    )
    .replace("          if-no-files-found: ignore", "          if-no-files-found: warn");
  assert.deepEqual(deliveryViolations(fixed, "regression.yml"), []);
});

test("a visible path stays outside the guard — the sarif upload's runner.temp keeps its own rules", () => {
  const visible = workflow([
    "      - name: Upload the sarif",
    "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
    "        with:",
    "          name: results.sarif",
    "          path: ${{ runner.temp }}/results.sarif",
    "          if-no-files-found: ignore",
  ]);
  assert.deepEqual(deliveryViolations(visible, "analysis.yml"), []);
});
