// Policy schema-version ladder — the `policy-tampering` surface.
//
// A policy file is attacker-adjacent: a config checked into a repo tree, or
// carried by a pull request's upstream, could have its `schemaVersion`
// tampered with. The enforced invariant is a typed startup refusal for any
// value the running action does not understand — a future major, a string,
// a fraction — each naming the exact branch, sha and path it was read from,
// before any model call or mutation. An absent version equals the current
// major, so pre-versioning policy files keep working untouched.
//
// The security property this fixture pins is the bounded shape of that
// refusal: the message always names branch + sha + path (so the authority a
// human audits is unambiguous), and a supported version is accepted. The
// real `loadConfigFile` + `resolvePolicySource` are driven; only the forge's
// reading half is faked.
//
// Deterministic and offline: no network, no model, no timers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfigFile } from "#core/config-file.mjs";
import { PolicyResolutionError, policyReader, resolvePolicySource } from "#core/policy.mjs";

/** A full 40-hex commit sha — the live tip the fake forge reports. */
const LIVE_SHA = "a".repeat(40);
/** The payload's creation-time base sha — never the pin, never accepted here. */
const STALE_SHA = "b".repeat(40);
const CONFIG_PATH = ".github/action-agents/triage/triage.json5";
const BRANCH = "main";

/**
 * A forge double for the reading half: `getRef` reports the live tip and
 * `getContents` answers the one policy file. Recorded so a test could assert
 * which sha the content was read from.
 *
 * @returns {import("#core/policy.mjs").PolicyForge & { contents: { path: string, ref: string | undefined }[] }}
 */
function readingForge(content) {
  /** @type {{ path: string, ref: string | undefined }[]} */
  const contents = [];
  return /** @type {any} */ ({
    contents,
    async getRepository() {
      return { defaultBranch: BRANCH, name: "action-agents", description: "" };
    },
    async getRef(_branch) {
      return { sha: LIVE_SHA };
    },
    async getContents(path, options) {
      contents.push({ path, ref: options?.ref });
      // Serve the exact policy the test built — schemaVersion refusals must
      // observe it, not a placeholder.
      return path === CONFIG_PATH ? { content } : null;
    },
  });
}

/**
 * Presents the given policy `content` at CONFIG_PATH and resolves the policy
 * source the way the actions do — a pull_request run, base branch `main`.
 *
 * @param {string} content
 * @returns {Promise<ReturnType<typeof loadConfigFile>>}
 */
async function loadPolicy(content) {
  const forge = readingForge(content);
  const source = await resolvePolicySource({
    eventName: "pull_request",
    event: { pull_request: { base: { ref: BRANCH, sha: STALE_SHA } } },
    forge,
  });
  assert.equal(source.sha, LIVE_SHA, "the source must resolve to the live tip");
  const policy = { getContents: policyReader(forge, source) };
  return loadConfigFile({
    forge: policy,
    configPath: CONFIG_PATH,
    source,
    locations: [],
    supportedMajor: 1,
  });
}

/** A refusal from an unsupported schemaVersion must name all three authorities. */
function assertRefusedNamesAuthorities(error, path, branch, sha) {
  assert.ok(error instanceof PolicyResolutionError, "expected a PolicyResolutionError");
  assert.match(error.message, /schemaVersion/);
  assert.ok(error.message.includes(path), `refusal must name the path, got: ${error.message}`);
  assert.ok(error.message.includes(branch), `refusal must name the branch, got: ${error.message}`);
  assert.ok(error.message.includes(sha), `refusal must name the sha, got: ${error.message}`);
}

describe("tampered schemaVersion is refused, named by branch+sha+path", () => {
  it("a future schemaVersion 2 is refused before any model call", async () => {
    const error = await loadPolicy('{"schemaVersion": 2}').then(
      () => assert.fail("expected a refusal"),
      (e) => e,
    );
    assertRefusedNamesAuthorities(error, CONFIG_PATH, BRANCH, LIVE_SHA);
  });

  it('a string schemaVersion "1" is refused', async () => {
    const error = await loadPolicy('{"schemaVersion": "1"}').then(
      () => assert.fail("expected a refusal"),
      (e) => e,
    );
    assertRefusedNamesAuthorities(error, CONFIG_PATH, BRANCH, LIVE_SHA);
  });

  it("a float schemaVersion 1.5 is refused", async () => {
    const error = await loadPolicy('{"schemaVersion": 1.5}').then(
      () => assert.fail("expected a refusal"),
      (e) => e,
    );
    assertRefusedNamesAuthorities(error, CONFIG_PATH, BRANCH, LIVE_SHA);
  });

  it('a string float schemaVersion "1.0" is refused', async () => {
    const error = await loadPolicy('{"schemaVersion": "1.0"}').then(
      () => assert.fail("expected a refusal"),
      (e) => e,
    );
    assertRefusedNamesAuthorities(error, CONFIG_PATH, BRANCH, LIVE_SHA);
  });

  it("an integer schemaVersion 1 on a valid config is accepted", async () => {
    const loaded = await loadPolicy('{"schemaVersion": 1, "labels": {}}');
    assert.equal(loaded.path, CONFIG_PATH);
    assert.equal(loaded.raw?.schemaVersion, 1);
  });

  it("an absent schemaVersion is accepted as the current major", async () => {
    const loaded = await loadPolicy('{"labels":{}}');
    assert.equal(loaded.path, CONFIG_PATH);
    assert.equal(loaded.raw?.schemaVersion, undefined);
  });
});
