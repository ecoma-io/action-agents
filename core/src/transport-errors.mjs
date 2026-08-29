/**
 * The seam door: the transport facts an action may see, and nothing else.
 *
 * The transport client and its failure vocabulary live in
 * `core/transport/` behind the `scope:transport` boundary — an action never
 * opens, configures or inspects the client, and every network byte crosses
 * `forge` or `chat`. What an action legitimately classifies on are the
 * typed failures a request can produce and the retry-policy constants whose
 * values recovery mirrors. This module re-exports exactly those, verbatim,
 * from the transport project; `module-boundaries.config.mjs` carries the
 * rule and its reasoning. Reaching past this door — any other import from
 * `#core-transport/…` — is a boundary violation the gate names.
 */

export {
  BodyTooLargeError,
  CrossOriginRedirectError,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  HttpError,
  RETRYABLE_STATUS,
  TransportError,
} from "#core-transport/transport-errors.mjs";
