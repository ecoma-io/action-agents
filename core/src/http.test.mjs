// Tests for the HTTP client.
//
// What is pinned here is the seam, not the plumbing: a credential never
// crosses to a host the caller did not configure, untrusted bytes are capped
// while they stream, and the failure shapes a provider really produces —
// transient, permanent, timeout, redirect — each reach the caller as the
// error class named for them. A test that only proved "a GET returns a body"
// would pin nothing worth keeping.

import { describe, expect, it } from "vitest";

import {
  BodyTooLargeError,
  CrossOriginRedirectError,
  HttpError,
  TransportError,
  createHttpClient,
} from "./http.mjs";

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
});

describe("the redirect ceiling", () => {
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
