// Tests for event-parity.mjs.
//
// The first cases are the repository's own tree: the gate's whole point is
// that what every surface declares for an action is what the action's
// entrypoint accepts, so the real files are the primary fixture. Everything
// after them is synthetic text held in memory — `evaluate` is a pure function
// over parsed facts, so the tests need no repository writes and no mocking.
// The #463 regression cases assert the defect's exact shape — a surface
// declaring `workflow_dispatch` for `triage` — against inline fixtures, the
// way the tree looked before the fix.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACCEPTED,
  collect,
  evaluate,
  extractDocTemplates,
  parseWorkflowTriggers,
} from "./event-parity.mjs";

/** A document fence in the shape the real templates use. */
const TRIAGE_TEMPLATE = `# Enroll a target

\`\`\`yaml
name: Triage
on:
  issues:
    types: [opened, edited]
  pull_request:
    types: [opened, synchronize]
jobs:
  triage:
    steps:
      - uses: ecoma-io/action-agents/triage@v0.11
        with:
          model: triage
\`\`\`
`;

/** A workflow file in the shape this repository's own dogfood ones use. */
const TRIAGE_WORKFLOW = `name: Triage
on:
  issues:
    types: [opened]
  pull_request:
    types: [opened]
permissions:
  contents: read
jobs:
  triage:
    steps:
      - uses: ./triage
`;

/** The review side of the same shape — pull_request, and nothing else. */
const REVIEW_WORKFLOW = `name: Review
on:
  pull_request:
    types: [opened]
permissions:
  contents: read
jobs:
  review:
    steps:
      - uses: ./review
`;

function docTemplates(text, surface = "docs/dogfood.md") {
  return extractDocTemplates(text, surface);
}

/** The declared event names of one parsed surface. */
function names(surface) {
  return surface?.triggers.map((trigger) => trigger.name) ?? [];
}

function workflowSurfaces(text, action = "triage", surface = ".github/workflows/triage.yml") {
  const parsed = parseWorkflowTriggers(text, surface, action);
  assert.deepEqual(parsed.errors, []);
  return parsed.surfaces;
}

test("the repository's own surfaces promise only events the entrypoints accept", () => {
  const { failures, workflows, templates } = evaluate({ ...collect(), accepted: ACCEPTED });
  assert.deepEqual(failures, []);
  // The gate must have read all three actions' own workflows and at least one
  // document template; fewer means it stopped seeing the tree it judges.
  assert.equal(workflows, 3);
  assert.ok(templates > 0, "expected at least one documented workflow template");
});

test("triage is declared on exactly its accepted events, review on exactly its one", () => {
  const { workflows, templates } = collect();
  for (const action of ["triage", "review"]) {
    const declared = [...workflows, ...templates]
      .filter((surface) => surface.action === action)
      .flatMap((surface) => names(surface));
    assert.deepEqual(
      [...new Set(declared)].sort(),
      [...ACCEPTED[action]].sort(),
      `${action}'s declared triggers drifted from what its entrypoint accepts`,
    );
  }
});

test("issue #463: a template declaring workflow_dispatch for triage fails, naming surface, line and event", () => {
  const defective = TRIAGE_TEMPLATE.replace(
    "  pull_request:\n    types: [opened, synchronize]",
    "  pull_request:\n    types: [opened, synchronize]\n  workflow_dispatch:",
  );
  const { templates, errors } = docTemplates(defective, "docs/dogfood.md");
  assert.deepEqual(errors, []);
  const { failures } = evaluate({ workflows: [], templates, errors, accepted: ACCEPTED });
  const failure = failures.find((line) => line.includes("'workflow_dispatch'"));
  assert.ok(failure, `no failure names 'workflow_dispatch': ${JSON.stringify(failures)}`);
  assert.match(failure, /docs\/dogfood\.md:10/);
  assert.match(failure, /declares 'workflow_dispatch' for triage/);
  assert.match(failure, /accepts 'issues' and 'pull_request'/);
  assert.match(failure, /run contract F-01/);
});

test("issue #463: the workflow file the kit shipped fails the same way", () => {
  const defective = TRIAGE_WORKFLOW.replace(
    "  pull_request:\n    types: [opened]",
    "  pull_request:\n    types: [opened]\n  workflow_dispatch:",
  );
  const surfaces = workflowSurfaces(defective);
  const { failures } = evaluate({
    workflows: surfaces,
    templates: [],
    errors: [],
    accepted: ACCEPTED,
  });
  const failure = failures.find((line) => line.includes("'workflow_dispatch'"));
  assert.ok(failure, `no failure names 'workflow_dispatch': ${JSON.stringify(failures)}`);
  assert.match(failure, /\.github\/workflows\/triage\.yml:7/);
  assert.match(failure, /declares 'workflow_dispatch' for triage/);
});

test("a scalar on: value is read — a review template keeping its no-dispatch shape stays green", () => {
  const review = `# Review

\`\`\`yaml
name: Review
on: pull_request
jobs:
  review:
    steps:
      - uses: ecoma-io/action-agents/review@v0.11
\`\`\`
`;
  const { templates, errors } = docTemplates(review, "README.md");
  assert.deepEqual(errors, []);
  assert.equal(templates.length, 1);
  assert.deepEqual(names(templates[0]), ["pull_request"]);
  const { failures } = evaluate({
    workflows: workflowSurfaces(REVIEW_WORKFLOW, "review", ".github/workflows/review.yml"),
    templates,
    errors,
    accepted: { review: ACCEPTED.review },
  });
  assert.deepEqual(failures, []);
});

