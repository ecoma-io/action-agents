// Tests for check-forge-monopoly (I3).
//
// Pure evaluate() cases plus one golden case that pins the extractor against
// the real forge and the frozen manifest.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { maskCode } from "./code-scan.mjs";
import { evaluate, extractForgeOps, methodLiteral } from "./check-forge-monopoly.mjs";
const MINI_FORGE = `export function createForge(config) {
  const http = config.http;
  return {
    async whoami() {
      return http.request("/user");
    },
    async createComment(number, body) {
      return http.request("/issues/" + number + "/comments", {
        method: "POST",
        body,
      });
    },
  };
}
`;

test("a non-GET verb outside the allowed positions is a violation", () => {
  const result = evaluate({
    modules: [
      {
        path: "triage/src/index.mjs",
        source: 'const run = (http) => http.request("/labels", { method: "POST" });',
      },
    ],
    forgeSource: MINI_FORGE,
    manifest: { invariant: "I3", ops: ["whoami", "createComment"] },
  });
  assert.match(
    result.failures[0],
    /^triage\/src\/index\.mjs:1: non-GET verb "POST" outside the forge, chat or transport \(invariant I3\)$/,
  );
});

test("verbs in the forge, in chat and in transport are allowed", () => {
  const result = evaluate({
    modules: [
      { path: "core/src/forge.mjs", source: 'const write = { method: "POST" };' },
      { path: "core/src/chat.mjs", source: 'const send = { method: "POST" };' },
      { path: "core/transport/http.mjs", source: 'const send = { method: "PUT" };' },
    ],
    forgeSource: MINI_FORGE,
    manifest: { invariant: "I3", ops: ["whoami", "createComment"] },
  });
  assert.deepEqual(result.failures, []);
});

test("GET is not a write, and a lowercase verb is judged on the wire", () => {
  const result = evaluate({
    modules: [
      { path: "triage/src/g.mjs", source: 'const ok = { method: "GET" };' },
      { path: "triage/src/l.mjs", source: 'const sneaky = { method: "post" };' },
    ],
    forgeSource: MINI_FORGE,
    manifest: { invariant: "I3", ops: ["whoami", "createComment"] },
  });
  assert.match(
    result.failures[0],
    /non-GET verb "post" outside the forge, chat or transport \(invariant I3\)$/,
  );
});

test("a computed method is refused, not guessed", () => {
  const result = evaluate({
    modules: [
      {
        path: "triage/src/c.mjs",
        source: "const verb = someVerb();\nconst call = { method: verb };",
      },
    ],
    forgeSource: MINI_FORGE,
    manifest: { invariant: "I3", ops: ["whoami", "createComment"] },
  });
  assert.match(
    result.failures[0],
    /HTTP method is computed, not a literal the gate can read \(invariant I3\)$/,
  );
});

test("a comment-named verb is masked out", () => {
  const result = evaluate({
    modules: [{ path: "triage/src/m.mjs", source: '// method: "POST" — prose, not a write' }],
    forgeSource: MINI_FORGE,
    manifest: { invariant: "I3", ops: ["whoami", "createComment"] },
  });
  assert.deepEqual(result.failures, []);
});

test("the verb scan skips test modules, narrowly and deliberately", () => {
  const result = evaluate({
    modules: [
      {
        path: "core/src/forge.test.mjs",
        source: 'expect(call).toMatchObject({ method: "DELETE" });',
      },
    ],
    forgeSource: MINI_FORGE,
    manifest: { invariant: "I3", ops: ["whoami", "createComment"] },
  });
  assert.deepEqual(result.failures, []);
});

test("the manifest is diffed in both directions and on order", () => {
  const modules = [];
  const verdict = (manifest) => evaluate({ modules, forgeSource: MINI_FORGE, manifest }).failures;
  const missing = verdict({ invariant: "I3", ops: ["whoami"] });
  const stale = verdict({ invariant: "I3", ops: ["whoami", "createComment", "noSuchOp"] });
  assert.match(
    missing[0],
    /forge op "createComment" is not declared in security\/forge-ops\.json \(invariant I3\)$/,
  );
  assert.match(
    stale[0],
    /manifest names op "noSuchOp" the forge surface does not have \(invariant I3\)$/,
  );

  const reordered = verdict({ invariant: "I3", ops: ["createComment", "whoami"] });
  assert.match(reordered[0], /disagree on declaration order \(invariant I3\)$/);
});

test("a malformed manifest fails closed", () => {
  const verdict = (manifest) =>
    evaluate({ modules: [], forgeSource: MINI_FORGE, manifest }).failures;
  assert.match(verdict(null)[0], /manifest is not a JSON object/);
  assert.match(verdict({ invariant: "I9" })[0], /"invariant" is not "I3"/);
  assert.match(
    verdict({ invariant: "I3", ops: ["whoami", 7] })[0],
    /"ops" is not a list of op names/,
  );
  assert.match(
    verdict({ invariant: "I3", ops: ["whoami", "whoami"] })[0],
    /"ops" contains duplicates/,
  );
});

test("an unreadable forge return object fails closed", () => {
  const result = evaluate({
    modules: [],
    forgeSource: "export function createForge(config) { return null; }",
    manifest: { invariant: "I3", ops: ["whoami", "createComment"] },
  });
  assert.match(result.failures[0], /createForge's return object could not be read/);
});

test("methodLiteral reads the verb after a method key", () => {
  const src = "const call = { method: 'PATCH' };";
  const masked = maskCode(src);
  const key = /method\s*:/g;
  const m = key.exec(masked);
  assert.equal(methodLiteral(src, masked, m.index + m[0].length), "PATCH");
  assert.equal(methodLiteral(src, masked, 0), null);
});

test("extractForgeOps reads a miniature return object in order", () => {
  assert.deepEqual(extractForgeOps(MINI_FORGE), ["whoami", "createComment"]);
});

test("GOLDEN: the real forge surface equals the frozen manifest", () => {
  const forgeSource = readFileSync(new URL("../core/src/forge.mjs", import.meta.url), "utf8");
  const manifest = JSON.parse(
    readFileSync(new URL("../security/forge-ops.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(extractForgeOps(forgeSource), manifest.ops);
  assert.equal(manifest.ops.length, 26);
});
