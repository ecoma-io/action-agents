// Tests for check-anchors.mjs.
//
// `headingSlugs` and `evaluate` take every fact they need as an argument, so
// these run with no filesystem. `readFacts` and `main` are deliberately not
// tested: they exist to read real paths, and a test that stubbed them would
// only pin the stub.
//
// The duplicate-heading case is the one this file exists for. The previous
// implementation reset the slugger before every heading, so three `## Setup`
// headings all collapsed to `setup` and a link to the valid `#setup-1` was
// reported as broken. That is the worst shape a documentation gate can take —
// a false positive teaches contributors to distrust it, and a distrusted gate
// gets bypassed.

import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate, headingSlugs } from "./check-anchors.mjs";

test("repeated headings anchor the way GitHub renders them", () => {
  const slugs = headingSlugs("# Setup\n\n## Setup\n\n### Setup\n");
  assert.deepEqual([...slugs], ["setup", "setup-1", "setup-2"]);
});

test("an em dash contributes its two surrounding spaces, not one hyphen", () => {
  // The belief this checker exists to disprove: `A — B` is `a--b`, not `a-b`.
  assert.ok(headingSlugs("## A — B\n").has("a--b"));
});

test("a fragment naming a real heading in another file resolves", () => {
  const result = evaluate({
    files: [{ path: "README.md", text: "see [setup](CONTRIBUTING.md#setting-up)\n" }],
    textOf: (path) => (path === "CONTRIBUTING.md" ? "## Setting up\n" : undefined),
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.checked, 1);
});

test("a fragment naming no heading fails, and names the file it looked in", () => {
  const result = evaluate({
    files: [{ path: "README.md", text: "see [gone](CONTRIBUTING.md#gone)\n" }],
    textOf: () => "## Setting up\n",
  });

  assert.equal(result.failures.length, 1);
  assert.match(
    result.failures[0],
    /^README\.md:1: CONTRIBUTING\.md#gone — no heading anchors to "gone"/,
  );
});

test("a link to the second occurrence of a repeated heading resolves", () => {
  const result = evaluate({
    files: [{ path: "README.md", text: "[second](GUIDE.md#setup-1)\n" }],
    textOf: () => "## Setup\n\n## Setup\n",
  });

  assert.deepEqual(result.failures, [], "this is the regression the rewrite fixed");
});

test("a same-file fragment is resolved against the carrying document", () => {
  const result = evaluate({
    files: [{ path: "README.md", text: "## Install\n\njump to [install](#install)\n" }],
    textOf: () => assert.fail("a same-file fragment must not read another file"),
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.checked, 1);
});

test("a missing target file is left to check-docs-links, not reported twice", () => {
  const result = evaluate({
    files: [{ path: "README.md", text: "[x](NOPE.md#anything)\n" }],
    textOf: () => undefined,
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.checked, 0, "an unreadable target is not an inspected anchor");
});

test("external links are not resolved", () => {
  const result = evaluate({
    files: [
      {
        path: "README.md",
        text: "[a](https://example.com/x#frag) and [b](mailto:x@example.com#frag)\n",
      },
    ],
    textOf: () => assert.fail("an external target must not be read"),
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.checked, 0);
});

test("the user-content- prefix GitHub adds is stripped before matching", () => {
  const result = evaluate({
    files: [{ path: "README.md", text: "[x](GUIDE.md#user-content-setup)\n" }],
    textOf: () => "## Setup\n",
  });

  assert.deepEqual(result.failures, []);
});

test("a relative path is resolved from the linking document, not the root", () => {
  const result = evaluate({
    files: [{ path: "docs/guides/review.md", text: "[up](../concepts/graph.md#edges)\n" }],
    textOf: (path) => (path === "docs/concepts/graph.md" ? "## Edges\n" : undefined),
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.checked, 1);
});
