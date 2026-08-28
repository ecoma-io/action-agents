// Tests for the `harmonise` deterministic failure/recovery policy.
//
// What is pinned: the declared sets are exactly what the doctrine states and
// are frozen; the classifier is total (it never throws, for anything a
// `catch` could catch) and conservative (untagged, mis-tagged, and foreign
// values land in `unknown`, never in a guessed retryable class); the status
// classifier maps the transport layer's own verdicts onto the declared
// classes and is equally total (an unrecognized status lands in `unknown`);
// every class, action and delay row of the default policy holds by its
// declared rule, including every boundary of the attempt range — and an
// out-of-range index is a decision (`exhausted`), never a crash; a
// caller-supplied policy that names anything this module did not declare is
// refused with `RecoveryPolicyError`, never coerced; and the delay table is
// fixed — an override spends retries, it does not invent delay names.

import { describe, expect, it } from "vitest";

import {
  AuthError,
  AUTH_STATUSES,
  DEFAULT_POLICY,
  DELAY_CLASSES,
  ERROR_CLASSES,
  FAILURE_CLASSES,
  RefusalError,
  RecoveryPolicyError,
  TransportError,
  classifyFailure,
  TRANSPORT_STATUSES,
  classFromStatus,
  delayClass,
  nextAction,
} from "./recovery.mjs";

/**
 * Routes a deliberately malformed value past the compiler, the way it
 * arrives at runtime from a caller the type system never saw.
 *
 * @template T
 * @param {unknown} value
 * @returns {T}
 */
const asAny = (value) => /** @type {T} */ (value);

describe("declared sets", () => {
  it("failure classes are exactly the doctrine's four, frozen", () => {
    expect([...FAILURE_CLASSES]).toEqual(["transport", "auth", "refusal", "unknown"]);
    expect(Object.isFrozen(FAILURE_CLASSES)).toBe(true);
  });

  it("delay names are exactly the doctrine's three, frozen", () => {
    expect([...DELAY_CLASSES]).toEqual(["immediate", "short", "long"]);
    expect(Object.isFrozen(DELAY_CLASSES)).toBe(true);
  });

  it("the raise surface is exactly the three concrete classes, frozen", () => {
    expect(Object.keys(ERROR_CLASSES)).toEqual(["transport", "auth", "refusal"]);
    expect(ERROR_CLASSES.transport).toBe(TransportError);
    expect(ERROR_CLASSES.auth).toBe(AuthError);
    expect(ERROR_CLASSES.refusal).toBe(RefusalError);
    expect(Object.isFrozen(ERROR_CLASSES)).toBe(true);
  });

  it("the default policy has a frozen row per declared class", () => {
    expect(Object.keys(DEFAULT_POLICY)).toEqual(["transport", "auth", "refusal", "unknown"]);
    expect(DEFAULT_POLICY.transport).toEqual({ retries: 2 });
    expect(DEFAULT_POLICY.auth).toEqual({ retries: 0 });
    expect(DEFAULT_POLICY.refusal).toEqual({ retries: 0 });
    expect(DEFAULT_POLICY.unknown).toEqual({ retries: 1 });
    expect(Object.isFrozen(DEFAULT_POLICY)).toBe(true);
    for (const row of Object.values(DEFAULT_POLICY)) {
      expect(Object.isFrozen(row)).toBe(true);
    }
  });
});

describe("error classes", () => {
  it("a TransportError carries the transport tag", () => {
    const error = new TransportError("provider unreachable");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TransportError");
    expect(error.message).toBe("provider unreachable");
    expect(error.failureClass).toBe("transport");
  });

  it("an AuthError carries the auth tag", () => {
    const error = new AuthError("token rejected");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AuthError");
    expect(error.message).toBe("token rejected");
    expect(error.failureClass).toBe("auth");
  });

  it("a RefusalError carries the refusal tag", () => {
    const error = new RefusalError("protected text refused");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RefusalError");
    expect(error.message).toBe("protected text refused");
    expect(error.failureClass).toBe("refusal");
  });
});

