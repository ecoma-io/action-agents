// Tests for check-docs-links.mjs.
//
// `parseMarkdownLinks`, `parseDocCitations`, `githubSlug`, `headingAnchors`,
// and `evaluate` take every fact they need as an argument, so these run with
// no repository and no filesystem — the logic already sits at the isolation
// boundary. What is deliberately NOT tested is `readFacts`: it exists to ask
// `git ls-files` a question, and a test that stubbed the answer would only pin
// the stub. The real thing runs in CI against the real tracked tree.
//
// Every failure case below goes red in the SILENT direction first: a broken
// reference is a file that clicked through lands on nothing, and the gate's
// job is to make that read as a failure instead of a clean run. The case that
// removes the check entirely is `evaluate` with no files, which must fail
// loudly rather than report a clean scan of nothing.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluate,
  githubSlug,
  globPrefix,
  headingAnchors,
  parseDocCitations,
  parseMarkdownLinks,
  parseYamlPathReferences,
  withDirectories,
} from "./check-docs-links.mjs";

test("parseMarkdownLinks keeps local paths with their line numbers", () => {
  const text = `# Title

See [policy](usage/configuration.md) and
[another](../reference/policy-schema.md#inline-policy) on line 4.`;
  assert.deepEqual(parseMarkdownLinks(text), [
    { target: "usage/configuration.md", line: 3 },
    { target: "../reference/policy-schema.md#inline-policy", line: 4 },
  ]);
});

test("parseMarkdownLinks keeps #anchors (heading checks) but drops external targets", () => {
  const text = `[web](https://example.com) [anchor](#same-file) [mail](mailto:x@y.z)
[dots](./local.md) [proto](javascript:void(0))`;
  assert.deepEqual(parseMarkdownLinks(text), [
    { target: "#same-file", line: 1 },
    { target: "./local.md", line: 2 },
  ]);
});

test("parseDocCitations finds docs/ citations, root-relative and carrying-file relative", () => {
  const text = "see `docs/usage/ci.md` here and `../../docs/reference/cli.md` there";
  assert.deepEqual(parseDocCitations(text), [
    { target: "docs/usage/ci.md", line: 1 },
    { target: "../../docs/reference/cli.md", line: 1 },
  ]);
});

test("parseDocCitations does not double-judge a markdown link target as a citation", () => {
  // `usage/configuration.md` is not a `docs/…` citation, and the `docs/…`
  // target it DOES carry is a link, already judged by the link parser with
  // the link's own resolution rule — the citation pass removes link syntax
  // so the same target is not judged twice by different rules.
  const text = "[policy](docs/usage/configuration.md)";
  assert.deepEqual(parseDocCitations(text), []);
});

test("githubSlug normalizes like GitHub's heading anchors", () => {
  assert.equal(githubSlug("boundaryConfig"), "boundaryconfig");
  assert.equal(
    githubSlug("nx affected still misses a dependency"),
    "nx-affected-still-misses-a-dependency",
  );
  // github-slugger removes the em-dash but keeps BOTH surrounding spaces, which
  // collapse into a DOUBLE hyphen: `exit-3--no-verdict`, never single.
  assert.equal(githubSlug('Exit 3 — "no verdict"'), "exit-3--no-verdict");
  assert.equal(githubSlug("PLAIN"), "plain");
});

test("headingAnchors covers every heading and GitHub's duplicate suffix", () => {
  const text = `# One

## Two, repeated

## Two, repeated

### Three`;
  assert.deepEqual(
    [...headingAnchors(text)].sort(),
    ["one", "three", "two-repeated", "two-repeated-1"].sort(),
  );
});

test("withDirectories adds every parent directory of a path", () => {
  const paths = ["/repo/docs/usage/checking.md"];
  assert.ok(withDirectories(paths).has("/repo/docs/usage/checking.md"));
  assert.ok(withDirectories(paths).has("/repo/docs/usage"));
  assert.ok(withDirectories(paths).has("/repo/docs"));
  assert.ok(withDirectories(paths).has("/repo"));
});

