/**
 * The transport client's failure vocabulary and retry constants — the
 * shapes a request through `http.mjs` can fail in, and the policy numbers
 * (`RETRYABLE_STATUS`, `DEFAULT_MAX_ATTEMPTS`, `DEFAULT_RETRY_DELAY_MS`)
 * whose values recovery mirrors. They live beside the client that raises
 * them, inside the `scope:transport` boundary; actions never import this
 * module directly. What they see is its projection through
 * `core/src/transport-errors.mjs`, the one door the boundary law
 * (`module-boundaries.config.mjs`) leaves open. Nothing that opens a
 * socket belongs here.
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
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** The transport's own attempt ceiling, including the first — past it a failure is the caller's. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** The fixed backoff between the transport's attempts, in milliseconds. */
export const DEFAULT_RETRY_DELAY_MS = 1_000;
