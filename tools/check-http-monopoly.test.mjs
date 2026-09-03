// Tests for check-http-monopoly (I2).
//
// Pure evaluate() cases; the canary fixture is judged by pointing the gate at
// tools/fixtures/http-monopoly.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluate,
  importSpecifiers,
  isScannedPath,
  isTransportPath,
} from "./check-http-monopoly.mjs";
import { maskCode } from "./code-scan.mjs";

test("a fetch outside the transport seam is a violation at file:line", () => {
  const src = [
    "// a comment-named fetch is not a call",
    "export function bad() {",
    '  return fetch("https://api.github.com/x");',
    "}",
  ].join("\n");
  const result = evaluate({ modules: [{ path: "triage/src/bad.mjs", source: src }] });
  assert.match(
    result.failures[0],
    /^triage\/src\/bad\.mjs:3: raw HTTP "fetch" outside core\/transport\/ \(invariant I2\)$/,
  );
});

test("a comment-named fetch is not a call — masking keeps it out", () => {
  const result = evaluate({
    modules: [{ path: "triage/src/clean.mjs", source: "// fetch( soon\nconst ok = 1;" }],
  });
  assert.deepEqual(result.failures, []);
});

test("the transport seam itself is the allowed zone", () => {
  const result = evaluate({
    modules: [
      {
        path: "core/transport/http.mjs",
        source: "export function request(url, init) { return fetch(url, init); }",
      },
    ],
  });
  assert.deepEqual(result.failures, []);
});

test("fetchImpl and prefetch are not the global and are not violations", () => {
  const result = evaluate({
    modules: [
      {
        path: "triage/src/prefixed.mjs",
        source: 'const fetchImpl = async () => 1;\nconst pre = prefetch("u");',
      },
    ],
  });
  assert.deepEqual(result.failures, []);
});

test("new Headers outside the seam is a violation, at file:line", () => {
  const result = evaluate({
    modules: [
      {
        path: "triage/src/h.mjs",
        source: 'export const build = () => new Headers({ accept: "application/json" });',
      },
    ],
  });
  assert.match(
    result.failures[0],
    /^triage\/src\/h\.mjs:1: raw HTTP "new Headers" outside core\/transport\/ \(invariant I2\)$/,
  );
});

test("no production module may import a test module", () => {
  const result = evaluate({
    modules: [{ path: "triage/src/helper.mjs", source: 'import { ok } from "./stub.test.mjs";' }],
  });
  assert.match(
    result.failures[0],
    /imports test module "\.\/stub\.test\.mjs" — test modules are not importable production surface \(invariant I2\)$/,
  );
});

test("subpath specifiers naming a test module are flagged by suffix", () => {
  const result = evaluate({
    modules: [{ path: "core/src/sub.mjs", source: 'import { ok } from "#core/x.test.mjs";' }],
  });
  assert.equal(result.failures.length, 1);
});

test("dynamic import with a literal resolves; computed fails closed", () => {
  const ok = evaluate({
    modules: [
      {
        path: "triage/src/dyn-ok.mjs",
        source: 'const m = await import("./b.mjs");',
      },
    ],
  });
  assert.deepEqual(ok.failures, []);
  assert.equal(ok.edges, 1);

  const bad = evaluate({
    modules: [
      {
        path: "triage/src/dyn-bad.mjs",
        source: 'const name = "./b.mjs"; const m = await import(name);',
      },
    ],
  });
  assert.equal(bad.failures.length, 1);
});

test("path helpers draw the boundary as the invariant names it", () => {
  assert.equal(isTransportPath("core/transport/http.mjs"), true);
  assert.equal(isTransportPath("core/src/http.mjs"), false);
  assert.equal(isTransportPath("triage/src/x.mjs"), false);
  assert.equal(isScannedPath("core/src/x.mjs"), true);
  assert.equal(isScannedPath("tools/x.mjs"), false);
  assert.equal(isScannedPath("core/transport/x.mjs"), true);
});

test("importSpecifiers reads static, side-effect and dynamic edges", () => {
  const src = [
    'import { ok } from "./a.mjs";',
    'import "./b.mjs";',
    'export { a } from "./c.mjs";',
    'const m = await import("./d.mjs");',
  ].join("\n");
  const specifiers = importSpecifiers(src, maskCode(src));
  assert.deepEqual(
    specifiers.map((s) => s.raw),
    ["./a.mjs", "./b.mjs", "./c.mjs", "./d.mjs"],
  );
});
