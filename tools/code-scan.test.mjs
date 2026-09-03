// Tests for code-scan.mjs.
//
// maskCode and lineOf are pure, so these run with no filesystem. The cases
// are chosen around the two ways a lexical mask fails: masking something
// that IS code — hiding a violation from the gates that consume this module,
// the dangerous direction — and failing to mask something that is NOT code —
// reporting a violation nobody committed, the noisy direction. Each test
// names the direction it guards.

import assert from "node:assert/strict";
import { test } from "node:test";

import { lineOf, maskCode } from "./code-scan.mjs";

// The backtick, kept out of this file's own source (house hygiene around
// nested templates in gate fixtures) and composed into fixture sources.
const BT = String.fromCharCode(96);

test("masking preserves length and the newline grid over a mixed fixture", () => {
  const src =
    [
      "// head comment naming fetch( with COMMENTTOKEN — masked",
      "const u = /^S1?:\\/\\//.test(raw);",
      "const real = total / 2;",
      "const q = 'it\\'s S2';",
      "const m = " + BT + "a ${fetch(x)} T3" + BT + " / 2;",
      "/* B4 block with fetch( inside */ const w = 1;",
    ].join("\n") + "\n";
  const masked = maskCode(src);

  assert.equal(masked.length, src.length);
  assert.equal(
    masked.split("\n").length,
    src.split("\n").length,
    "the newline grid is the coordinate contract; masking must not fold lines",
  );
  // Not-code text is blanked (the noisy direction).
  assert.ok(!masked.includes("COMMENTTOKEN"));
  assert.ok(!masked.includes("S1"));
  assert.ok(!masked.includes("S2"));
  assert.ok(!masked.includes("T3"));
  assert.ok(!masked.includes("B4"));
  // Code survives (the dangerous direction) — division stays division, and
  // the code after the regex on line 2 and after the template on line 5.
  assert.ok(masked.includes("total / 2"));
  assert.ok(masked.includes(".test(raw)"));
  assert.ok(masked.includes("/ 2;"));
  assert.ok(masked.includes("const w = 1;"));
});

test("a regex body containing two slashes does not swallow the line", () => {
  // The case the module exists for: read naively, the colon-slash-slash
  // inside the pattern looks like a line comment and everything after it is
  // lost — the exact line a violator would choose to hide code on.
  const src = "const u = /^S1?:\\/\\//.test(raw);";
  const masked = maskCode(src);
  assert.ok(!masked.includes("S1"));
  assert.ok(masked.includes(".test(raw)"));
});

test("a character class containing a slash does not close the regex early", () => {
  const src = "const p = /J1[/]K2/.test(s);";
  const masked = maskCode(src);
  assert.ok(!masked.includes("J1"));
  assert.ok(
    !masked.includes("K2"),
    "a slash inside a class closes regex state early when the class is ignored",
  );
  assert.ok(masked.includes(".test(s)"));
  assert.ok(masked.includes("const p ="));
});

test("division stays code and offsets stay aligned", () => {
  const src = "const real = total / 2;\nconst after = fetch(x);";
  const masked = maskCode(src);
  assert.ok(masked.includes("total / 2"));
  const idx = masked.indexOf("total");
  assert.equal(
    lineOf(masked, idx),
    1,
    "the coordinate contract: offsets into masked text are offsets into the source",
  );
});

test("comments and strings naming a fetch call are masked", () => {
  const src = [
    "// TODO: un-comment this fetch( call some day",
    'const q = "fetch(";',
    "const after = 1;",
  ].join("\n");
  const masked = maskCode(src);
  assert.ok(
    !masked.includes("fetch"),
    "noise direction: no violation is reported for a comment or a string",
  );
  assert.ok(masked.includes("const after = 1;"));
});

test("template-literal text is masked; interpolation code stays code", () => {
  const src = "const m = " + BT + 'url ${fetch("u")} TAIL' + BT + ";";
  const masked = maskCode(src);
  assert.ok(masked.includes("fetch"), "interpolation code is code");
  assert.ok(!masked.includes("TAIL"), "literal text is blanked");
  assert.ok(masked.includes("const m ="));
});

test("nested braces inside an interpolation stay inside the interpolation", () => {
  // The fetch call sits behind an object argument, so the scanner has to
  // hold the brace depth across the whole interpolation to keep the call
  // visible. Object keys are code here, so "deep" legitimately survives.
  const src = "const n = " + BT + "n ${obj({ deep: fetch(z) })} TAIL" + BT + ";";
  const masked = maskCode(src);
  assert.ok(masked.includes("fetch"));
  assert.ok(!masked.includes("TAIL"));
  assert.ok(masked.includes("deep"));
});

test("an escaped quote does not flip string state", () => {
  const src = "const q = 'it\\'s S2'; const after = 1;";
  const masked = maskCode(src);
  assert.ok(!masked.includes("S2"));
  assert.ok(masked.includes("const after = 1;"));
});

test("an unterminated string recovers at the newline", () => {
  const src = "const s = 'oops\nconst after = 2;";
  const masked = maskCode(src);
  assert.ok(masked.includes("const after = 2;"), "recovery guards the dangerous direction");
});

test("a regex after return is masked; code after it survives", () => {
  const src = "if (colon) { return /R1/.test(y); }";
  const mixed = maskCode(src);
  assert.ok(!mixed.includes("R1"));
  assert.ok(mixed.includes(".test(y)"));
});

test("lineOf counts newlines before the offset", () => {
  const text = "a\nb\nc";
  assert.equal(lineOf(text, 0), 1);
  assert.equal(lineOf(text, 2), 2);
  assert.equal(lineOf(text, 4), 3);
  assert.equal(lineOf(text, 99), 3);
});
