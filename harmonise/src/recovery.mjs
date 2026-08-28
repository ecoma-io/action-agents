/**
 * `harmonise` deterministic failure/recovery policy — after a pair fails,
 * decide from a declared failure class and the attempt index whether to
 * retry, and which delay to name first. A pure module: no imports, no I/O,
 * no timers, nothing read from the run.
 *
 * Doctrine:
 *
 * - **Recovery is a declared policy over deterministic failure classes.**
 *   Which failures retry, how many times, and after which delay are rows in
 *   the tables this file declares — not judgement calls made at the failure
 *   site. The defaults: a `transport` fault retries twice (a blip can
 *   clear), an `auth` failure gives up immediately (no retry changes what
 *   the token is), a `refusal` gives up immediately, and an `unknown`
 *   failure retries once — bounded optimism for the one case where
 *   classification, not the failure, was the uncertain part.
 * - **Refusals are deterministic, so they are never retried.** A refusal is
 *   a content-level verdict — a policy violation, a validation failure, a
 *   protected-content guard. The pair's content produced it, and the same
 *   content produces it again: a retry is a second model call for the same
 *   answer. Only the stochastic classes (a transport blip, an unnamed
 *   fault) can change their outcome between attempts, and only they are
 *   granted retries.
 * - **The model has no path into classification or decisions.** A failure's
 *   class is tagged by harmonise's own call sites when they raise; it is
 *   never parsed out of anything the model or a thread produced, and no
 *   model output can add, rename, or select a class, an action, or a delay.
 *   The classifier is total and conservative: anything untagged, mis-tagged,
 *   or unrecognized lands in `unknown` — never in a guessed retryable class.
 * - **Boundaries decide; they never throw.** An attempt index outside the
 *   declared range maps to `exhausted`; a failure class outside the declared
 *   set maps to `give-up`. The one throw in this module is a malformed
 *   caller-supplied policy: that is a programmer error, refused — never
 *   coerced into a silently different decision — before any decision is
 *   computed.
 * - **No timers.** `delayClass` names a delay from the same declared table;
 *   sleeping, and honouring a provider's retry-after, is the caller's job.
 */

/**
 * The declared failure classes, in the order the doctrine states them.
 * Exported frozen: this array is the whole classification surface — a class
 * not in it does not exist, and nothing downstream may grow it.
 *
 * @typedef {"transport" | "auth" | "refusal" | "unknown"} FailureClass
 * @type {readonly FailureClass[]}
 */
export const FAILURE_CLASSES = Object.freeze(["transport", "auth", "refusal", "unknown"]);

/**
 * The actions `nextAction` may return. Declared so the outcome set is
 * countable: `retry` (attempt the pair again, after `delayClass`), `exhausted`
 * (the retries this class allows are spent), `give-up` (no retry was ever
 * going to help — the class policy declines to spend one).
 *
 * @typedef {"retry" | "exhausted" | "give-up"} RecoveryAction
 */

/**
 * The delays `delayClass` may name. A delay name is a decision, not a
 * duration: mapping a name onto milliseconds is the caller's policy.
 *
 * @typedef {"immediate" | "short" | "long"} DelayName
 * @type {readonly DelayName[]}
 */
export const DELAY_CLASSES = Object.freeze(["immediate", "short", "long"]);

/**
 * A failure with its class already declared. Not exported: the raise surface
 * is the three concrete classes below, and nothing else may extend it. The
 * class an instance carries is fixed by its constructor, so a mutated field
 * cannot reclassify it after the fact.
 *
 * @abstract
 */
class ClassifiedError extends Error {
  /**
   * @param {FailureClass} failureClass The declared class of this failure.
   * @param {string} name The class name, for stacks and logs.
   * @param {string} message What failed, in the caller's words.
   */
  constructor(failureClass, name, message) {
    super(message);
    this.name = name;
    /** @type {FailureClass} */
    this.failureClass = failureClass;
  }
}

/**
 * The provider was unreachable, rate-limited, or overloaded. Transient by
 * nature — the same pair can succeed on the next call — which is why this is
 * the one class the default policy retries to its cap.
 */
export class TransportError extends ClassifiedError {
  /** @param {string} message */
  constructor(message) {
    super("transport", "TransportError", message);
  }
}

/**
 * Credentials were rejected or are missing. Not transient: no retry changes
 * what the token is.
 */
export class AuthError extends ClassifiedError {
  /** @param {string} message */
  constructor(message) {
    super("auth", "AuthError", message);
  }
}

/**
 * A deterministic content-level refusal: a policy violation, a validation
 * failure, or a protected-content guard. The pair's content produced it, so
 * the same content produces it again — retrying burns a model call and
 * cannot change the answer.
 */
export class RefusalError extends ClassifiedError {
  /** @param {string} message */
  constructor(message) {
    super("refusal", "RefusalError", message);
  }
}

