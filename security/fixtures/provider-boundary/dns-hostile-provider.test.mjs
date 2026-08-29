// DNS-rebinding attempts via absolute URLs — the provider-boundary surface.
//
// A hostile provider whose address re-resolves mid-session tries to point the
// client at a different host — a rebinding target an attacker now controls —
// by sending an absolute URL where the client would otherwise stay on the
// configured origin. The seam's promise is that the origin is fixed once
// from the configured `baseUrl`, and nothing a provider sends can move the
// request off it: a redirect `Location` to a foreign host is refused as the
// typed `CrossOriginRedirectError` before any follow-up fetch, and so is an
// absolute-URL `path` (the shape a hostile pagination `Link` would arrive as).
//
// What must hold: the request rejects with the typed `CrossOriginRedirectError`
// (a documented contract), and *every fetch that actually happened* stayed on
// the pinned origin `api.example` with the credential header attached — a
// single request to the rebinding host is the failure this fixture exists to
// catch.
//
// Deterministic and offline: the provider is a scripted fetch; no network, no
// model. This pins the origin-fixing angle the seed fixture's redirect
// `Location`-parsing cases do not: here every hostile value is a *complete,
// well-formed absolute URL to a different host*, and the assertion is that no
// such host was ever contacted, not that the Location strings were refused.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHttpClient } from "#core-transport/http.mjs";
import { CrossOriginRedirectError } from "#core-transport/transport-errors.mjs";

const PINNED_HOST = "api.example";
const REBIND_HOST = "evil.invalid";

/**
 * A scripted provider that answers every request with a 302 whose Location is
 * `location` (or that answers an absolute-URL path directly), recording each
 * fetch that actually happened.
 *
 * @param {string} location
 * @returns {{ fetchImpl: typeof globalThis.fetch, hosts: () => string[], auths: () => (string | undefined)[] }}
 */
function rebindingProvider(location) {
  /** @type {string[]} */
  const hosts = [];
  /** @type {(string | undefined)[]} */
  const auths = [];
  const fetchImpl = /** @type {typeof globalThis.fetch} */ (
    async (url, init) => {
      hosts.push(new URL(String(url)).host);
      auths.push(/** @type {Record<string, string>} */ (init?.headers ?? {})["Authorization"]);
      return new Response(null, { status: 302, headers: { location } });
    }
  );
  return {
    fetchImpl,
    hosts: () => hosts,
    auths: () => auths,
  };
}

/** A client pinned to the configured origin, with no retries to confuse the count. */
function pinnedClient(fetchImpl) {
  return createHttpClient({
    baseUrl: `https://${PINNED_HOST}/v1`,
    authorization: "Bearer sk-secret",
    fetchImpl,
    maxAttempts: 1,
    timeoutMs: 5_000,
  });
}

/** Asserts every recorded fetch stayed on the pinned origin with the credential. */
function assertStayedPinned(hosts, auths) {
  for (const host of hosts) {
    assert.equal(host, PINNED_HOST, "a fetch left the pinned origin");
  }
  for (const auth of auths) {
    assert.equal(auth, "Bearer sk-secret", "the credential left the pinned origin");
  }
}

describe("a provider cannot rebind the client to another host via absolute URLs", () => {
  it("an absolute off-origin redirect Location is refused, and the rebinding host is never contacted", async () => {
    const { fetchImpl, hosts, auths } = rebindingProvider(`https://${REBIND_HOST}/steal`);
    const http = pinnedClient(fetchImpl);
    const error = await http.request("/chat/completions").catch((cause) => cause);
    assert.ok(
      error instanceof CrossOriginRedirectError,
      "expected a typed refusal on an off-origin redirect",
    );
    assert.equal(
      error.configuredOrigin,
      `https://${PINNED_HOST}`,
      "the refusal names the configured origin",
    );
    // The one fetch that happened was the original on the pinned origin —
    // the redirect to the rebinding host was refused before any follow-up.
    assert.deepEqual(hosts(), [PINNED_HOST]);
    assertStayedPinned(hosts(), auths());
  });

  it("an absolute-URL path to a foreign host is refused before any fetch to it", async () => {
    // The pagination/`Link` shape: the caller is handed an absolute URL to a
    // host the provider now resolves to. Its origin differs from the pinned
    // one, so the client refuses before opening a connection.
    const { fetchImpl, hosts } = rebindingProvider(`https://${PINNED_HOST}/harmless`);
    const http = createHttpClient({
      baseUrl: `https://${PINNED_HOST}/v1`,
      authorization: "Bearer sk-secret",
      fetchImpl,
      maxAttempts: 1,
      timeoutMs: 5_000,
    });
    const error = await http
      .request(`https://${REBIND_HOST}/chat/completions`)
      .catch((cause) => cause);
    assert.ok(
      error instanceof CrossOriginRedirectError,
      "expected a typed refusal on an absolute-URL path off the pinned origin",
    );
    // No fetch at all happened: the origin check fired before any connection.
    assert.deepEqual(hosts(), []);
  });

  it("a same-origin absolute-URL path is followed and stays pinned, credential intact", async () => {
    // The legitimate pagination case: an absolute URL to the *same* origin is
    // allowed — proof the origin check is precise, not a blanket rejection of
    // absolute URLs. All fetches stay on the pinned host with the credential.
    /** @type {string[]} */
    const hosts = [];
    /** @type {(string | undefined)[]} */
    const auths = [];
    const fetchImpl = /** @type {typeof globalThis.fetch} */ (
      async (url, init) => {
        hosts.push(new URL(String(url)).host);
        auths.push(/** @type {Record<string, string>} */ (init?.headers ?? {})["Authorization"]);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    );
    const http = createHttpClient({
      baseUrl: `https://${PINNED_HOST}/v1`,
      authorization: "Bearer sk-secret",
      fetchImpl,
      maxAttempts: 1,
      timeoutMs: 5_000,
    });
    const response = await http.request(`https://${PINNED_HOST}/v1/chat/completions`);
    assert.equal(response.status, 200, "the same-origin absolute request should succeed");
    assertStayedPinned(hosts, auths);
    assert.deepEqual(hosts, [PINNED_HOST]);
  });
});
