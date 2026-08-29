// Retry-After variants — the provider-boundary surface.
//
// A hostile provider answers a chat-completions request with HTTP 429 and a
// `Retry-After` header shaped to stall the caller: absurd integers, garbage
// text, RFC 1123 dates, or nothing at all. The seam's promise is that no
// Retry-After value can turn one retry into an unbounded wait — every value
// resolves to a bounded backoff (`maxRetryAfterMs` clamps the numeric path,
// the retry-delay backoff covers everything else), and once the client's own
// attempt ceiling is exhausted the failure surfaces as the typed `HttpError`,
// not an open-ended loop.
//
// What must hold for every variant: the caller's `request()` promise settles
// (resolves with the retried success, or rejects with a typed error when the
// attempts are gone), in bounded time, after exactly the expected number of
// fetches — a Retry-After that stretches the wait, or a 429 that retries past
// the ceiling, is the failure this fixture exists to catch.
//
// Deterministic and offline: the provider is a scripted fetch, and the caps
// are tiny so the real waits stay in the single-digit milliseconds — far under
// the internet-scale values a real provider could send.
//
// Timing note: `node:test` runs here, so there are no fake timers — the
// backoff sleeps are real but bounded by the tiny `maxRetryAfterMs` /
// `retryDelayMs` the client got. Elapsed assertions are deliberately generous
// (hard upper bounds, loose lower bounds) because they exist only to prove a
// cap was applied, never to measure timing precisely.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHttpClient } from "#core-transport/http.mjs";
import { HttpError } from "#core-transport/transport-errors.mjs";

/**
 * A scripted provider: the first `failures` responses are HTTP 429 (each with
 * the given `retryAfter` header value, or none), then the request succeeds.
 * Records how many fetches actually happened and the cumulative wait.
 *
 * @param {number} failures
 * @param {string | undefined} retryAfter
 * @returns {{ fetchImpl: typeof globalThis.fetch, calls: () => number }}
 */
function retryThenOk(failures, retryAfter) {
  let calls = 0;
  const fetchImpl = /** @type {typeof globalThis.fetch} */ (
    async () => {
      calls += 1;
      if (calls <= failures) {
        const headers = retryAfter === undefined ? {} : { "retry-after": retryAfter };
        return new Response("too many requests", {
          status: 429,
          headers: { "content-type": "text/plain", ...headers },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
  );
  return { fetchImpl, calls: () => calls };
}

/** A client too small to ever exceed — every delay under a frame. */
function fastClient(fetchImpl) {
  return createHttpClient({
    baseUrl: "https://api.example/v1",
    authorization: "Bearer sk-secret",
    fetchImpl,
    retryDelayMs: 1,
    maxRetryAfterMs: 20,
    timeoutMs: 5_000,
    maxAttempts: 3,
  });
}

/**
 * Asserts a bounded, successful retry across the given Retry-After variant:
 * exactly `1 + failures` fetches, a settled promise, and an elapsed time far
 * under the unbounded wait the header threatened.
 *
 * @param {number} failures
 * @param {string | undefined} retryAfter
 * @param {number} hardElapsedCeilingMs
 */
async function assertBoundedRetry(failures, retryAfter, hardElapsedCeilingMs) {
  const { fetchImpl, calls } = retryThenOk(failures, retryAfter);
  const http = fastClient(fetchImpl);
  const start = Date.now();
  const response = await http.request("/chat/completions");
  const elapsed = Date.now() - start;
  assert.equal(calls(), failures + 1, "unexpected number of fetches");
  assert.equal(response.status, 200, "the retried request should succeed");
  assert.ok(
    elapsed < hardElapsedCeilingMs,
    `expected bounded backoff under ${hardElapsedCeilingMs}ms, took ${elapsed}ms`,
  );
}

describe("Retry-After variants cannot stretch the retry wait", () => {
  it("non-numeric Retry-After falls back to the retry-delay backoff and still retries", async () => {
    // `Number("not-a-number")` is NaN → `delayFor` falls through to the
    // retry-delay backoff (1ms), so the wait is tiny, not the absurd value.
    await assertBoundedRetry(1, "not-a-number", 5_000);
  });

  it("an absurd numeric Retry-After is clamped by maxRetryAfterMs (timing proof)", async () => {
    // `Retry-After: 999999` would mean a 999,999-second wait. The client
    // clamps to `maxRetryAfterMs` (20). The request completing to a second
    // fetch at all — in well under a second — IS the proof the cap applied;
    // an unhamped backoff would never settle inside any test timeout.
    await assertBoundedRetry(1, "999999", 5_000);
  });

  it("an absent Retry-After still retries on the fixed backoff", async () => {
    await assertBoundedRetry(1, undefined, 5_000);
  });

  it("a date-form Retry-After (NaN seconds) is bounded, not turned into an open wait", async () => {
    // `Number("Wed, 21 Oct 2100 07:28:00 GMT")` is NaN → the backoff path.
    // The future date is the point: even a syntactically valid RFC 1123
    // value resolves to the tiny retry delay, not to the far-future instant.
    await assertBoundedRetry(1, "Wed, 21 Oct 2100 07:28:00 GMT", 5_000);
  });

  it("a small numeric Retry-After is respected within a loose lower bound", async () => {
    const { fetchImpl, calls } = retryThenOk(1, "0.05");
    // A dedicated client whose cap is above 50ms so the numeric 0.05-second
    // (50ms) value is respected, not clamped to the cap — proving backoff
    // actually waits on the header, rather than the tiny retry-delay fallback.
    const http = createHttpClient({
      baseUrl: "https://api.example/v1",
      authorization: "Bearer sk-secret",
      fetchImpl,
      retryDelayMs: 1,
      maxRetryAfterMs: 500,
      timeoutMs: 5_000,
      maxAttempts: 3,
    });
    const start = Date.now();
    const response = await http.request("/chat/completions");
    const elapsed = Date.now() - start;
    assert.equal(calls(), 2, "expected a retry after the 429");
    assert.equal(response.status, 200, "the retried request should succeed");
    // The header promises 50ms; the wait must reflect it (a 1ms fallback
    // would resolve near-instant). The lower bound is loose so a loaded CI
    // box cannot flake it, and the upper bound holds the cap shape.
    assert.ok(elapsed >= 40, `expected the backoff to actually wait, took ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `expected the backoff to stay bounded, took ${elapsed}ms`);
  });

  it("an exhausted attempt ceiling surfaces as a typed HttpError, not a retry loop", async () => {
    // Three 429s against a client with `maxAttempts: 3` → all three attempts
    // are spent on transient failures, and the final 429 is materialised and
    // refused as the typed HttpError, never retried forever.
    const { fetchImpl, calls } = retryThenOk(3, "999999");
    const http = fastClient(fetchImpl);
    const error = await http.request("/chat/completions").catch((cause) => cause);
    assert.equal(calls(), 3, "expected exactly the client's maxAttempts fetches");
    assert.ok(error instanceof HttpError, "expected a typed HttpError on exhausted attempts");
    assert.equal(error.status, 429, "the HttpError should carry the provider's status");
  });
});
