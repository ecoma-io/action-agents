// Tests for check-action-pins.mjs.
//
// `evaluate` takes every fact it needs as an argument — the covered documents
// and the parsed manifest — so these run with no repository and no filesystem.
// What is deliberately NOT tested is `readDocFiles` and `main`: they exist to
// read real paths, and a test that stubbed them would only pin the stub.
//
// The two directions the gate exists for are both pinned here: a document
// showing a pin the manifest does not declare (the #346 drift), and a
// manifest declaring a pin no document shows (the stale declaration the
// checker must catch on the next release bump).

import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate, parseManifest, REF, DOC_PATHS } from "./check-action-pins.mjs";

/** @param {string} text @param {string} [path] */
const doc = (text, path = "README.md") => ({ path, text });

/** The manifest every passing case below satisfies. */
const PINS = { floating: "v0.10", exact: "v0.10.0", rootExact: "v0.10.0" };

test("pins the manifest declares, in prose and tables alike, pass and are counted", () => {
  const files = [
    doc(
      "# Action Agents\n\nUse `ecoma-io/action-agents/review@v0.10` or the exact `review@v0.10.0`.\n",
    ),
    doc(
      "| Ref | Example |\n| --- | --- |\n| `v0.10` (floating) | `ecoma-io/action-agents/review@v0.10` |\n" +
        "| `v0.10.0` (exact) | `ecoma-io/action-agents/review@v0.10.0` |\n",
      "docs/guides/getting-started.md",
    ),
    doc("It exists so that `uses: ecoma-io/action-agents@v0.10.0` resolves.\n"),
  ];
  const result = evaluate({ files, pins: PINS });
  assert.deepEqual(result.failures, []);
  // Four full refs; the prose's bare `review@v0.10.0` shorthand is not
  // repository-qualified, so the gate does not claim it.
  assert.equal(result.checked, 4);
  assert.equal(result.found, 4);
});

test("a pin the manifest does not declare fails, naming the file and line", () => {
  const result = evaluate({
    files: [doc("# Action Agents\n\n- uses: ecoma-io/action-agents/review@v0.5\n")],
    pins: PINS,
  });
  // The undeclared-pin failure is joined by the two stale-pin failures —
  // nothing in this document uses the declared values either.
  assert.equal(result.failures.length, 3);
  assert.match(result.failures[0], /README\.md:3/);
  assert.match(result.failures[0], /`review@v0\.5` is not declared/);
});

test("a declared pin no document shows is a stale pin", () => {
  const result = evaluate({
    files: [doc("Only the floating line: `ecoma-io/action-agents/review@v0.10`\n")],
    pins: PINS,
  });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /stale pin: `v0\.10\.0` \(exact, rootExact\)/);
});

test("every declared pin unused fails once per distinct value, naming the declaring fields", () => {
  const result = evaluate({
    // A marker-exempt ref keeps found > 0, so the blind-gate failure stays out
    // and this test isolates the stale semantics alone.
    files: [
      doc(
        "# Action Agents\n\nFirst release: `ecoma-io/action-agents/review@v0.1` <!-- historical ref -->\n",
      ),
    ],
    pins: PINS,
  });
  // exact and rootExact hold the same release, so two identical complaints
  // would be noise: one failure per distinct value, both fields named.
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0], /stale pin: `v0\.10` \(floating\)/);
  assert.match(result.failures[1], /stale pin: `v0\.10\.0` \(exact, rootExact\)/);
});