/**
 * The declared error classes a call site may raise. Exported frozen: this
 * object is the whole raise surface — an error not reachable from it is not
 * a declared failure and classifies as `unknown`.
 *
 * @type {Readonly<{transport: typeof TransportError, auth: typeof AuthError, refusal: typeof RefusalError}>}
 */
export const ERROR_CLASSES = Object.freeze({
  transport: TransportError,
  auth: AuthError,
  refusal: RefusalError,
});

/**
 * A recovery policy this module refuses: a key that is not a declared
 * failure class, a row with fields other than `retries`, or a retry count
 * that is not a non-negative safe integer. Refused, not clamped or coerced —
 * the same doctrine as every configuration in this action.
 */
export class RecoveryPolicyError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "RecoveryPolicyError";
  }
}

/**
 * One policy row: how many retries this class is granted after its first
 * failure. `0` means the class gives up immediately.
 *
 * @typedef {{ retries: number }} PolicyRow
 */

/**
 * A caller-supplied policy: a subset of the declared failure classes, each
 * overriding exactly one number — `retries`. Anything else is refused.
 *
 * @typedef {Partial<Record<FailureClass, PolicyRow>>} PolicyOverrides
 */

/**
 * The resolved policy decisions come from: every declared class has a row.
 *
 * @typedef {Readonly<Record<FailureClass, Readonly<PolicyRow>>>} RecoveryPolicy
 */

/**
 * The default policy, one row per declared class. Exported frozen so callers
 * can read the same table the decisions come from.
 *
 * - `transport` retries 2: the pair-loop's two attempts, spent on the one
 *   failure kind a retry can actually fix.
 * - `auth` retries 0: give up immediately.
 * - `refusal` retries 0: give up immediately — a deterministic refusal
 *   repeats identically on every attempt.
 * - `unknown` retries 1: bounded optimism for the class that only means
 *   "classification could not name this".
 *
 * @type {RecoveryPolicy}
 */
export const DEFAULT_POLICY = deepFreeze({
  transport: { retries: 2 },
  auth: { retries: 0 },
  refusal: { retries: 0 },
  unknown: { retries: 1 },
});

/**
 * The delay table, one row of delay names per declared class, sized to the
 * default policy: `transport` backs off `short` then `long`, `unknown` waits
 * `short` once, and `auth` and `refusal` are never delayed because they are
 * never retried. Fixed regardless of caller overrides — an override spends
 * more or fewer retries, it does not invent delay names.
 *
 * @type {Readonly<Record<FailureClass, readonly DelayName[]>>}
 */
const DELAY_TABLE = deepFreeze({
  transport: ["short", "long"],
  auth: ["immediate"],
  refusal: ["immediate"],
  unknown: ["short"],
});

/**
 * Classifies any thrown value into exactly one declared failure class.
 * Total: never throws, for any input, including `undefined` and primitives.
 * Conservative: a value carrying no tag this module declared — an untagged
 * `Error`, a foreign tag value, a non-object — classifies as `unknown`
 * rather than being guessed into a retryable class. An instance of a
 * declared error class classifies as its constructor declared, whatever a
 * later-mutated field claims.
 *
 * @param {unknown} error Anything a `catch` might have caught.
 * @returns {FailureClass} One of the declared classes, never anything else.
 */
export function classifyFailure(error) {
  if (error instanceof TransportError) return "transport";
  if (error instanceof AuthError) return "auth";
  if (error instanceof RefusalError) return "refusal";
  const tag =
    typeof error === "object" && error !== null
      ? /** @type {{ failureClass?: unknown }} */ (error).failureClass
      : undefined;
  return isFailureClass(tag) ? tag : "unknown";
}

/**
 * Decides the one action a failed attempt gets next, from the declared
 * policy. Total over failure classes and attempt indexes: never throws for
 * either, whatever their shape. Decision precedence, each step declared:
 *
 * 1. A failure class outside the declared set → `give-up`. Nothing is known
 *    about it, so no retry is spent on it. (The declared `unknown` class is
 *    a different thing: classification ran and could not name the failure,
 *    and it carries one optimistic retry.)
 * 2. An attempt index that is not an integer in `0..retries` → `exhausted`.
 *    The boundary is a decision, not a crash: a negative index, a fraction,
 *    `NaN`, an infinity all mean "past the declared range".
 * 3. `attemptIndex < retries` → `retry`.
 * 4. `attemptIndex === retries` → `exhausted` when the class had retries to
 *    spend, `give-up` when its policy was never to spend any.
 *
 * @param {FailureClass} failureClass The class `classifyFailure` named.
 * @param {number} attemptIndex Zero-based index of the attempt that just
 *   failed: `0` is the first failure of this pair, `1` the failure of its
 *   first retry, and so on.
 * @param {PolicyOverrides} [policy] Overrides over the default policy.
 *   Malformed overrides are refused with `RecoveryPolicyError` — a malformed
 *   policy is a programmer error, and refusing it is the point.
 * @returns {RecoveryAction} Exactly one action, from the declared set.
 */
