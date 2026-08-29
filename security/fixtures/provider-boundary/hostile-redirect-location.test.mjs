// Hostile redirect `Location` values — the provider-boundary surface.
//
// A `Location` header is server-chosen text, and the seam's promise is that a
// redirect can never carry a credential off the origin the caller configured:
// the client refuses before the next hop, or follows at most three hops, all
// same-origin. The security property this fixture pins is the bounded shape of
// that promise for the values a hostile provider actually sends:
//
//   - empty / whitespace Location   -> resolves onto the same URL; the hop
//     ceiling (3) fires, so the request never loops forever
//   - `javascript:` Location        -> a scheme with origin "null"; refused as
//     cross-origin before any follow-up fetch
//   - malformed Location            -> URL parsing fails; the request rejects
//     (a raw TypeError today, not a typed refusal — bounded but untyped,
//     flagged for hardening; asserting the security property, not the class)
//
// What must hold for every value: the request rejects (never resolves, never
// hangs), and every fetch that did happen stayed on the configured origin with
// the credential header still attached — a follow or a leak is the failure
// this test exists to catch.
//
// Deterministic and offline: the provider is a scripted fetch; no network,
// no model, no timers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHttpClient } from "#core-transport/http.mjs";

/**
 * A scripted provider that answers every request with the given `Location`
 * on a 302, recording each fetch that actually happened.
 *
 * @param {string} location
 * @returns {{ fetchImpl: typeof globalThis.fetch, calls: { url: string, host: string, auth: string | undefined }[] }}
 */
function hostileProvider(location) {
  /** @type {{ url: string, host: string, auth: string | undefined }[]} */
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url: String(url),
      host: new URL(String(url)).host,
      auth: /** @type {Record<string, string>} */ (init?.headers ?? {})["Authorization"],
    });
    return new Response(null, { status: 302, headers: { location } });
  };
  return { fetchImpl, calls };
}

describe("hostile redirect Location values stay bounded", () => {
  for (const location of ["", "   ", "javascript:alert(1)", "http://[::1", "https://"]) {
    it(`refuses or bounds a Location of ${JSON.stringify(location.slice(0, 12))}`, async () => {
      const { fetchImpl, calls } = hostileProvider(location);
      const http = createHttpClient({
        baseUrl: "https://api.example/v1",
        authorization: "Bearer sk-secret",
        fetchImpl,
        maxAttempts: 1,
      });

      const error = await http.request("/x").catch((cause) => cause);
      assert.ok(error instanceof Error, `expected a rejection for ${JSON.stringify(location)}`);

      // The hop ceiling keeps an empty Location from looping: at most the
      // original plus three same-URL hops.
      assert.ok(calls.length <= 4, `expected at most 4 fetch calls, saw ${calls.length}`);
      // Every fetch that happened stayed on the configured origin.
      for (const call of calls) {
        assert.equal(call.host, "api.example", "a fetch left the configured origin");
        assert.equal(call.auth, "Bearer sk-secret", "the credential left the configured origin");
      }
    });
  }
});