test("a sha-shaped ref needs no manifest entry and is counted as exempt", () => {
  const result = evaluate({
    files: [
      doc(
        "| `<sha>` (SHA-pinned) | `ecoma-io/action-agents/review@abc123` |\n" +
          "Or a full one: `ecoma-io/action-agents/review@85fae6b341bcfd3a0ede03fdf3db6e3f27c3b8c1`\n" +
          "And the floating line everyone copies: `ecoma-io/action-agents/review@v0.10`\n" +
          "Or the exact release: `ecoma-io/action-agents/review@v0.10.0`\n",
      ),
    ],
    pins: PINS,
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.shaExempt, 2);
  assert.equal(result.checked, 2);
});

test("a line carrying the historical-ref marker is exempt and counted", () => {
  const result = evaluate({
    files: [
      doc(
        "The first release: `ecoma-io/action-agents/review@v0.1` <!-- historical ref -->\n" +
          "The current line: `ecoma-io/action-agents/review@v0.10`\n" +
          "Or exactly that: `ecoma-io/action-agents/review@v0.10.0`\n",
      ),
    ],
    pins: PINS,
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.markerExempt, 1);
});

test("a ref shape the gate does not parse is reported, not ignored", () => {
  const result = evaluate({
    files: [doc("Never ship this: `ecoma-io/action-agents/review@main`\n")],
    pins: PINS,
  });
  // The shape failure stands beside the stale-pin failures: nothing in this
  // document uses the declared pins either, and both facts are reported.
  assert.equal(result.failures.length, 3);
  assert.match(result.failures[0], /review@main — a ref shape this gate does not parse/);
});

test("finding no pins at all is a failure, not a pass", () => {
  const result = evaluate({
    files: [doc("# Action Agents\n\nNothing here pins anything.\n")],
    pins: PINS,
  });
  assert.equal(result.failures.length, 3); // two distinct stale pins plus the blind-gate failure
  assert.match(result.failures[2], /no `ecoma-io\/action-agents/);
});

test("a manifest whose fields disagree on the minor line fails", () => {
  const result = evaluate({
    files: [doc("Everything the manifest asks for: `review@v0.9`, `review@v0.10.0`, `@v0.10.0`\n")],
    pins: { floating: "v0.9", exact: "v0.10.0", rootExact: "v0.10.0" },
  });
  const invariant = result.failures.find((failure) =>
    failure.includes("disagree on the minor line"),
  );
  assert.ok(invariant, "expected a minor-line invariant failure");
  assert.match(invariant, /v0\.9/);
});

test("parseManifest rejects malformed JSON, wrong shapes and missing fields", () => {
  assert.throws(() => parseManifest("{not json"), /not valid JSON/);
  assert.throws(() => parseManifest('{"floating": "v0.10"}'), /'exact' must be/);
  assert.throws(
    () => parseManifest('{"floating": "v0.10", "exact": "v1", "rootExact": "v0.10.0"}'),
    /'exact' must be/,
  );
  assert.throws(
    () => parseManifest('{"floating": "latest", "exact": "v0.10.0", "rootExact": "v0.10.0"}'),
    /'floating' must be/,
  );
  assert.throws(
    () => parseManifest('{"floating": "", "exact": "v0.10.0", "rootExact": "v0.10.0"}'),
    /non-empty/,
  );
  const pins = parseManifest('{"floating": "v0.10", "exact": "v0.10.0", "rootExact": "v0.10.0"}');
  assert.deepEqual(pins, PINS);
});

test("the ref pattern captures the action segment as optional and the ref greedily", () => {
  const bare = [..."uses: ecoma-io/action-agents@v0.10.0".matchAll(REF)];
  assert.equal(bare.length, 1);
  assert.equal(bare[0]?.[1], undefined);
  assert.equal(bare[0]?.[2], "v0.10.0");
  const child = [..."uses: ecoma-io/action-agents/harmonise@v0.10".matchAll(REF)];
  assert.equal(child[0]?.[1], "harmonise");
  assert.equal(child[0]?.[2], "v0.10");
});

test("the covered list is the #346 surface, pinned so coverage cannot shrink silently", () => {
  assert.deepEqual(DOC_PATHS, [
    "README.md",
    "README.vi.md",
    "docs/guides/getting-started.md",
    "docs/guides/review.md",
    "docs/guides/triage.md",
  ]);
});
