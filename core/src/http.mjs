/**
 * One HTTP client, and the two properties every request through it keeps.
 *
 * This is the protocol half of the seam `docs/development/ceilings.md`
 * describes: every request goes to the origin the caller configured, and a
 * redirect that leaves that origin is refused rather than followed, so a
 * credential never crosses to a second host. Timeouts, retries and the
 * failure shapes a provider really returns live here too, because every
 * action talks to the same providers and there is one right answer.
 *
 * The failure shapes worth naming, because a provider produces all of them:
 *
 *   - a network error or a timeout — transient, retried;
 *   - `408`, `425`, `429`, `5xx` — transient, retried, `Retry-After` honoured;
 *   - any other status — permanent, thrown as `HttpError` immediately;
 *   - a body past `maxBodyBytes` — refused while streaming, never buffered
 *     whole and then measured. Untrusted bytes are capped at the point of
 *     consumption, and a missing cap is a gap, not a style point.
 *
 * Errors carry the origin and path of the request and an excerpt of the body.
 * They never carry a header, so a credential cannot reach a log through an
 * error message. The runner masks the api-key in any log line regardless —
 * that is defence behind this one, not instead of it.
 */

/** @typedef {Record<string, string>} Headers */

/**
 * @typedef {object} HttpClientConfig
 * @property {string} baseUrl every request is resolved against this origin
 * @property {string | undefined} [authorization] the full `Authorization` header value, or "" to send none
 * @property {Headers | undefined} [headers] headers every request carries (an `Accept`, an api version)
 * @property {number | undefined} [timeoutMs] per-attempt timeout; default 30 000
 * @property {number | undefined} [maxAttempts] total attempts including the first; default 3
 * @property {number | undefined} [retryDelayMs] base for the fixed backoff between attempts; default 1 000
 * @property {number | undefined} [maxRetryAfterMs] the most a `Retry-After` header may delay; default 30 000
 * @property {number | undefined} [maxBodyBytes] response-body cap enforced while streaming; default 1 MiB
 * @property {typeof globalThis.fetch | undefined} [fetchImpl] the fetch to call — every caller here stubs it
 */

/**
 * @typedef {object} HttpRequest
 * @property {string} [method] default `"GET"`
 * @property {unknown} [body] a string is sent as-is; anything else is JSON-encoded
 * @property {Headers} [headers] per-request headers, merged over the client's
 * @property {number | undefined} [maxAttempts] per-request attempt limit, overriding the client's — set to 1 for a call that is not idempotent, where a retry of an uncertain failure would do the work twice
 * @property {number | undefined} [maxBodyBytes] per-request response-body cap, overriding the client's — for endpoints whose honest answer is bigger than the default cap (a recursive tree listing), without raising it for every call
 */

/**
 * @typedef {object} HttpResponse
 * @property {number} status
 * @property {Headers} headers response headers, lower-cased
 * @property {string} text the body, decoded, already held under the byte cap
 */

/** A permanent failure: the status or shape of the response itself. */
export class HttpError extends Error {
  /** @param {string} message @param {{ status: number, url: string, excerpt?: string }} details */
  constructor(message, details) {
    super(`${message} (HTTP ${String(details.status)} at ${details.url})`);
    this.name = "HttpError";
    this.status = details.status;
    this.url = details.url;
    this.excerpt = details.excerpt ?? "";
  }
}

