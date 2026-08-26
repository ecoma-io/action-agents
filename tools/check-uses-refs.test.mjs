// Tests for check-uses-refs.mjs.
//
// `evaluate` takes every fact it needs as an argument — the doc files, the tag
// set, and a predicate for "does this action ship at that tag" — so these run
// with no repository and no git. What is deliberately NOT tested is `readFacts`
// and `main`: they exist to read real paths and a test that stubbed them would
// only pin the stub.
//
// The first case below is the one this file exists for. This gate spent the
// rename carrying the pattern `ecoma-io/reeve` while its own documentation said
// `ecoma-io/action-agents`, so it matched nothing and printed a success line on
// every run. A gate that goes red gets fixed; one that reports green while
// reading nothing gets trusted. Both directions of that failure are pinned here.

import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate } from "./check-uses-refs.mjs";

/** @param {string} text @param {string} [path] */
const doc = (text, path = "README.md") => ({ path, text });

/** Every action ships at every tag. */
const shipsEverywhere = () => true;

test("finding no refs at all is a failure, not a pass", () => {
  const result = evaluate({
    files: [doc("# Action Agents\n\nNothing here mentions using anything.\n")],
    tags: new Set(["v0.1.0"]),
    hasManifest: shipsEverywhere,
  });

  assert.equal(result.found, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /no `uses: ecoma-io\/action-agents/);
});

test("a line naming the repository that does not parse as a ref is reported", () => {
  // The exact shape of the rename bug: the org and repo are named, the gate's
  // own pattern no longer matches, and nothing else in the tree would notice.
  const result = evaluate({
    files: [doc("      - uses: ecoma-io/action-agent/review@v0.1.0\n")],
    tags: new Set(["v0.1.0"]),
    hasManifest: shipsEverywhere,
  });

  assert.equal(result.failures.length, 2, "the unparsed line, and the zero-refs guard");
  assert.match(result.failures[0], /does not parse as/);
});

test("a ref at an existing tag whose action ships there resolves", () => {
  const result = evaluate({
    files: [doc("      - uses: ecoma-io/action-agents/review@v0.1\n")],
    tags: new Set(["v0.1"]),
    hasManifest: shipsEverywhere,
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.checked, 1);
  assert.equal(result.exempt, 0);
});

test("a ref at a tag that does not exist fails", () => {
  const result = evaluate({
    files: [doc("      - uses: ecoma-io/action-agents/review@v9.9.9\n")],
    tags: new Set(["v0.1"]),
    hasManifest: shipsEverywhere,
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /no such tag/);
});

test("an action documented before the tag it debuts in fails", () => {
  const result = evaluate({
    files: [doc("      - uses: ecoma-io/action-agents/harmonise@v0.1\n")],
    tags: new Set(["v0.1"]),
    hasManifest: (_tag, action) => action !== "harmonise",
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /no harmonise\/action\.yaml at v0\.1/);
});

test("a root ref with no action manifest at that tag fails", () => {
  const result = evaluate({
    files: [doc("      - uses: ecoma-io/action-agents@v0.1\n")],
    tags: new Set(["v0.1"]),
    hasManifest: (_tag, action) => action !== "",
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /no action\.yml at repository root/);
});

test("a root ref with a manifest at that tag resolves", () => {
  const result = evaluate({
    files: [doc("      - uses: ecoma-io/action-agents@v0.1\n")],
    tags: new Set(["v0.1"]),
    hasManifest: shipsEverywhere,
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.checked, 1);
});

test("a commit SHA is valid without a tag lookup", () => {
  const sha = "a".repeat(40);
  const result = evaluate({
    files: [doc(`      - uses: ecoma-io/action-agents/review@${sha}\n`)],
    tags: new Set(),
    hasManifest: () => assert.fail("a SHA must not be resolved against a tag"),
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.checked, 1);
});

test("a ref that is neither a SHA nor a version tag is unparseable", () => {
  const result = evaluate({
    files: [doc("      - uses: ecoma-io/action-agents/review@main\n")],
    tags: new Set(["v0.1"]),
    hasManifest: shipsEverywhere,
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /unparseable ref/);
});

test("a marked line is exempt, counted, and never resolved", () => {
  const result = evaluate({
    files: [doc("      - uses: ecoma-io/action-agents/review@v0.1 # roadmap ref\n")],
    tags: new Set(),
    hasManifest: () => assert.fail("an exempt ref must not be resolved"),
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.found, 1, "an exempt ref still counts as found");
  assert.equal(result.exempt, 1);
  assert.equal(result.checked, 0);
});

test("the html comment form of the marker is honoured too", () => {
  const result = evaluate({
    files: [doc("`uses: ecoma-io/action-agents/review@v2` <!-- roadmap ref -->\n")],
    tags: new Set(),
    hasManifest: () => assert.fail("an exempt ref must not be resolved"),
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.exempt, 1);
});

test("failures name the file and line they came from", () => {
  const result = evaluate({
    files: [
      doc("intro\n\n      - uses: ecoma-io/action-agents/review@v9.9.9\n", "docs/guides/review.md"),
    ],
    tags: new Set(["v0.1"]),
    hasManifest: shipsEverywhere,
  });

  assert.match(result.failures[0], /^docs\/guides\/review\.md:3:/);
});
