// Tests for the HTTP client.
//
// What is pinned here is the seam, not the plumbing: a credential never
// crosses to a host the caller did not configure, untrusted bytes are capped
// while they stream, and the failure shapes a provider really produces —
// transient, permanent, timeout, redirect — each reach the caller as the
// error class named for them. A test that only proved "a GET returns a body"
// would pin nothing worth keeping.

import { describe, expect, it, vi } from "vitest";

import {
  BodyTooLargeError,
  CrossOriginRedirectError,
  HttpError,
  TransportError,
} from "./transport-errors.mjs";
import { createHttpClient } from "./http.mjs";

/**
 * @typedef {object} RecordedCall
 * @property {string} url
 * @property {string | undefined} method
 * @property {Record<string, string>} headers
 * @property {unknown} body
 */

/** @param {string} [body] @param {ResponseInit} [init] @returns {() => Response} */
function ok(body = "{}", init = {}) {
  return () => new Response(body, { status: 200, ...init });
}

/** @param {number} status @param {string} [location] @returns {() => Response} */
function redirect(status, location) {
  return () => new Response(null, { status, headers: { location } });
}

/** @param {number} status @param {string} [body] @param {Record<string, string>} [headers] @returns {() => Response} */
function status(status, body = "", headers = {}) {
  return () => new Response(body, { status, headers });
}

/** A transport-level timeout: what fetch rejects with when its attempt signal fires. @returns {DOMException} */
function timedOut() {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/**
 * A fetch that answers from a script: each call takes the next entry, which
 * is a Response factory (a body is consumed once, so every call needs a
 * fresh one) or an Error to throw. Every call is recorded with the method,
 * headers and body it carried, so a test can prove where a credential went —
 * and did not go.
 *
 * @param {Array<(() => Response) | Error>} script
 * @param {{ calls?: RecordedCall[] }} [recorder]
 * @returns {typeof globalThis.fetch}
 */
function scripted(script, recorder = {}) {
  let call = 0;
  recorder.calls = [];
  return /** @type {typeof globalThis.fetch} */ (
    /** @param {string | URL | Request} url @param {RequestInit} [init] */
    async (url, init) => {
      recorder.calls?.push({
        url: String(url),
        method: init?.method,
        headers: /** @type {Record<string, string>} */ (init?.headers ?? {}),
        body: init?.body,
      });
      const step = script[Math.min(call, script.length - 1)];
      call++;
      if (step === undefined) throw new Error("the fetch script was exhausted");
      if (step instanceof Error) throw step;
      return step();
    }
  );
}

const FAST = { retryDelayMs: 1, maxRetryAfterMs: 10, timeoutMs: 5_000 };

describe("the request itself", () => {
  it("resolves the path against the configured base and returns the body", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const http = createHttpClient({
      baseUrl: "https://api.example/v1",
      fetchImpl: scripted(
        [ok('{"value":1}', { headers: { "content-type": "application/json" } })],
        recorder,
      ),
    });

    const response = await http.request("/chat/completions");

    expect(response).toMatchObject({ status: 200, text: '{"value":1}' });
    expect(response.headers["content-type"]).toBe("application/json");
    expect(recorder.calls?.[0]?.url).toBe("https://api.example/v1/chat/completions");
  });

  it("sends the Authorization header only when one is configured", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const fetch = scripted([ok(), ok()], recorder);

    await createHttpClient({
      baseUrl: "https://api.example",
      authorization: "Bearer sk-secret",
      fetchImpl: fetch,
    }).request("/x");
    await createHttpClient({ baseUrl: "https://api.example", fetchImpl: fetch }).request("/x");

    expect(recorder.calls?.[0]?.headers["Authorization"]).toBe("Bearer sk-secret");
    expect(recorder.calls?.[1]?.headers["Authorization"]).toBeUndefined();
  });

  it("JSON-encodes an object body and announces it, and sends a string verbatim", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: scripted([ok(), ok()], recorder),
    });

    await http.request("/x", { method: "POST", body: { model: "gpt-x" } });
    await http.request("/x", {
      method: "POST",
      body: "raw",
      headers: { "content-type": "text/plain" },
    });

    expect(recorder.calls?.[0]).toMatchObject({
      headers: { "content-type": "application/json" },
      body: '{"model":"gpt-x"}',
    });
    expect(recorder.calls?.[1]?.body).toBe("raw");
  });
});