describe("classifyFailure", () => {
  it("classifies each declared error by what its constructor tagged", () => {
    expect(classifyFailure(new TransportError("blip"))).toBe("transport");
    expect(classifyFailure(new AuthError("bad token"))).toBe("auth");
    expect(classifyFailure(new RefusalError("guard tripped"))).toBe("refusal");
  });

  it("a declared instance keeps its constructor's class whatever a mutated field claims", () => {
    const mislabeled = new TransportError("blip");
    const mutable = /** @type {{ failureClass: unknown }} */ (mislabeled);
    mutable.failureClass = "auth";
    expect(classifyFailure(mislabeled)).toBe("transport");
  });

  it("a foreign error carrying a declared tag classifies by the tag", () => {
    const tagged = /** @type {Error & { failureClass?: unknown }} */ (new Error("down"));
    tagged.failureClass = "refusal";
    expect(classifyFailure(tagged)).toBe("refusal");
    expect(classifyFailure({ failureClass: "transport" })).toBe("transport");
  });

  it("an unrecognized tag is conservative: unknown, never a guessed class", () => {
    expect(classifyFailure({ failureClass: "bloated" })).toBe("unknown");
    expect(classifyFailure({ failureClass: "Transport" })).toBe("unknown");
    expect(classifyFailure({ failureClass: 7 })).toBe("unknown");
  });

  it("an untagged error or object is unknown", () => {
    expect(classifyFailure(new Error("boom"))).toBe("unknown");
    expect(classifyFailure(new TypeError("boom"))).toBe("unknown");
    expect(classifyFailure({})).toBe("unknown");
    expect(classifyFailure({ other: true })).toBe("unknown");
  });

  it("is total: anything a catch could catch classifies without throwing", () => {
    expect(classifyFailure(undefined)).toBe("unknown");
    expect(classifyFailure(null)).toBe("unknown");
    expect(classifyFailure("boom")).toBe("unknown");
    expect(classifyFailure(42)).toBe("unknown");
    expect(classifyFailure(true)).toBe("unknown");
    expect(classifyFailure(Symbol("boom"))).toBe("unknown");
  });
});

describe("classFromStatus", () => {
  it("the auth statuses are exactly the credentials failure, frozen", () => {
    expect([...AUTH_STATUSES]).toEqual([401, 403]);
    expect(Object.isFrozen(AUTH_STATUSES)).toBe(true);
  });

  it("the transport statuses mirror the transport layer's retryable set, frozen", () => {
    expect([...TRANSPORT_STATUSES]).toEqual([408, 425, 429, 500, 502, 503, 504]);
    expect(Object.isFrozen(TRANSPORT_STATUSES)).toBe(true);
  });

  it("a rejected or forbidden status names auth", () => {
    expect(classFromStatus(401)).toBe("auth");
    expect(classFromStatus(403)).toBe("auth");
  });

  it("a retryable provider-side status names transport", () => {
    for (const status of TRANSPORT_STATUSES) {
      expect(classFromStatus(status)).toBe("transport");
    }
  });

  it("a recognized but unlisted status is conservative: unknown", () => {
    expect(classFromStatus(400)).toBe("unknown");
    expect(classFromStatus(404)).toBe("unknown");
    expect(classFromStatus(409)).toBe("unknown");
    expect(classFromStatus(422)).toBe("unknown");
    expect(classFromStatus(418)).toBe("unknown");
  });

  it("is total over nonsense: anything that is not a declared status is unknown", () => {
    expect(classFromStatus(Number.NaN)).toBe("unknown");
    expect(classFromStatus(0)).toBe("unknown");
    expect(classFromStatus(99.5)).toBe("unknown");
    expect(classFromStatus(600)).toBe("unknown");
    expect(classFromStatus(-500)).toBe("unknown");
  });
});