/** The body exceeded the cap while it was being read. */
export class BodyTooLargeError extends Error {
  /** @param {string} url @param {number} maxBodyBytes */
  constructor(url, maxBodyBytes) {
    super(`response body exceeds the ${String(maxBodyBytes)}-byte cap at ${url}`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * A redirect would have carried the request — and its credential — to a host
 * the caller did not configure. Refused rather than followed.
 */
export class CrossOriginRedirectError extends Error {
  /** @param {string} configuredOrigin @param {string} targetOrigin */
  constructor(configuredOrigin, targetOrigin) {
    super(
      `refusing to follow a redirect from ${configuredOrigin} to ${targetOrigin} — ` +
        `requests stay on the configured origin`,
    );
    this.name = "CrossOriginRedirectError";
    this.configuredOrigin = configuredOrigin;
    this.targetOrigin = targetOrigin;
  }
}

/** The request never produced a response: the network failed or timed out. */
export class TransportError extends Error {
  /** @param {string} url @param {string} cause */
  constructor(url, cause) {
    super(`request to ${url} failed: ${cause}`);
    this.name = "TransportError";
  }
}

/** Statuses a provider returns when the failure is on its side and may pass. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 2 ** 20;

/**
 * @param {HttpClientConfig} config
 * @returns {{ request: (path: string, init?: HttpRequest) => Promise<HttpResponse> }}
 */
export function createHttpClient(config) {
  const baseUrl = new URL(config.baseUrl);
  const origin = baseUrl.origin;
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetryAfterMs = config.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  const baseHeaders = { ...config.headers };
  if (config.authorization !== undefined && config.authorization !== "") {
    baseHeaders["Authorization"] = config.authorization;
  }

  return {
    /**
     * Performs the request, following same-origin redirects only.
     *
     * @param {string} path an absolute path, resolved against the configured base
     * @param {HttpRequest} [init]
     * @returns {Promise<HttpResponse>}
     */
    async request(path, init = {}) {
      let method = init.method ?? "GET";
      /** @type {string | undefined} */
      let body =
        init.body === undefined
          ? undefined
          : typeof init.body === "string"
            ? init.body
            : JSON.stringify(init.body);
      /** @type {Headers} */
      const headers =
        init.body !== undefined && typeof init.body !== "string"
          ? { "content-type": "application/json", ...init.headers }
          : { ...init.headers };

      // A path joins onto the base's whole URL, path included: the
      // OpenAI-compatible convention is `{api-url}/chat/completions` where the
      // base already carries `/v1`, and `new URL("/x", base)` would drop it.
      // An absolute URL (a pagination `next` link) is used as-is — after the
      // same-origin check a redirect already answers to, because a `Link`
      // header is server-chosen text too, and following one off-origin would
      // carry the credential to a host the caller never configured.
      /** @type {URL} */
      let url;
      if (/^https?:\/\//.test(path)) {
        const absolute = new URL(path);
        if (absolute.origin !== origin) throw new CrossOriginRedirectError(origin, absolute.origin);
        url = absolute;
      } else {
        url = new URL(basePath + path, baseUrl);
      }
      const limit = init.maxAttempts ?? maxAttempts;
      const bodyLimit = init.maxBodyBytes ?? maxBodyBytes;

      for (let hop = 0; ; hop++) {
        const response = await attempt(url, method, body, headers, limit, bodyLimit);

        if (!REDIRECT_STATUS.has(response.status)) {
          return response;
        }

        const location = response.headers["location"];
        if (location === undefined) {
          throw new HttpError(`redirect with no location`, {
            status: response.status,
            url: where(url),
          });
        }

        const target = new URL(location, url);
        if (target.origin !== origin) {
          throw new CrossOriginRedirectError(origin, target.origin);
        }
        if (hop >= MAX_REDIRECTS) {
          throw new HttpError(`too many redirects`, { status: response.status, url: where(url) });
        }

        url = target;
        if (response.status === 303) {
          method = "GET";
          body = undefined;
        }
      }
    },
  };

  /**
   * One URL, retried while the failure is transient. `limit` is the request's
   * own attempt ceiling when it names one, the client's otherwise. `bodyLimit`
   * is resolved the same way for the response-body cap.
   *
   * @param {URL} url
   * @param {string} method
   * @param {string | undefined} body
   * @param {Headers} headers
   * @param {number} limit
   * @param {number} bodyLimit
   * @returns {Promise<HttpResponse>}
   */
  async function attempt(url, method, body, headers, limit, bodyLimit) {
    for (let number = 1; ; number++) {
      const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      try {
        const response = await fetchImpl(url, {
          method,
          headers: { ...baseHeaders, ...headers },
          ...(body !== undefined ? { body } : {}),
          redirect: "manual",
          ...(signal !== undefined ? { signal } : {}),
        });
        if (RETRYABLE_STATUS.has(response.status) && number < limit) {
          await sleep(delayFor(response, number));
          continue;
        }
        const result = await materialise(response, url, bodyLimit);
        // Redirect statuses are the caller of `attempt`'s to judge — the
        // redirect ceiling in `request` decides whether they are followed.
        if ((result.status < 200 || result.status >= 300) && !REDIRECT_STATUS.has(result.status)) {
          throw new HttpError("the request was refused", {
            status: result.status,
            url: where(url),
            excerpt: result.text.slice(0, 200),
          });
        }
        return result;
      } catch (cause) {
        if (
          (isAbort(cause) || cause instanceof TransportError) &&
          number < limit &&
          !(cause instanceof BodyTooLargeError)
        ) {
          await sleep(backoff(number));
          continue;
        }
        throw wrapTransport(url, cause);
      }
    }
  }

  /**
   * Reads the body under the byte cap while it streams, so a body past the
   * cap is refused before it is buffered.
   *
   * @param {Response} response
   * @param {URL} url
   * @param {number} maxBodyBytes
   * @returns {Promise<HttpResponse>}
   */
  async function materialise(response, url, maxBodyBytes) {
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBodyBytes) {
      throw new BodyTooLargeError(where(url), maxBodyBytes);
    }

    /** @type {Headers} */
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    let text;
    if (response.body === null) {
      text = "";
    } else {
      const reader = response.body.getReader();
      /** @type {Uint8Array[]} */
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBodyBytes) {
          await reader.cancel().catch(() => undefined);
          throw new BodyTooLargeError(where(url), maxBodyBytes);
        }
        chunks.push(value);
      }
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      text = new TextDecoder().decode(joined);
    }

    return { status: response.status, headers, text };
  }

  /**
   * @param {Response} response
   * @param {number} number the attempt that just failed, from 1
   * @returns {number} milliseconds to wait before the next attempt
   */
  function delayFor(response, number) {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, maxRetryAfterMs);
      }
    }
    return backoff(number);
  }

  /** @param {number} number @returns {number} */
  function backoff(number) {
    return retryDelayMs * number;
  }
}

/** @param {unknown} cause @returns {boolean} */
function isAbort(cause) {
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}

/**
 * Wraps what the transport itself threw, and passes through everything that
 * is already this module's own verdict — an `HttpError` or a body-cap refusal
 * is an answer about the response, not a network failure to rewrap.
 *
 * @param {URL} url
 * @param {unknown} cause
 * @returns {Error}
 */
function wrapTransport(url, cause) {
  if (cause instanceof HttpError || cause instanceof BodyTooLargeError) return cause;
  if (isAbort(cause)) return new TransportError(where(url), "timed out");
  if (cause instanceof Error) return new TransportError(where(url), cause.message);
  return new TransportError(where(url), String(cause));
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** @param {URL} url @returns {string} */
function where(url) {
  return `${url.origin}${url.pathname}`;
}