describe("retries", () => {
  it("retries a 503 and succeeds on the next attempt", async () => {
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: scripted([status(503, "busy"), ok('"done"')]),
      ...FAST,
    });

    await expect(http.request("/x")).resolves.toMatchObject({ status: 200, text: '"done"' });
  });

  it("honours Retry-After when the provider states one", async () => {
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: scripted([status(429, "", { "retry-after": "0" }), ok()]),
      ...FAST,
    });

    await expect(http.request("/x")).resolves.toMatchObject({ status: 200 });
  });

  it("gives up after the last attempt and throws HttpError with the status", async () => {
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: scripted([status(503, "no")]),
      ...FAST,
      maxAttempts: 2,
    });

    const error = await http.request("/x").catch((cause) => cause);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(503);
    expect(error.message).toMatch(/HTTP 503/);
  });

  it("cancels the body of a retryable answer it abandons on the retry path", async () => {
    let cancelled = false;
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: scripted(
        [
          () => {
            const response = status(503, "busy")();
            // Shadow the stream so the test can observe the client's cancel.
            Object.defineProperty(response, "body", {
              value: {
                cancel: () => {
                  cancelled = true;
                  return Promise.resolve();
                },
              },
            });
            return response;
          },
          ok('"done"'),
        ],
        {},
      ),
      ...FAST,
    });

    await expect(http.request("/x")).resolves.toMatchObject({ status: 200, text: '"done"' });
    // The refused stream was released before the retry, not left dangling.
    expect(cancelled).toBe(true);
  });

  it("does not retry a permanent status", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: scripted([status(404, "gone")], recorder),
      ...FAST,
    });

    const error = await http.request("/x").catch((cause) => cause);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(404);
    expect(recorder.calls).toHaveLength(1);
  });

  it("makes one attempt when the request says it is not idempotent", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: scripted([status(503, "busy"), ok()], recorder),
      ...FAST,
    });

    const error = await http.request("/x", { method: "POST", maxAttempts: 1 }).catch((c) => c);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(503);
    expect(recorder.calls).toHaveLength(1);
  });

  it("retries a network failure and surfaces TransportError when none succeed", async () => {
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: scripted([new TypeError("fetch failed"), new TypeError("fetch failed")]),
      ...FAST,
    });

    const error = await http.request("/x").catch((cause) => cause);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.message).toMatch(/fetch failed/);
  });

  it("surfaces a timeout as TransportError, naming the timeout", async () => {
    /** @type {typeof globalThis.fetch} */
    const hanging = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "TimeoutError")),
        );
      });
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: hanging,
      timeoutMs: 10,
      maxAttempts: 1,
    });

    const error = await http.request("/x").catch((cause) => cause);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.message).toMatch(/timed out/);
  });

  it("retries a timed-out attempt and succeeds on the next one", async () => {
    /** @type {AbortSignal[]} */
    const signals = [];
    /** @type {typeof globalThis.fetch} */
    const timesOutOnce = (_url, init) => {
      signals.push(/** @type {AbortSignal} */ (init?.signal));
      if (signals.length === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "TimeoutError")),
          );
        });
      }
      return Promise.resolve(ok('"late but done"')());
    };
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: timesOutOnce,
      timeoutMs: 10,
      retryDelayMs: 1,
    });

    await expect(http.request("/x")).resolves.toMatchObject({
      status: 200,
      text: '"late but done"',
    });
    expect(signals).toHaveLength(2);
  });

  it("hands each attempt its own abort signal", async () => {
    /** @type {{ signal: AbortSignal | undefined, abortedAtCall: boolean | undefined }[]} */
    const seen = [];
    /** @type {typeof globalThis.fetch} */
    const timesOutOnce = (_url, init) => {
      seen.push({
        signal: init?.signal ?? undefined,
        abortedAtCall: init?.signal?.aborted ?? undefined,
      });
      if (seen.length === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "TimeoutError")),
          );
        });
      }
      return Promise.resolve(ok()());
    };
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: timesOutOnce,
      timeoutMs: 10,
      retryDelayMs: 1,
    });

    await expect(http.request("/x")).resolves.toMatchObject({ status: 200 });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.signal).toBeDefined();
    expect(seen[1]?.signal).toBeDefined();
    expect(seen[0]?.signal).not.toBe(seen[1]?.signal);
    // Attempt two's signal was not yet the one that timed out — the stale,
    // already-aborted signal would fail the retry before fetch ran.
    expect(seen[1]?.abortedAtCall).toBe(false);
  });

  it("surfaces TransportError when every attempt times out", async () => {
    let calls = 0;
    /** @type {typeof globalThis.fetch} */
    const hanging = (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "TimeoutError")),
        );
      });
    };
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: hanging,
      timeoutMs: 10,
      maxAttempts: 2,
      retryDelayMs: 1,
    });

    const error = await http.request("/x").catch((cause) => cause);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.message).toMatch(/timed out/);
    expect(calls).toBe(2);
  });

  it("delays a status retry by Retry-After, not by the plain backoff", async () => {
    vi.useFakeTimers();
    try {
      /** @type {{ calls?: RecordedCall[] }} */
      const recorder = {};
      const http = createHttpClient({
        baseUrl: "https://api.example",
        fetchImpl: scripted([status(429, "", { "retry-after": "2" }), ok('"after"')], recorder),
        // The plain backoff for attempt 1 — deliberately half of Retry-After.
        retryDelayMs: 1_000,
        timeoutMs: 5_000,
      });
      const settled = http.request("/x").catch((cause) => cause);

      // Backoff alone would have retried after one second; Retry-After says two.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(recorder.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(settled).resolves.toMatchObject({ status: 200, text: '"after"' });
      expect(recorder.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the retry wall-clock contract", () => {
  // What the docs imply and the older retry tests never measured: how long
  // the loop waits, who owns the waiting, and where the worst case ends.
  // AbortSignal.timeout runs on a real timer fake timers cannot move, so a
  // timed-out attempt is simulated the way its own signal ends it — fetch
  // rejecting with a TimeoutError.
  it("sleeps the full backoff after a timed-out attempt, then retries on a fresh signal", async () => {
    vi.useFakeTimers();
    try {
      /** @type {AbortSignal[]} */
      const signals = [];
      /** @type {{ calls?: RecordedCall[] }} */
      const recorder = {};
      const inner = scripted([timedOut(), ok('"second time"')], recorder);
      /** @type {typeof globalThis.fetch} */
      const fetch = (_url, init) => {
        signals.push(/** @type {AbortSignal} */ (init?.signal));
        return inner(_url, init);
      };
      const http = createHttpClient({
        baseUrl: "https://api.example",
        fetchImpl: fetch,
        timeoutMs: 5_000,
        retryDelayMs: 1_000,
      });
      const settled = http.request("/x").catch((cause) => cause);

      // Mid-backoff: one attempt spent, nothing settled early.
      await vi.advanceTimersByTimeAsync(999);
      expect(recorder.calls).toHaveLength(1);

      // The backoff for a first attempt is exactly retryDelayMs x 1.
      await vi.advanceTimersByTimeAsync(1);
      await expect(settled).resolves.toMatchObject({ status: 200, text: '"second time"' });
      expect(recorder.calls).toHaveLength(2);

      // The retry ran on its own signal, not the one attempt one failed under.
      expect(signals).toHaveLength(2);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[1]).toBeInstanceOf(AbortSignal);
      expect(signals[1]).not.toBe(signals[0]);
      expect(signals[1]?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps Retry-After at exactly thirty seconds however much the header demands", async () => {
    vi.useFakeTimers();
    try {
      /** @type {{ calls?: RecordedCall[] }} */
      const recorder = {};
      const http = createHttpClient({
        baseUrl: "https://api.example",
        fetchImpl: scripted(
          [status(429, "slow down", { "retry-after": "3600" }), ok('"finally"')],
          recorder,
        ),
        retryDelayMs: 1_000,
        timeoutMs: 5_000,
      });
      const settled = http.request("/x").catch((cause) => cause);

      // The header demands an hour; the plain backoff would be one second.
      // Neither delay runs: the retry fires neither a tick before nor a tick
      // after the default cap of 30 000 ms.
      await vi.advanceTimersByTimeAsync(29_999);
      expect(recorder.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(settled).resolves.toMatchObject({ status: 200, text: '"finally"' });
      expect(recorder.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes no abort from the caller — the inter-attempt sleep is the client's alone", async () => {
    vi.useFakeTimers();
    try {
      /** @type {{ calls?: RecordedCall[] }} */
      const recorder = {};
      const http = createHttpClient({
        baseUrl: "https://api.example",
        fetchImpl: scripted([timedOut(), ok('"carried on"')], recorder),
        timeoutMs: 5_000,
        retryDelayMs: 1_000,
      });
      // No channel exists to stop the loop: request reads no signal, so even
      // an already-aborted one handed to it cannot touch the retry.
      const wishfulAbort = { method: "GET", signal: AbortSignal.abort() };
      const settled = http.request("/x", wishfulAbort).catch((cause) => cause);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(settled).resolves.toMatchObject({ status: 200, text: '"carried on"' });
      expect(recorder.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no overall wall-time budget — the worst case is maxAttempts x timeoutMs plus the sum of the delays", async () => {
    vi.useFakeTimers();
    try {
      /** @type {{ calls?: RecordedCall[] }} */
      const recorder = {};
      const http = createHttpClient({
        baseUrl: "https://api.example",
        fetchImpl: scripted([timedOut(), timedOut(), timedOut()], recorder),
        maxAttempts: 3,
        timeoutMs: 5_000,
        retryDelayMs: 1_000,
      });
      const settled = http.request("/x").catch((cause) => cause);

      // Nothing bounds the loop except its own numbers: each attempt burns
      // its timeoutMs, each gap its backoff. Three attempts timing out cost
      // 3 x 5 000 ms plus backoff(1) + backoff(2) = 1 000 + 2 000 ms of wall
      // time, and no caller input shortens that.
      await vi.advanceTimersByTimeAsync(999);
      expect(recorder.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1); // backoff(1) = 1 000
      expect(recorder.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(recorder.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1); // backoff(2) = 2 000
      expect(recorder.calls).toHaveLength(3);

      const error = await settled;
      expect(error).toBeInstanceOf(TransportError);
      expect(error.message).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the redirect ceiling", () => {
  it("refuses an absolute-url request off the configured origin before any call", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const http = createHttpClient({
      baseUrl: "https://api.example",
      authorization: "Bearer sk-secret",
      fetchImpl: scripted([ok("{}")], recorder),
      ...FAST,
    });

    // A server-chosen `Link: rel="next"` is exactly such a URL; following it
    // would carry the credential to a host nobody configured.
    await expect(http.request("https://evil.example/x")).rejects.toBeInstanceOf(
      CrossOriginRedirectError,
    );
    expect(recorder.calls).toHaveLength(0);
  });

  it("accepts an absolute-url request on the configured origin", async () => {
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: scripted([ok("{}")]),
      ...FAST,
    });

    await expect(http.request("https://api.example/next?page=2")).resolves.toMatchObject({
      text: "{}",
    });
  });

  it("refuses a redirect that leaves the configured origin, without following it", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const http = createHttpClient({
      baseUrl: "https://api.example/v1",
      authorization: "Bearer sk-secret",
      fetchImpl: scripted([redirect(302, "https://evil.example/v1/x")], recorder),
      ...FAST,
    });

    const error = await http.request("/x").catch((cause) => cause);
    expect(error).toBeInstanceOf(CrossOriginRedirectError);
    expect(error.message).toMatch(/api\.example/);
    expect(error.message).toMatch(/evil\.example/);
    // The credential stayed home: exactly one request was made, to the
    // configured origin only.
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls?.[0]?.url).toBe("https://api.example/v1/x");
  });

  it("follows a same-origin redirect with the credential intact", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const http = createHttpClient({
      baseUrl: "https://api.example/v1",
      authorization: "Bearer sk-secret",
      fetchImpl: scripted([redirect(302, "https://api.example/v1/y"), ok('"there"')], recorder),
      ...FAST,
    });

    await expect(http.request("/x")).resolves.toMatchObject({ text: '"there"' });
    expect(recorder.calls?.[1]?.url).toBe("https://api.example/v1/y");
    expect(recorder.calls?.[1]?.headers["Authorization"]).toBe("Bearer sk-secret");
  });

  it("turns a 303 into a GET on the redirect target", async () => {
    /** @type {{ calls?: RecordedCall[] }} */
    const recorder = {};
    const http = createHttpClient({
      baseUrl: "https://api.example/v1",
      fetchImpl: scripted([redirect(303, "/v1/y"), ok()], recorder),
      ...FAST,
    });

    await http.request("/x", { method: "POST", body: { a: 1 } });

    expect(recorder.calls?.[1]).toMatchObject({
      url: "https://api.example/v1/y",
      method: "GET",
      body: undefined,
    });
  });

  it("refuses a redirect loop past three hops", async () => {
    const http = createHttpClient({
      baseUrl: "https://api.example/v1",
      fetchImpl: scripted([redirect(302, "/v1/x")]),
      ...FAST,
    });

    const error = await http.request("/x").catch((cause) => cause);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.message).toMatch(/too many redirects/);
  });

  it("refuses a redirect that names no location", async () => {
    const http = createHttpClient({
      baseUrl: "https://api.example/v1",
      fetchImpl: scripted([status(302)]),
      ...FAST,
    });

    await expect(http.request("/x")).rejects.toThrow(/no location/);
  });
});

describe("the body cap", () => {
  it("refuses a body whose declared length already exceeds the cap", async () => {
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: scripted([status(200, "{}", { "content-length": String(2 ** 21) })]),
      maxBodyBytes: 1024,
      ...FAST,
    });

    await expect(http.request("/x")).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("refuses a body that exceeds the cap while it streams, with no declared length", async () => {
    const http = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: scripted([() => new Response("x".repeat(2048))]),
      maxBodyBytes: 1024,
      ...FAST,
    });

    await expect(http.request("/x")).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("takes a per-request cap over the client's, in both directions", async () => {
    // A request naming a bigger cap reads what the client's would refuse.
    const wider = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: scripted([() => new Response("x".repeat(2048))]),
      maxBodyBytes: 1024,
      ...FAST,
    });
    await expect(wider.request("/x", { maxBodyBytes: 4096 })).resolves.toMatchObject({
      text: "x".repeat(2048),
    });

    // And one naming a smaller cap refuses what the client's would read.
    const narrower = createHttpClient({
      baseUrl: "https://api.example",
      fetchImpl: scripted([ok("x".repeat(64))]),
      maxBodyBytes: 4096,
      ...FAST,
    });
    await expect(narrower.request("/x", { maxBodyBytes: 8 })).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });
});

describe("error hygiene", () => {
  it("never places a header value in an error message", async () => {
    const http = createHttpClient({
      baseUrl: "https://api.example",
      authorization: "Bearer sk-secret",
      fetchImpl: scripted([status(401, "denied")]),
      ...FAST,
    });

    const error = await http.request("/x").catch((cause) => cause);
    expect(error.message).not.toContain("sk-secret");
    expect(error.excerpt).not.toContain("sk-secret");
  });
});