function file(path, { links = [], citations = [], paths = [], headings = new Set() } = {}) {
  return { path, links, citations, paths, headings };
}

/** A shape-3 reference, exempt unless a test says otherwise. */
function ref(target, line, exempt = false) {
  return { target, line, exempt };
}

/** The absolute path a repo-relative `path` resolves to under `/repo`. */
function abs(path) {
  return `/repo/${path}`;
}

test("evaluate fails loudly on NO files, instead of reporting a clean scan", () => {
  const { failures } = evaluate({ files: [], existingPaths: new Set(), root: "/repo" });
  assert.ok(failures.length > 0);
  assert.match(failures[0], /no files were scanned/);
});

test("evaluate passes a link whose target file exists", () => {
  const { failures } = evaluate({
    files: [file("docs/a.md", { links: [{ target: "b.md", line: 1 }] })],
    existingPaths: new Set([abs("docs/b.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a link whose target file does not exist — the silent direction", () => {
  const { failures } = evaluate({
    files: [file("docs/a.md", { links: [{ target: "gone.md", line: 4 }] })],
    existingPaths: new Set(),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /docs\/a\.md:4/);
  assert.match(failures[0], /gone\.md/);
});

test("evaluate resolves a link from the file that carries it, not the workspace root", () => {
  // `docs/usage/a.md` linking to `b.md` is `docs/usage/b.md` — existing —
  // not `docs/b.md` — missing. A root-relative read would fail this clean
  // tree, which is a violation that is not real.
  const { failures } = evaluate({
    files: [file("docs/usage/a.md", { links: [{ target: "b.md", line: 1 }] })],
    existingPaths: new Set([abs("docs/usage/b.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a same-file anchor that names no heading", () => {
  const { failures } = evaluate({
    files: [
      file("docs/c.md", {
        links: [{ target: "#missing-heading", line: 2 }],
        headings: new Set(["present"]),
      }),
    ],
    existingPaths: new Set([abs("docs/c.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no heading/);
});

test("evaluate passes a same-file anchor that matches a heading", () => {
  const { failures } = evaluate({
    files: [
      file("docs/d.md", {
        links: [{ target: "#present", line: 2 }],
        headings: new Set(["present"]),
      }),
    ],
    existingPaths: new Set([abs("docs/d.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a same-file anchor even when the file exists — the heading is gone", () => {
  const { failures } = evaluate({
    files: [
      file("docs/d.md", {
        links: [{ target: "#removed", line: 2 }],
        headings: new Set(["present"]),
      }),
    ],
    existingPaths: new Set([abs("docs/d.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /#removed/);
});

test("evaluate checks only the file half of a file.md#fragment link", () => {
  // The fragment promises a heading in ANOTHER file, which GitHub's own
  // anchor handling does not guarantee — so only the file half is checked.
  const { failures } = evaluate({
    files: [file("docs/e.md", { links: [{ target: "other.md#any-fragment", line: 1 }] })],
    existingPaths: new Set([abs("docs/other.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a root-relative docs/ citation that does not exist", () => {
  const { failures } = evaluate({
    files: [
      file("packages/example/src/x.mjs", { citations: [{ target: "docs/gone.md", line: 3 }] }),
    ],
    existingPaths: new Set(),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /packages\/example\/src\/x\.mjs:3/);
});

test("evaluate resolves a ../ citation from its carrying file", () => {
  // `../../../docs/…` from `packages/example/src/x.mjs` climbs three levels
  // to the workspace root and lands on `docs/…` — the same path rule that
  // resolves the file, applied to the citation. A shorter climb would be
  // judged against `packages/docs/…` and fail: the file's own directory is
  // the base, not the workspace root.
  const { failures } = evaluate({
    files: [
      file("packages/example/src/x.mjs", {
        citations: [{ target: "../../../docs/usage/ci.md", line: 1 }],
      }),
    ],
    existingPaths: new Set([abs("docs/usage/ci.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a ../ citation whose relative target does not exist", () => {
  const { failures } = evaluate({
    files: [
      file("packages/example/src/x.mjs", {
        citations: [{ target: "../../../docs/nope.md", line: 5 }],
      }),
    ],
    existingPaths: new Set(),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /nope\.md/);
});

test("evaluate passes a link to a directory — GitHub renders it as a listing", () => {
  const { failures } = evaluate({
    files: [file("docs/getting-started/x.md", { links: [{ target: "../usage/", line: 4 }] })],
    existingPaths: withDirectories([abs("docs/usage/checking.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a docs/ page linking OUTSIDE docs/ — the one-way door", () => {
  // A docs page linking to `../CONTRIBUTING.md` is a failure even though the
  // target exists: documentation is a self-contained tree, and a page inside
  // docs/ may only point at another page inside docs/.
  const { failures } = evaluate({
    files: [file("docs/README.md", { links: [{ target: "../CONTRIBUTING.md", line: 5 }] })],
    existingPaths: withDirectories([abs("CONTRIBUTING.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /OUTSIDE docs\//);
  assert.match(failures[0], /docs\/README\.md:5/);
});

test("evaluate allows a NON-docs markdown file to link INTO docs/", () => {
  // The direction a reader is steered toward: the root README points into
  // docs/, and that stays legal — only the reverse is refused.
  const { failures } = evaluate({
    files: [file("README.md", { links: [{ target: "docs/why.md", line: 2 }] })],
    existingPaths: withDirectories([abs("docs/why.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a docs/ page linking outside docs/ even when the target exists", () => {
  // The existence check and the containment check are independent: a link to
  // a real file outside docs/ is still a containment failure.
  const { failures } = evaluate({
    files: [
      file("docs/usage/ci.md", {
        links: [{ target: "../../packages/example/README.md", line: 9 }],
      }),
    ],
    existingPaths: withDirectories([abs("packages/example/README.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /OUTSIDE docs\//);
});

test("evaluate reports every broken reference, not just the first", () => {
  const { failures } = evaluate({
    files: [
      file("docs/a.md", {
        links: [
          { target: "one.md", line: 1 },
          { target: "two.md", line: 2 },
        ],
      }),
    ],
    existingPaths: new Set(),
    root: "/repo",
  });
  assert.equal(failures.length, 2);
});

// ── Shape 3: path references in YAML ────────────────────────────────────────
//
// The case that motivated all of it is `evaluate FAILS a workflow input naming
// a file this repository does not have`: `analysis.yml` carried
// `config-file: .github/codeql/config.yml`, every local gate passed, and CodeQL
// went red on a runner. Each parser test below is a class of text that reads
// like a repository path without being one — the gate's credibility is spent
// entirely on getting those wrong.

test("globPrefix returns the path when there is no wildcard", () => {
  assert.equal(globPrefix(".github/codeql/config.yml"), ".github/codeql/config.yml");
});

test("globPrefix roots a glob at the last directory before the wildcard", () => {
  assert.equal(globPrefix(".claude/skills/**"), ".claude/skills");
  assert.equal(globPrefix("docs/**/*.md"), "docs");
});

test("globPrefix returns empty when the first segment is itself a wildcard", () => {
  assert.equal(globPrefix("**/*.yml"), "");
});

test("parseYamlPathReferences finds a workflow input path with its line", () => {
  const text = `jobs:
  codeql:
    steps:
      - with:
          config-file: .github/codeql/config.yml`;
  assert.deepEqual(parseYamlPathReferences(text), [
    { target: ".github/codeql/config.yml", line: 5, exempt: false },
  ]);
});

test("parseYamlPathReferences drops a path built from a runner expression", () => {
  // `${{ runner.temp }}/results.sarif` is a claim about the runner, not this
  // tree, and a gate that judged it would fail every artifact path there is.
  const text = "      path: ${{ runner.temp }}/results.sarif";
  assert.deepEqual(parseYamlPathReferences(text), []);
});

test("parseYamlPathReferences blanks expressions without shifting line numbers", () => {
  const text = `a: \${{ github.sha }}
b: .github/workflows/ci.yml`;
  assert.deepEqual(parseYamlPathReferences(text), [
    { target: ".github/workflows/ci.yml", line: 2, exempt: false },
  ]);
});

test("parseYamlPathReferences drops URLs, whose host/path reads like a repo path", () => {
  const text = "  url: https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/x.tar.gz";
  assert.deepEqual(parseYamlPathReferences(text), []);
});

test("parseYamlPathReferences un-anchors a leading slash, as semgrep paths are written", () => {
  const text = '      include:\n        - "/.github/workflows/**"';
  assert.deepEqual(parseYamlPathReferences(text), [
    { target: ".github/workflows/**", line: 2, exempt: false },
  ]);
});

test("parseYamlPathReferences ignores prose that merely contains a slash", () => {
  // "the core/action boundary" is two English words. No rule about repository
  // paths can tell it from one; requiring an extension is what can.
  const text = "      # The core/action boundary, judged mechanically.";
  assert.deepEqual(parseYamlPathReferences(text), []);
});

test("parseYamlPathReferences keeps a glob even though it has no extension", () => {
  const text = "        - .claude/skills/**";
  assert.deepEqual(parseYamlPathReferences(text), [
    { target: ".claude/skills/**", line: 1, exempt: false },
  ]);
});

test("parseYamlPathReferences marks a line carrying the consumer-path marker", () => {
  const text = "    default: .github/review-instructions.md # consumer path";
  assert.deepEqual(parseYamlPathReferences(text), [
    { target: ".github/review-instructions.md", line: 1, exempt: true },
  ]);
});

test("evaluate FAILS a workflow input naming a file this repository does not have", () => {
  // The real bug, reduced: green locally, red on a runner.
  const { failures } = evaluate({
    files: [
      file(".github/workflows/analysis.yml", {
        paths: [ref(".github/codeql/config.yml", 88)],
      }),
    ],
    existingPaths: new Set([abs(".github")]),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /analysis\.yml:88/);
  assert.match(failures[0], /\.github\/codeql\/config\.yml/);
});

test("evaluate passes a workflow input whose target exists", () => {
  const { failures } = evaluate({
    files: [file("lefthook.yml", { paths: [ref(".github/workflows/ci.yml", 11)] })],
    existingPaths: new Set([abs(".github"), abs(".github/workflows/ci.yml")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate ignores a reference whose first segment is not a repository entry", () => {
  // `actions/checkout@sha`, `repos/$REPO/git/refs`, `usr/bin/bash`. Judging
  // these would be judging someone else's namespace, and the alternative to
  // this one test is a list of hosts that needs a commit per new action.
  const { failures } = evaluate({
    files: [
      file(".github/workflows/ci.yml", {
        paths: [ref("actions/checkout.yml", 3), ref("usr/bin/bash.sh", 4)],
      }),
    ],
    existingPaths: new Set([abs(".github")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate judges a glob by its prefix, not by its literal text", () => {
  const { failures } = evaluate({
    files: [file("lefthook.yml", { paths: [ref(".claude/skills/**", 2)] })],
    existingPaths: new Set([abs(".claude"), abs(".claude/skills")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a glob whose rooting directory is gone", () => {
  const { failures } = evaluate({
    files: [file("lefthook.yml", { paths: [ref(".claude/gone/**", 2)] })],
    existingPaths: new Set([abs(".claude")]),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /glob rooted at/);
});

test("evaluate waives a marked consumer path and says how many it waived", () => {
  const { lines, failures } = evaluate({
    files: [
      file("review/action.yaml", {
        paths: [ref(".github/review-instructions.md", 25, true)],
      }),
    ],
    existingPaths: new Set([abs(".github")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
  assert.match(lines.at(-1) ?? "", /1 path\(s\) exempt by marker/);
});