export function nextAction(failureClass, attemptIndex, policy) {
  const resolved = resolvePolicy(policy);
  if (!isFailureClass(failureClass)) return "give-up";
  const retries = resolved[failureClass].retries;
  if (!Number.isSafeInteger(attemptIndex) || attemptIndex < 0 || attemptIndex > retries) {
    return "exhausted";
  }
  if (attemptIndex < retries) return "retry";
  return retries > 0 ? "exhausted" : "give-up";
}

/**
 * Names the delay before the action `nextAction` chose is carried out, from
 * the declared delay table. Total: never throws. An index past its class's
 * row, an out-of-range index, or a class outside the declared set names
 * `immediate` — no retry is pending there, so nothing is waited for. A
 * caller override that spends more retries than the table names still gets
 * `immediate` past the row's end: extending the backoff is the caller's
 * business, not a new table entry.
 *
 * @param {FailureClass} failureClass The class `classifyFailure` named.
 * @param {number} attemptIndex Zero-based index of the retry being timed:
 *   `0` is the delay before the first retry.
 * @returns {DelayName} One of the declared delay names, never anything else.
 */
export function delayClass(failureClass, attemptIndex) {
  const row = isFailureClass(failureClass) ? DELAY_TABLE[failureClass] : undefined;
  if (
    row === undefined ||
    !Number.isSafeInteger(attemptIndex) ||
    attemptIndex < 0 ||
    attemptIndex >= row.length
  ) {
    return "immediate";
  }
  // The guard above bounds the index inside the row.
  return /** @type {DelayName} */ (row[attemptIndex]);
}

/**
 * Validates a caller-supplied policy and merges it over the defaults, or
 * returns the defaults unchanged. Throws `RecoveryPolicyError` on anything
 * this module did not declare — a wrong-typed policy, an unknown class key,
 * a row with fields other than `retries`, a negative, fractional, or unsafe
 * retry count. Values are refused, never coerced.
 *
 * @param {PolicyOverrides | undefined} policy
 * @returns {RecoveryPolicy} The frozen resolved policy.
 */
function resolvePolicy(policy) {
  if (policy === undefined) return DEFAULT_POLICY;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new RecoveryPolicyError(
      `recovery policy must be an object keyed by failure class, refused ${describe(policy)}`,
    );
  }
  const supplied = /** @type {Record<string, unknown>} */ (policy);
  /** @type {Partial<Record<FailureClass, number>>} */
  const overrides = {};
  for (const key of Object.keys(supplied)) {
    if (!isFailureClass(key)) {
      throw new RecoveryPolicyError(
        `recovery policy key ${describe(key)} is not a declared failure class (declared: ${FAILURE_CLASSES.join(", ")})`,
      );
    }
    const row = supplied[key];
    const fields =
      typeof row === "object" && row !== null && !Array.isArray(row)
        ? Object.keys(/** @type {Record<string, unknown>} */ (row))
        : undefined;
    if (fields === undefined || fields.length !== 1 || fields[0] !== "retries") {
      throw new RecoveryPolicyError(
        `recovery policy row for ${describe(key)} must be exactly { retries: <non-negative integer> }, refused ${describe(row)}`,
      );
    }
    const retries = /** @type {Record<string, unknown>} */ (row).retries;
    if (typeof retries !== "number" || !Number.isSafeInteger(retries) || retries < 0) {
      throw new RecoveryPolicyError(
        `recovery policy ${describe(key)}.retries must be a non-negative safe integer, refused ${describe(retries)}`,
      );
    }
    overrides[key] = retries;
  }
  return deepFreeze({
    transport: {
      retries: overrides.transport ?? DEFAULT_POLICY.transport.retries,
    },
    auth: { retries: overrides.auth ?? DEFAULT_POLICY.auth.retries },
    refusal: { retries: overrides.refusal ?? DEFAULT_POLICY.refusal.retries },
    unknown: { retries: overrides.unknown ?? DEFAULT_POLICY.unknown.retries },
  });
}

/**
 * @param {unknown} value
 * @returns {value is FailureClass}
 */
function isFailureClass(value) {
  return (
    typeof value === "string" && /** @type {readonly string[]} */ (FAILURE_CLASSES).includes(value)
  );
}

/**
 * Freezes a table at both levels, so a decision table cannot be changed
 * after the fact.
 *
 * @template {object} T
 * @param {T} value
 * @returns {Readonly<T>}
 */
function deepFreeze(value) {
  for (const row of Object.values(value)) Object.freeze(row);
  return Object.freeze(value);
}

/**
 * Renders a refused value for an error message, same shape as everywhere
 * else in this action.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  return typeof value === "string" ? `"${value}"` : String(value);
}