describe("nextAction — default policy", () => {
  it("transport retries on the first two failures and is exhausted at the cap", () => {
    expect(nextAction("transport", 0)).toBe("retry");
    expect(nextAction("transport", 1)).toBe("retry");
    expect(nextAction("transport", 2)).toBe("exhausted");
  });

  it("transport past the declared range is exhausted — a decision, not a crash", () => {
    expect(nextAction("transport", -1)).toBe("exhausted");
    expect(nextAction("transport", 3)).toBe("exhausted");
  });

  it("auth gives up immediately — no retry changes what the token is", () => {
    expect(nextAction("auth", 0)).toBe("give-up");
  });

  it("auth past its zero-retry range is exhausted", () => {
    expect(nextAction("auth", 1)).toBe("exhausted");
  });

  it("refusal gives up immediately — the same content refuses identically again", () => {
    expect(nextAction("refusal", 0)).toBe("give-up");
  });

  it("refusal past its zero-retry range is exhausted", () => {
    expect(nextAction("refusal", 1)).toBe("exhausted");
  });

  it("unknown retries once — bounded optimism — then is exhausted", () => {
    expect(nextAction("unknown", 0)).toBe("retry");
    expect(nextAction("unknown", 1)).toBe("exhausted");
    expect(nextAction("unknown", 2)).toBe("exhausted");
  });

  it("a failure class outside the declared set gives up — no retry is spent on it", () => {
    expect(nextAction(asAny("bloated"), 0)).toBe("give-up");
  });

  it("an index that is not an integer in range is exhausted, never an exception", () => {
    for (const attemptIndex of [
      Number.NaN,
      0.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(nextAction("transport", attemptIndex)).toBe("exhausted");
    }
  });
});

describe("nextAction — policy overrides", () => {
  it("an override narrows one class and leaves the rest at their defaults", () => {
    const policy = { transport: { retries: 1 } };
    expect(nextAction("transport", 0, policy)).toBe("retry");
    expect(nextAction("transport", 1, policy)).toBe("exhausted");
    expect(nextAction("unknown", 1, policy)).toBe("exhausted");
  });

  it("an override can grant retries to a give-up class", () => {
    const policy = { refusal: { retries: 2 } };
    expect(nextAction("refusal", 0, policy)).toBe("retry");
    expect(nextAction("refusal", 1, policy)).toBe("retry");
    expect(nextAction("refusal", 2, policy)).toBe("exhausted");
  });

  it("an override can revoke a class's single retry, at the give-up boundary", () => {
    const policy = { unknown: { retries: 0 } };
    expect(nextAction("unknown", 0, policy)).toBe("give-up");
    expect(nextAction("unknown", 1, policy)).toBe("exhausted");
  });

  it("a zero-retry row and a past-range index decide differently: give-up vs exhausted", () => {
    expect(nextAction("auth", 0, { auth: { retries: 0 } })).toBe("give-up");
    expect(nextAction("auth", 1, { auth: { retries: 0 } })).toBe("exhausted");
  });
});

describe("nextAction — refused policies", () => {
  /** @param {unknown} policy @returns {() => RecoveryActionLike} */
  const decideWith = (policy) => () => nextAction("transport", 0, asAny(policy));

  it("an unknown class key is refused, naming the key and the declared set", () => {
    expect(decideWith({ bloated: { retries: 1 } })).toThrow(RecoveryPolicyError);
    expect(decideWith({ bloated: { retries: 1 } })).toThrow(
      /key "bloated" is not a declared failure class/,
    );
  });

  it("a row without exactly one `retries` field is refused", () => {
    expect(decideWith({ transport: {} })).toThrow(RecoveryPolicyError);
    expect(decideWith({ transport: { retries: 1, delay: 5 } })).toThrow(RecoveryPolicyError);
    expect(decideWith({ transport: null })).toThrow(RecoveryPolicyError);
    expect(decideWith({ transport: [1] })).toThrow(RecoveryPolicyError);
  });

  it("a retry count that is not a non-negative safe integer is refused", () => {
    for (const retries of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(decideWith({ transport: { retries } })).toThrow(RecoveryPolicyError);
    }
    expect(decideWith({ transport: { retries: "2" } })).toThrow(RecoveryPolicyError);
  });

  it("a policy that is not an object keyed by class is refused", () => {
    expect(decideWith("two")).toThrow(RecoveryPolicyError);
    expect(decideWith(42)).toThrow(RecoveryPolicyError);
    expect(decideWith(null)).toThrow(RecoveryPolicyError);
    expect(decideWith([{ retries: 1 }])).toThrow(RecoveryPolicyError);
  });

  it("refusal messages render the offending value — refused, not coerced", () => {
    expect(decideWith("two")).toThrow(/refused "two"/);
    expect(decideWith({ transport: { retries: "2" } })).toThrow(/refused "2"/);
  });
});

describe("delayClass — declared table", () => {
  it("transport backs off short then long", () => {
    expect(delayClass("transport", 0)).toBe("short");
    expect(delayClass("transport", 1)).toBe("long");
  });

  it("transport past its row names immediate — nothing is pending", () => {
    expect(delayClass("transport", 2)).toBe("immediate");
    expect(delayClass("transport", 7)).toBe("immediate");
    expect(delayClass("transport", -1)).toBe("immediate");
  });

  it("unknown waits short once", () => {
    expect(delayClass("unknown", 0)).toBe("short");
    expect(delayClass("unknown", 1)).toBe("immediate");
  });

  it("auth and refusal name immediate — they are never retried", () => {
    expect(delayClass("auth", 0)).toBe("immediate");
    expect(delayClass("refusal", 0)).toBe("immediate");
  });

  it("a class outside the declared set names immediate", () => {
    expect(delayClass(asAny("bloated"), 0)).toBe("immediate");
  });

  it("an index that is not an integer in range names immediate", () => {
    expect(delayClass("transport", Number.NaN)).toBe("immediate");
    expect(delayClass("transport", 0.5)).toBe("immediate");
  });

  it("an override spends retries but does not invent delay names past the row", () => {
    const policy = { transport: { retries: 5 } };
    expect(nextAction("transport", 4, policy)).toBe("retry");
    expect(delayClass("transport", 4)).toBe("immediate");
  });
});

describe("totality over the declared surfaces", () => {
  it("every class at every in-range-or-past index yields exactly one declared action and delay", () => {
    for (const failureClass of FAILURE_CLASSES) {
      for (let attemptIndex = -1; attemptIndex <= 5; attemptIndex++) {
        const action = nextAction(failureClass, attemptIndex);
        expect(["retry", "exhausted", "give-up"]).toContain(action);
        expect(DELAY_CLASSES).toContain(delayClass(failureClass, attemptIndex));
      }
    }
  });
});

/**
 * A named stand-in for the action union, so the helper above needs no import
 * cycle of types into this file's JSDoc.
 *
 * @typedef {"retry" | "exhausted" | "give-up"} RecoveryActionLike
 */
