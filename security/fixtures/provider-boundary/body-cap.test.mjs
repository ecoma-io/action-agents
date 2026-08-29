// Body cap mid-stream — the provider-boundary surface.
//
// A hostile provider streams a /chat/completions-style response whose body
// grows unbounded — no honest `content-length`, an endless chunk stream. The
// seam's promise is that a body is capped while it is being read, never
// buffered whole into memory first: both a declared `content-length` over the
// cap and a stream that crosses the cap mid-read are refused with the typed
// `BodyTooLargeError` before the giant body is assembled. A body exactly at
// the cap boundary still succeeds.
//
// What must hold: the request rejects with the *typed* `BodyTooLargeError`
// (a documented contract — the caller must be able to tell "too big" apart
// from a network failure), the oversized bytes are never returned as a usable
// response, and the boundary value is accepted.
//
// Deterministic and offline: the provider is a scripted fetch; the cap is
// tiny so the streamed body is a handful of bytes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHttpClient } from "#core-transport/http.mjs";
import { BodyTooLargeError } from "#core-transport/transport-errors.mjs";

const CAP = 64;

/**
 * A scripted provider that streams `payload` as a chat-completions-style
 * body, letting `materialise` read it chunk by chunk.
 *
 * @param {string} payload
 * @returns {{ fetchImpl: typeof globalThis.fetch }}
 */
function bodyProvider(payload) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  const fetchImpl = /** @type {typeof globalThis.fetch} */ (
    async () => {
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
  );
  return { fetchImpl };
}

/** A client whose per-request body cap defaults to the tiny corpus constant. */
function cappedClient(fetchImpl) {
  return createHttpClient({
    baseUrl: "https://api.example/v1",
    authorization: "Bearer sk-secret",
    fetchImpl,
    timeoutMs: 5_000,
    maxBodyBytes: CAP,
  });
}

describe("a body past the cap is refused mid-stream, never buffered whole", () => {
  it("a stream that crosses the cap mid-read rejects with the typed BodyTooLargeError", async () => {
    const over = "x".repeat(CAP + 1);
    const { fetchImpl } = bodyProvider(over);
    const http = cappedClient(fetchImpl);
    const error = await http.request("/chat/completions").catch((cause) => cause);
    assert.ok(
      error instanceof BodyTooLargeError,
      "expected the typed body-cap refusal, got a different settlement",
    );
    // The cap applied: the refusal message carries the byte ceiling, so a
    // call site can tell "too big" apart from a network failure.
    assert.match(error.message, /byte cap/);
  });

  it("a declared content-length over the cap is refused before any body is buffered", async () => {
    // The provider lies in its `content-length` while the real stream is
    // small. `materialise` checks the declared length first, before reading
    // any body, so the refusal fires without buffering — the declared check
    // is what a hostile `content-length` hits.
    const lyingFetch = /** @type {typeof globalThis.fetch} */ (
      async () => {
        return new Response("x".repeat(8), {
          status: 200,
          headers: { "content-type": "application/json", "content-length": String(CAP + 500) },
        });
      }
    );
    const http = createHttpClient({
      baseUrl: "https://api.example/v1",
      fetchImpl: lyingFetch,
      timeoutMs: 5_000,
      maxBodyBytes: CAP,
    });
    const error = await http.request("/chat/completions").catch((cause) => cause);
    assert.ok(
      error instanceof BodyTooLargeError,
      "expected a typed refusal on the declared length",
    );
  });

  it("a body exactly at the cap boundary is accepted, not refused", async () => {
    // Exactly CAP bytes of JSON — the boundary. A cap that lets equality
    // fall through and rejects strict overflow would behave correctly, but
    // the contract is that `> cap` refuses while `<= cap` succeeds; pin the
    // boundary so a cap bug in the comparator cannot hide.
    const exact = JSON.stringify({ ok: true, pad: "y".repeat(CAP - 20) });
    assert.ok(exact.length <= CAP, "test setup: exact body must fit the cap");
    const { fetchImpl } = bodyProvider(exact);
    const http = cappedClient(fetchImpl);
    const response = await http.request("/chat/completions");
    assert.equal(response.status, 200, "a boundary body should be accepted");
    assert.equal(response.text, exact, "the boundary body should come back intact");
  });
});
