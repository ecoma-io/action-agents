// Tests for check-action-shape (I8).
//
// Pure evaluate() cases over a synthetic walk result; the canary fixture at
// tools/fixtures/action-shape is judged by pointing the gate at it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate } from "./check-action-shape.mjs";

const clean = (tree) => evaluate(tree).failures;

test("a dependencies block is a violation, empty or not", () => {
  const tree = (path, json) => ({
    manifests: [{ path, json, malformed: false }],
    distDirs: [],
    actions: [],
  });
  assert.match(
    clean(tree("package.json", { dependencies: { left: "^1" } }))[0],
    /declares a "dependencies" block — there are no runtime dependencies \(invariant I8\)$/,
  );
  assert.match(
    clean(tree("nested/deep/package.json", { dependencies: {} }))[0],
    /^nested\/deep\/package\.json:0: /,
  );
});

test("devDependencies are the dev toolchain and stay allowed", () => {
  assert.deepEqual(
    clean({
      manifests: [
        {
          path: "package.json",
          json: { devDependencies: { archkeep: "^0.21.0" } },
          malformed: false,
        },
      ],
      distDirs: [],
      actions: [],
    }),
    [],
  );
});

test("a malformed manifest fails closed", () => {
  assert.match(
    clean({
      manifests: [{ path: "package.json", json: null, malformed: true }],
      distDirs: [],
      actions: [],
    })[0],
    /package\.json is not valid JSON \(invariant I8\)$/,
  );
});

test("a dist directory is the build that does not exist", () => {
  assert.match(
    clean({ manifests: [], distDirs: ["build/dist"], actions: [] })[0],
    /^build\/dist:0: built dist\/ directory exists — there is no build \(invariant I8\)$/,
  );
});

test("action.yaml must run on exactly node24", () => {
  const good = clean({
    manifests: [],
    distDirs: [],
    actions: [
      { path: "triage/action.yaml", text: "runs:\n  using: node24\n  main: src/index.mjs\n" },
    ],
  });
  assert.deepEqual(good, []);

  const wrong = clean({
    manifests: [],
    distDirs: [],
    actions: [
      { path: "triage/action.yaml", text: "runs:\n  using: node20\n  main: src/index.mjs\n" },
    ],
  });
  assert.match(
    wrong[0],
    /^triage\/action\.yaml:0: runs\.using "node20" — child actions run on node24 only \(invariant I8\)$/,
  );

  const absent = clean({
    manifests: [],
    distDirs: [],
    actions: [{ path: "triage/action.yaml", text: "name: x\ndescription: y\n" }],
  });
  assert.match(absent[0], /no runs\.using — the runner cannot start the action \(invariant I8\)$/);
});

test("every finding names its invariant", () => {
  const { failures } = evaluate({
    manifests: [{ path: "package.json", json: { dependencies: {} }, malformed: false }],
    distDirs: ["dist"],
    actions: [{ path: "review/action.yaml", text: "using: node22" }],
  });
  assert.equal(failures.length, 3);
  assert.ok(failures.every((f) => f.includes("(invariant I8)")));
});
