// Tests for check-workflow-inputs.mjs.
//
// The first case is the repository's own tree: the gate's whole point is that
// what CI actually runs agrees with what the manifests declare, so the real
// files are the primary fixture. Everything after it is a synthetic file held
// in memory — `evaluate` is a pure function over parsed facts, so the tests
// need no mocking and no filesystem games.
import assert from "node:assert/strict";
import { test } from "node:test";

import { collect, evaluate, parseManifest, parseWorkflow } from "./check-workflow-inputs.mjs";

/** A manifest in the shape the real ones use. */
const MANIFEST = `name: Triage
description: Label issues and pull requests.
inputs:
  github-token:
    description: The token the action acts with.
    required: true
  model:
    description: The model to ask.
    required: true
  dry-run:
    description: Log the decision without applying it.
    required: false
`;

/** A workflow in the shape the real ones use — pinned checkout, one local step. */
const WORKFLOW = `name: Triage
on:
  issues:
    types: [opened]
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: ./triage
        with:
          github-token: \${{ secrets.GITHUB_TOKEN }}
          model: triage
`;

function manifest(text, path = "triage/action.yaml") {
  return parseManifest(text, path);
}

function workflow(text, path = ".github/workflows/triage.yml") {
  return parseWorkflow(text, path);
}

test("the repository's own workflows agree with the manifests they run", () => {
  const { workflows, manifests } = collect();
  const { failures, steps } = evaluate({ workflows, manifests });
  assert.deepEqual(failures, []);
  // triage, review and harmonise each run from at least one workflow; fewer
  // means the gate stopped seeing the tree it exists to judge.
  assert.ok(steps >= 3, `expected the three dogfood local steps, saw ${steps}`);
});

test("a with-key the manifest does not declare fails, naming workflow, job, step and manifest", () => {
  const undeclared = `${WORKFLOW}          labels: bug\n`;
  const result = evaluate({ workflows: [workflow(undeclared)], manifests: [manifest(MANIFEST)] });
  const failure = result.failures.find((line) => line.includes("'labels'"));
  assert.ok(failure, `no failure names 'labels': ${JSON.stringify(result.failures)}`);
  assert.match(failure, /\.github\/workflows\/triage\.yml/);
  assert.match(failure, /job 'triage'/);
  assert.match(failure, /step 2/);
  assert.match(failure, /triage\/action\.yaml/);
});

test("a required input no step passes fails, naming the manifest and the input", () => {
  const partial = WORKFLOW.replace("          github-token: ${{ secrets.GITHUB_TOKEN }}\n", "");
  const result = evaluate({ workflows: [workflow(partial)], manifests: [manifest(MANIFEST)] });
  const failure = result.failures.find((line) => line.includes("'github-token'"));
  assert.ok(failure, `no failure names 'github-token': ${JSON.stringify(result.failures)}`);
  assert.match(failure, /triage\/action\.yaml requires 'github-token'/);
});

test("no workflow file at all is a failure, not a green scan", () => {
  const result = evaluate({ workflows: [], manifests: [manifest(MANIFEST)] });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0] ?? "", /no workflow file was found under/);
});

test("a local uses pointing at a directory with no manifest fails, naming the step", () => {
  const ghost = WORKFLOW.replace("uses: ./triage", "uses: ./ghost");
  const result = evaluate({ workflows: [workflow(ghost)], manifests: [manifest(MANIFEST)] });
  const failure = result.failures.find((line) => line.includes("./ghost"));
  assert.ok(failure, `no failure names './ghost': ${JSON.stringify(result.failures)}`);
  assert.match(failure, /step 2/);
});

test("shell inside a run block is never read as with-keys", () => {
  const shell = `jobs:
  triage:
    steps:
      - name: Print
        run: |
          echo "with: not-a-key"
          echo 'github-token: nope'
      - uses: ./triage
        with:
          github-token: token
          model: triage
`;
  const wf = workflow(shell);
  assert.deepEqual(wf.jobs[0]?.steps[0]?.withKeys, []);
  const result = evaluate({ workflows: [wf], manifests: [manifest(MANIFEST)] });
  assert.deepEqual(result.failures, []);
});

test("a quoted uses value is still recognized as a local action", () => {
  const quoted = WORKFLOW.replace("uses: ./triage", 'uses: "./triage"');
  const result = evaluate({ workflows: [workflow(quoted)], manifests: [manifest(MANIFEST)] });
  assert.deepEqual(result.failures, []);
});

test("an input the manifest grows is judged from the manifest, not from hard-coded names", () => {
  const grown = MANIFEST.replace(
    "  dry-run:",
    "  artifact-url:\n    description: Where the run posted its bundle.\n    required: false\n  dry-run:",
  );
  const passing = `${WORKFLOW}          artifact-url: \${{ env.BUNDLE_URL }}\n`;
  const result = evaluate({ workflows: [workflow(passing)], manifests: [manifest(grown)] });
  assert.deepEqual(result.failures, []);
});

test("a line the parser cannot classify fails, naming file and line", () => {
  const broken = "name: Broken\nthis is not yaml\njobs: {}\n";
  const result = evaluate({
    workflows: [workflow(broken, ".github/workflows/broken.yml")],
    manifests: [manifest(MANIFEST)],
  });
  const failure = result.failures.find((line) => line.includes("broken.yml"));
  assert.ok(failure, `no failure names broken.yml: ${JSON.stringify(result.failures)}`);
  assert.match(failure, /:2:/);
  assert.match(failure, /this is not yaml/);
});

test("an action no workflow runs is not demanded by this gate", () => {
  const reviewOnly = WORKFLOW.replace("./triage", "./review").replace(
    "model: triage",
    "model: review",
  );
  const result = evaluate({
    workflows: [workflow(reviewOnly)],
    // The triage manifest is on disk but run by nothing here: its required
    // inputs are this gate's business only where a dogfood step passes them.
    manifests: [manifest(MANIFEST), manifest(MANIFEST, "review/action.yaml")],
  });
  assert.deepEqual(result.failures, []);
});

test("a manifest path carrying the host's backslashes still binds to its ./uses step", () => {
  // collect() joins the manifest path with the host's separator, so on Windows
  // the path arrives as `triage\action.yaml`. The action key must still be the
  // directory — a key of the whole path leaves every local action reported as
  // manifest-less on win32 (#244).
  const win32 = manifest(MANIFEST, "triage\\action.yaml");
  assert.equal(win32.action, "triage");
  const result = evaluate({ workflows: [workflow(WORKFLOW)], manifests: [win32] });
  assert.deepEqual(result.failures, []);
});
