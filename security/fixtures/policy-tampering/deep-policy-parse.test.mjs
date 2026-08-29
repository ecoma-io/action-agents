// Deep JSON5 within the policy byte cap — the `policy-tampering` surface.
//
// The policy parser (`core/src/json5-parse.mjs`) is an iterative state
// machine with no internal recursion and no depth cap: the claim is that
// extreme nesting cannot stack-overflow the process, and that a document
// truncated mid-structure fails with a typed parse refusal rather than a
// hang or unbounded memory. This fixture proves the claim in practice at
// the byte cap that bounds a real policy read.
//
// The security property pinned is boundedness of the parse across the
// nesting extremes the byte cap admits:
//
//   - a deepest VALID nested array inside `MAX_CONFIG_BYTES` parses cleanly
//     and returns the exact nested structure (iterative, no stack overflow);
//   - a deeply nested VALID config object under the cap is accepted by the
//     config loader (so the whole read path stays iterative too);
//   - an UNTERMINATED deep document (open brackets at EOF) is refused with a
//     SyntaxError — a typed parse refusal, no hang, no runaway memory;
//   - an unterminated block comment is refused with a SyntaxError.
//
// No timing asserts: completion is the boundedness witness. Deterministic and
// offline.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_CONFIG_BYTES, loadConfigFile } from "#core/config-file.mjs";
import { json5Parse } from "#core/json5-parse.mjs";
import { policyReader, resolvePolicySource } from "#core/policy.mjs";

const LIVE_SHA = "a".repeat(40);
const CONFIG_PATH = ".github/action-agents/triage/triage.json5";
const BRANCH = "main";

/**
 * A deepest VALID nested array within the byte cap: `[[[…0…]]]`, two bytes
 * per level. 32000 levels occupies 64001 bytes, under `MAX_CONFIG_BYTES`.
 */
const DEPTH = 32000;
const DEEP_VALID = "[".repeat(DEPTH) + "0" + "]".repeat(DEPTH);
/** The same open brackets, truncated at EOF — the unterminated-deep attack. */
const DEEP_UNTERMINATED = "[".repeat(DEPTH);

/**
 * Resolves the policy source for a pull_request run (live tip) and returns a
 * `loadConfigFile`-shaped call for the given `content` at CONFIG_PATH.
 *
 * @param {string} content
 * @returns {Promise<ReturnType<typeof loadConfigFile>>}
 */
async function loadPolicy(content) {
  const forge = /** @type {any} */ ({
    async getRepository() {
      return { defaultBranch: BRANCH, name: "action-agents", description: "" };
    },
    async getRef(_branch) {
      return { sha: LIVE_SHA };
    },
    async getContents(path, _options) {
      if (path !== CONFIG_PATH) return null;
      return { content };
    },
  });
  const source = await resolvePolicySource({
    eventName: "pull_request",
    event: { pull_request: { base: { ref: BRANCH, sha: "b".repeat(40) } } },
    forge,
  });
  const policy = { getContents: policyReader(forge, source) };
  return loadConfigFile({
    forge: policy,
    configPath: CONFIG_PATH,
    source,
    locations: [],
    supportedMajor: 1,
  });
}

describe("deep JSON5 within the byte cap stays bounded", () => {
  it("an extreme-depth valid array at the byte cap parses cleanly and correctly", () => {
    assert.ok(
      new TextEncoder().encode(DEEP_VALID).byteLength <= MAX_CONFIG_BYTES,
      "the fixture must be inside the policy byte cap",
    );
    const parsed = json5Parse(DEEP_VALID);
    // Walk the single-element chain down `DEPTH` levels to the leaf.
    let node = parsed;
    for (let i = 0; i < DEPTH; i += 1) {
      assert.ok(Array.isArray(node), "expected an array at every nesting level");
      assert.ok(node.length === 1, "expected exactly one element per level");
      node = node[0];
    }
    assert.equal(node, 0, "the innermost value must be the literal 0");
  });

  it("a deeply nested valid config object is accepted through the config loader", async () => {
    // An object whose single value is the deep array — the config read path
    // (cap + parse + object-shape check + schema check) stays iterative.
    const content = `{"deep": ${DEEP_VALID}}`;
    assert.ok(
      new TextEncoder().encode(content).byteLength <= MAX_CONFIG_BYTES,
      "the fixture must be inside the policy byte cap",
    );
    const loaded = await loadPolicy(content);
    assert.equal(loaded.path, CONFIG_PATH);
    assert.ok(Array.isArray(loaded.raw?.deep), "the deep value must survive as a nested array");
  });

  it("an unterminated deep document at EOF is a typed parse refusal, no hang", () => {
    assert.ok(
      new TextEncoder().encode(DEEP_UNTERMINATED).byteLength <= MAX_CONFIG_BYTES,
      "the fixture must be inside the policy byte cap",
    );
    const error = /** @type {unknown} */ (
      () => {
        try {
          json5Parse(DEEP_UNTERMINATED);
          assert.fail("expected a parse refusal");
        } catch (cause) {
          return cause;
        }
      }
    )();
    assert.ok(error instanceof SyntaxError, "expected a typed SyntaxError");
    assert.match(String(error instanceof Error ? error.message : error), /invalid end of input/);
  });

  it("an unterminated block comment at EOF is a typed parse refusal", () => {
    const error = /** @type {unknown} */ (
      () => {
        try {
          json5Parse("{ /* never closed");
          assert.fail("expected a parse refusal");
        } catch (cause) {
          return cause;
        }
      }
    )();
    assert.ok(error instanceof SyntaxError, "expected a typed SyntaxError");
    assert.match(String(error instanceof Error ? error.message : error), /invalid end of input/);
  });
});

describe("the config loader wraps a deep truncation as a bounded refusal", () => {
  it("refuses an unterminated deep document with the parse error, not a hang or a success", async () => {
    const error = await loadPolicy(DEEP_UNTERMINATED).then(
      () => assert.fail("expected a refusal"),
      (e) => e,
    );
    // The load layer wraps the SyntaxError: the boundedness is that a
    // truncated document can never be mistaken for a valid policy.
    assert.ok(error instanceof Error, "expected a refusal");
    assert.notEqual(error, undefined);
  });
});
