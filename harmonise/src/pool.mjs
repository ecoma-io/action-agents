/**
 * `harmonise` bounded-concurrency pool — run a worker over a list with a hard
 * cap on how many calls are in flight at once.
 *
 * A pure scheduling primitive, kept free of the pipeline it will serve.
 * Doctrine:
 *
 * - **Concurrency is a declared resource policy.** A cap on concurrent model
 *   calls is a number the caller owns and states. This module has no default
 *   and refuses to invent one: `concurrency` is required and must be a
 *   positive integer — never clamped, never coerced. For harmonise's model
 *   calls a conservative starting point is `2`, raised only once the provider
 *   has shown it tolerates more.
 * - **The pool never looks inside items or results.** Values move from input
 *   slot to output slot by index alone; what an item or a result means is the
 *   caller's business.
 * - **No timers, no globals, no nondeterminism of its own.** Scheduling is a
 *   fixed walk over the input order; completion order never leaks into the
 *   outcome. `results[i]` is the settled value of `items[i]` whatever order
 *   the workers finish in, and `errors` is sorted by index.
 *
 * The pool never rejects. Every run resolves with `{ results, errors }`:
 * `results` holds one settled value per input slot (`undefined` where that
 * item failed or was never started), `errors` holds every rejection as
 * `{ index, message }`.
 */

/**
 * A configuration the pool refuses: a malformed `concurrency`, `onError`,
 * `items` or `worker`. Refused, not clamped or coerced.
 */
export class PoolConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "PoolConfigError";
  }
}

/**
 * One rejected item, placed by input position.
 *
 * @typedef {object} PoolError
 * @property {number} index Position in the input of the item that rejected.
 * @property {string} message `error.message` for an Error rejection,
 *   `String(error)` for anything else.
 */

/**
 * What a finished pool run reports. Never a rejection.
 *
 * @template R
 * @typedef {object} PoolOutcome
 * @property {(R | undefined)[]} results Settled value per input slot, in
 *   input order; `undefined` where the item failed or was never started.
 * @property {PoolError[]} errors Every rejection, in ascending index order.
 */

/**
 * @typedef {object} PoolOptions
 * @property {number} concurrency Positive integer — how many worker calls may
 *   be in flight at once. Required; never clamped, never defaulted.
 * @property {"collect" | "fail-fast"} [onError] What one rejection does to its
 *   siblings. `"collect"` (default) captures it and lets the rest finish;
 *   `"fail-fast"` starts nothing new after it and awaits what is in flight.
 */

/**
 * Runs `worker(item, index)` over `items` with at most `options.concurrency`
 * calls in flight, resolving with the settled outcome either way.
 *
 * @template T
 * @template R
 * @param {readonly T[]} items Worked in input order; position is identity.
 * @param {(item: T, index: number) => R | Promise<R>} worker Called once per
 *   item. A synchronous throw is a rejection like any other.
 * @param {PoolOptions} options `concurrency` is required; `onError` defaults
 *   to `"collect"`.
 * @returns {Promise<PoolOutcome<R>>} rejects only ever as a `PoolConfigError`
 *   raised before the first worker call.
 * @throws {PoolConfigError} when the configuration is malformed.
 */
export async function runPool(items, worker, options) {
  if (!Array.isArray(items)) {
    throw new PoolConfigError("items must be an array");
  }
  if (typeof worker !== "function") {
    throw new PoolConfigError("worker must be a function");
  }
  const concurrency = options?.concurrency;
  if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1) {
    throw new PoolConfigError(
      `options.concurrency must be a positive integer (got ${describe(concurrency)})`,
    );
  }
  const onError = options?.onError ?? "collect";
  if (onError !== "collect" && onError !== "fail-fast") {
    throw new PoolConfigError(
      `options.onError must be "collect" or "fail-fast" (got ${describe(onError)})`,
    );
  }

  const total = items.length;
  const results = /** @type {(R | undefined)[]} */ (new Array(total).fill(undefined));
  /** @type {PoolError[]} */
  const errors = [];
  let next = 0;
  let stopped = false;

  // The cap holds by construction: at most `concurrency` lanes exist and a
  // lane works one item at a time. `next` moves only between awaits, which in
  // a single turn cannot interleave.
  const lanes = [];
  for (let lane = 0, count = Math.min(concurrency, total); lane < count; lane += 1) {
    lanes.push(
      (async () => {
        while (!stopped) {
          const index = next;
          next += 1;
          if (index >= total) return;
          try {
            results[index] = await worker(/** @type {T} */ (items[index]), index);
          } catch (error) {
            errors.push({ index, message: messageOf(error) });
            if (onError === "fail-fast") stopped = true;
          }
        }
      })(),
    );
  }
  await Promise.all(lanes);
  errors.sort((a, b) => a.index - b.index);
  return { results, errors };
}

/**
 * The message a rejection reports, whatever it rejected with.
 *
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Renders a refused configuration value for the error message.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  return typeof value === "string" ? `"${value}"` : String(value);
}