test("a flow on: value is read the same way", () => {
  const flow = TRIAGE_TEMPLATE.replace(
    `on:
  issues:
    types: [opened, edited]
  pull_request:
    types: [opened, synchronize]`,
    "on: [issues, pull_request]",
  );
  assert.deepEqual(names(docTemplates(flow).templates[0]), ["issues", "pull_request"]);
});

test("an accepted event no surface declares is surfaced as drift, not silently green", () => {
  const accepted = { triage: ["issues", "pull_request", "push"] };
  const { failures, drift } = evaluate({
    workflows: workflowSurfaces(TRIAGE_WORKFLOW),
    templates: docTemplates(TRIAGE_TEMPLATE).templates,
    errors: [],
    accepted,
  });
  assert.deepEqual(failures, []);
  assert.equal(drift.length, 1);
  assert.match(drift[0] ?? "", /triage accepts 'push' and no covered surface declares it/);
});

test("the live tree's drift is exactly harmonise's undeclared pull_request and push", () => {
  const { drift } = evaluate({ ...collect(), accepted: ACCEPTED });
  // harmonise has no throw gate: it resolves a policy source for pull_request
  // and push runs that nothing declares. This assertion is the notice — if a
  // surface starts declaring them, or the set changes, this test names it.
  assert.equal(drift.length, 2, JSON.stringify(drift));
  assert.match(
    drift[0] ?? "",
    /harmonise accepts 'pull_request' and no covered surface declares it/,
  );
  assert.match(drift[1] ?? "", /harmonise accepts 'push' and no covered surface declares it/);
});

test("a fence declaring an on: block for no judgeable action fails closed", () => {
  const anonymous = `# Enroll

\`\`\`yaml
name: Triage
on:
  issues:
    types: [opened]
jobs:
  triage:
    steps:
      - uses: actions/checkout@v5
\`\`\`
`;
  const { templates, errors } = docTemplates(anonymous);
  assert.deepEqual(templates, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.text ?? "", /names none of the actions this gate judges/);
});

test("a fence naming two actions fails closed as ambiguous", () => {
  const ambiguous = TRIAGE_TEMPLATE.replace(
    "- uses: ecoma-io/action-agents/triage@v0.11",
    "- uses: ./triage\n      - uses: ./review",
  );
  const { templates, errors } = docTemplates(ambiguous);
  assert.deepEqual(templates, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.text ?? "", /names review and triage — ambiguous/);
});

test("a fence naming an action without an on: block is a step snippet, not a trigger surface", () => {
  const snippet = `## Install

\`\`\`yaml
- uses: ecoma-io/action-agents/triage@v0.11
  with:
    model: triage
\`\`\`
`;
  const { templates, errors } = docTemplates(snippet, "docs/guides/triage.md");
  assert.deepEqual(errors, []);
  assert.deepEqual(templates, []);
});

test("a workflow file with no on: block fails closed over GitHub's implicit defaults", () => {
  const bare = `name: Triage
permissions:
  contents: read
jobs:
  triage:
    steps:
      - uses: ./triage
`;
  const parsed = parseWorkflowTriggers(bare, ".github/workflows/triage.yml", "triage");
  assert.deepEqual(parsed.surfaces, []);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0]?.text ?? "", /defaults the workflow to push and pull_request/);
});

test("a workflow file whose on: block is empty fails closed", () => {
  const empty = `name: Triage
on:
permissions:
  contents: read
`;
  const parsed = parseWorkflowTriggers(empty, ".github/workflows/triage.yml", "triage");
  assert.deepEqual(parsed.surfaces[0]?.triggers, []);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0]?.text ?? "", /on: block with no trigger/);
});

test("a trigger value the parser cannot read as an event name fails closed", () => {
  const prose = TRIAGE_TEMPLATE.replace("on:\n  issues:", "on: see the README");
  const { templates, errors } = docTemplates(prose);
  assert.deepEqual(templates[0]?.triggers, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.text ?? "", /not event names/);
});

test("a missing workflow file is a failure, not a green scan", () => {
  const { failures } = evaluate({
    workflows: workflowSurfaces(TRIAGE_WORKFLOW),
    templates: docTemplates(TRIAGE_TEMPLATE).templates,
    errors: [],
    accepted: ACCEPTED,
  });
  assert.equal(failures.length, 2);
  assert.match(failures[0] ?? "", /\.github\/workflows\/harmonise\.yml was not read/);
  assert.match(failures[1] ?? "", /\.github\/workflows\/review\.yml was not read/);
});

test("no document template at all is a failure, not a green scan", () => {
  const { failures } = evaluate({
    workflows: [
      ...workflowSurfaces(TRIAGE_WORKFLOW),
      ...workflowSurfaces(TRIAGE_WORKFLOW, "review", ".github/workflows/review.yml"),
      ...workflowSurfaces(TRIAGE_WORKFLOW, "harmonise", ".github/workflows/harmonise.yml"),
    ],
    templates: [],
    errors: [],
    accepted: ACCEPTED,
  });
  const failure = failures.find((line) => line.includes("no workflow template was found"));
  assert.ok(failure, `no failure names the empty template scan: ${JSON.stringify(failures)}`);
});
