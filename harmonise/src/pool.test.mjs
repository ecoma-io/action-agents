// Tests for the `harmonise` bounded-concurrency pool.
//
// What is pinned: the cap holds by observation (in-flight is counted across
// deferred workers and never exceeds the configured number); result slots map
// to input positions exactly, whatever the completion order; "collect"
// isolates a rejection and keeps its siblings; "fail-fast" stops scheduling
// and still awaits whatever is in flight; every run resolves; and a malformed
// configuration is refused before any worker runs.
//
// Scheduling assertions are deterministic without timers: a lane calls its
// first worker synchronously during the `runPool` call itself and defers only
// on that worker's promise, so start order is fixed the moment the call
// returns; `settle()` then drains every pending continuation before the next
// assertion.

import { describe, expect, it } from "vitest";

import { PoolConfigError, runPool } from "./pool.mjs";

/**
 * A promise the test resolves by hand, standing in for a model call whose
 * completion order the test controls.
 *
 * @typedef {object} Gate
 * @property {Promise<void>} promise
 * @property {(value?: void) => void} resolve
 * @property {(reason?: unknown) => void} reject
 */

/** @returns {Gate} */
function deferred() {
  /** @type {(value?: void) => void} */
  let resolve = () => {};
  /** @type {(reason?: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yields the macro-task queue once, so every pending continuation of the
 * pool has run before the next assertion. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A worker that defers every call on its own gate, so the test chooses the
 * completion order. Calls are recorded in start order, each resolves to
 * `item * 10` when its gate is released, and the in-flight count is tracked
 * so a test can observe the cap being held.
 *
 * @returns {{
 *   started: number[],
 *   gates: Record<number, Gate>,
 *   maxInFlight: number,
 *   worker: (item: number, index: number) => Promise<number>,
 *   release: (index: number) => void,
 *   fail: (index: number, reason: unknown) => void,
 * }}
 */
function gated() {
  /** @type {number[]} */
  const started = [];
  /** @type {Record<number, Gate>} */
  const gates = {};
  let inFlight = 0;
  let maxInFlight = 0;

  /**
   * @param {number} item
   * @param {number} index
   * @returns {Promise<number>}
   */
  const worker = (item, index) => {
    started.push(index);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const gate = deferred();
    gates[index] = gate;
    return gate.promise
      .finally(() => {
        inFlight -= 1;
      })
      .then(() => item * 10);
  };

  return {
    started,
    gates,
    get maxInFlight() {
      return maxInFlight;
    },
    worker,
    /** @param {number} index */
    release(index) {
      gates[index]?.resolve();
    },
    /**
     * @param {number} index
     * @param {unknown} reason
     */
    fail(index, reason) {
      gates[index]?.reject(reason);
    },
  };
}

describe("runPool", () => {
  describe("concurrency cap", () => {
    it("starts exactly the cap synchronously and holds in-flight at it", async () => {
      const g = gated();
      const items = Array.from({ length: 10 }, (_, i) => i);
      const run = runPool(items, g.worker, { concurrency: 3 });

      // No completion has happened, yet no more than the cap has started:
      // the cap binds from the first moment, not only after a lane frees.
      expect(g.started).toEqual([0, 1, 2]);

      g.release(1);
      await settle();
      expect(g.started).toEqual([0, 1, 2, 3]);
      expect(g.maxInFlight).toBe(3);

      // Drain: release whatever gates exist, and the lanes they free start
      // the next items, until the input is exhausted.
      while (g.started.length < items.length) {
        for (const index of Object.keys(g.gates)) g.release(Number(index));
        await settle();
      }
      // The last pass only starts the tail; release what it left in flight.
      for (const index of Object.keys(g.gates)) g.release(Number(index));
      const outcome = await run;
      expect(outcome.results).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
      expect(outcome.errors).toEqual([]);
      expect(g.started).toHaveLength(10);
      expect(g.maxInFlight).toBe(3);
    });

    it("starts no more lanes than items when concurrency exceeds the item count", async () => {
      const g = gated();
      const run = runPool([5, 6], g.worker, { concurrency: 8 });

      expect(g.started).toEqual([0, 1]);

      g.release(0);
      g.release(1);
      const outcome = await run;
      expect(outcome.results).toEqual([50, 60]);
      expect(outcome.errors).toEqual([]);
      expect(g.maxInFlight).toBe(2);
    });
  });

  describe("result mapping", () => {
    it("maps each result to its input position regardless of completion order", async () => {
      const g = gated();
      const run = runPool([0, 1, 2, 3, 4], g.worker, { concurrency: 2 });

      // Complete in scrambled order: 1, 2, 0, 4, then 3.
      g.release(1);
      await settle();
      g.release(2);
      await settle();
      g.release(0);
      await settle();
      g.release(4);
      await settle();
      g.release(3);

      const outcome = await run;
      expect(g.started).toEqual([0, 1, 2, 3, 4]);
      expect(outcome.results).toEqual([0, 10, 20, 30, 40]);
      expect(outcome.errors).toEqual([]);
    });

    it("hands the worker each item and its position, resolving synchronously", async () => {
      const outcome = await runPool(["a", "b", "c"], (item, index) => `${item}${index}`, {
        concurrency: 2,
      });
      expect(outcome.results).toEqual(["a0", "b1", "c2"]);
      expect(outcome.errors).toEqual([]);
    });
  });

  describe('"collect" — the default', () => {
    it("captures a rejection and lets its siblings finish", async () => {
      const g = gated();
      const run = runPool([0, 1, 2, 3, 4], g.worker, { concurrency: 3 });

      // The failed item's lane is free at once and takes the next item —
      // collecting never stalls the pool.
      g.fail(1, new Error("boom one"));
      await settle();
      expect(g.started).toEqual([0, 1, 2, 3]);

      g.release(0);
      await settle();
      expect(g.started).toEqual([0, 1, 2, 3, 4]);

      for (const index of [2, 3, 4]) g.release(index);
      const outcome = await run;
      expect(outcome.results).toEqual([0, undefined, 20, 30, 40]);
      expect(outcome.errors).toEqual([{ index: 1, message: "boom one" }]);
    });

    it("reports a non-Error rejection as its string form", async () => {
      const g = gated();
      const run = runPool([0, 1, 2, 3], g.worker, { concurrency: 4 });

      g.fail(3, new Error("three"));
      g.fail(1, "raw one");
      g.release(0);
      g.release(2);

      const outcome = await run;
      expect(outcome.results).toEqual([0, undefined, 20, undefined]);
      // Recorded in index order, not completion order — the failed item at 3
      // was the first to settle.
      expect(outcome.errors).toEqual([
        { index: 1, message: "raw one" },
        { index: 3, message: "three" },
      ]);
    });

    it("captures a synchronous throw like any other rejection", async () => {
      /** @type {number[]} */
      const seen = [];
      const worker = /** @param {number} index */ (index) => {
        seen.push(index);
        if (index === 0) throw new Error("sync refusal");
        return index * 2;
      };
      const outcome = await runPool([0, 1, 2], worker, { concurrency: 3 });
      expect(seen).toEqual([0, 1, 2]);
      expect(outcome.results).toEqual([undefined, 2, 4]);
      expect(outcome.errors).toEqual([{ index: 0, message: "sync refusal" }]);
    });

    it("resolves empty for empty input, calling nothing", async () => {
      const g = gated();
      const outcome = await runPool([], g.worker, { concurrency: 2 });
      expect(outcome.results).toEqual([]);
      expect(outcome.errors).toEqual([]);
      expect(g.started).toEqual([]);
    });
  });

  describe('"fail-fast"', () => {
    it("starts nothing new after a rejection and still awaits the in-flight", async () => {
      const g = gated();
      const items = Array.from({ length: 6 }, (_, i) => i);
      const run = runPool(items, g.worker, { concurrency: 3, onError: "fail-fast" });

      expect(g.started).toEqual([0, 1, 2]);

      // Item 2 rejects while 0 and 1 are in flight; the two in-flight workers
      // are released and their results must still land.
      g.fail(2, new Error("stop here"));
      g.release(0);
      g.release(1);

      const outcome = await run;
      expect(g.started).toEqual([0, 1, 2]);
      expect(outcome.results).toEqual([0, 10, undefined, undefined, undefined, undefined]);
      expect(outcome.errors).toEqual([{ index: 2, message: "stop here" }]);
    });

    it("behaves like collect when nothing fails", async () => {
      const g = gated();
      const run = runPool([1, 2, 3], g.worker, { concurrency: 2, onError: "fail-fast" });

      g.release(0);
      await settle();
      g.release(1);
      g.release(2);

      const outcome = await run;
      expect(outcome.results).toEqual([10, 20, 30]);
      expect(outcome.errors).toEqual([]);
      expect(g.started).toEqual([0, 1, 2]);
    });
  });

  describe("configuration refusal", () => {
    it.each([0, -1, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", undefined])(
      "refuses concurrency %s",
      async (value) => {
        const g = gated();
        const options = /** @type {any} */ ({ concurrency: value });
        await expect(runPool([1, 2], g.worker, options)).rejects.toThrow(PoolConfigError);
        expect(g.started).toEqual([]);
      },
    );

    it("refuses options left out entirely — the pool has no default", async () => {
      const options = /** @type {any} */ (undefined);
      await expect(runPool([1], (item) => item, options)).rejects.toThrow(PoolConfigError);
    });

    it("refuses an unknown onError policy", async () => {
      const g = gated();
      const options = /** @type {any} */ ({ concurrency: 2, onError: "explode" });
      await expect(runPool([1], g.worker, options)).rejects.toThrow(PoolConfigError);
      expect(g.started).toEqual([]);
    });

    it("refuses a worker that is not a function", async () => {
      const worker = /** @type {any} */ ("not a function");
      await expect(runPool([1], worker, { concurrency: 2 })).rejects.toThrow(PoolConfigError);
    });

    it("refuses items that are not an array", async () => {
      const items = /** @type {any} */ ({ length: 2 });
      await expect(runPool(items, (item) => item, { concurrency: 2 })).rejects.toThrow(
        PoolConfigError,
      );
    });

    it("raises a typed error that carries its name", async () => {
      const options = /** @type {any} */ ({});
      const error = await runPool([1], (item) => item, options).then(
        () => {
          throw new Error("expected a refusal, got an outcome");
        },
        (caught) => caught,
      );
      expect(error).toBeInstanceOf(PoolConfigError);
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty("name", "PoolConfigError");
      expect(error).toHaveProperty("message", expect.stringContaining("positive integer"));
    });
  });
});
