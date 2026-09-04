// Tests for the triage run record — the pure module. The builder is proven
// byte-deterministic and fail-closed, the sanitiser passes are proven at the
// build sites (the validator is shape, not repair), the outcome vocabulary is
// pinned to the run contract's own words, and the filename rules are proven
// to land inside the upload glob.

import { describe, expect, it } from "vitest";

import {
  REASON_CHARS,
  TRIAGE_OUTCOMES,
  buildTriageRecord,
  serialiseTriageRecord,
  triageRecordFilename,
  triageRecordSchemaVersion,
  validateTriageRecord,
  VERIFICATION_VERDICTS,
} from "./run-record.mjs";

const SHA = "c".repeat(40);
const DIGEST = "b".repeat(64);
const TRUNCATION_MARK = "…[truncated]";

/**
 * The decision a sheet-mode run reaches, with a signal carrying a related
 * thread — the widest shape the record's decision section has.
 *
 * @param {Partial<import("./decision.mjs").Decision>} [over]
 * @returns {import("./decision.mjs").Decision}
 */
function decisionFixture(over = {}) {
  /** @type {import("./decision.mjs").Decision} */
  const decision = {
    kind: "labels",
    add: ["bug", "priority: high"],
    remove: [{ name: "needs triage", reason: "marker" }],
    refusals: ["not-on-sheet"],
    logs: [{ level: "info", text: "labels: +bug, +priority: high" }],
    rationale: "The report names a crash on save, so it is a bug and urgent.",
    comment: undefined,
    signal: {
      needsMoreInfo: ["steps to reproduce"],
      modelJudgedQuality: false,
      related: { number: 12, type: "duplicate", title: "Crash when\tthe file\n <!-- name -->" },
    },
  };
  return Object.assign(decision, over);
}

/**
 * @param {Partial<Parameters<typeof buildTriageRecord>[0]>} [over]
 * @returns {import("./run-record.mjs").TriageRecord}
 */
function recordFixture(over = {}) {
  return buildTriageRecord({
    repository: "octocat/example",
    eventName: "issues",
    eventAction: "labeled",
    threadType: "issue",
    threadNumber: 41,
    dryRun: false,
    model: "triage",
    policy: { basis: "base", branch: "main", sha: SHA },
    decision: decisionFixture(),
    outcome: "published",
    reason: "labels decision: 2 to add, 1 to remove, 1 refused, 1 signal comment",
    ...over,
  });
}

/**
 * A mutable copy of a valid record, for validator refusal tests: the built
 * record is frozen, so the clone is what gets malformed. The decision
 * section arrives pre-cast, since a clone's `decision` is unknown to the
 * reader even when the record carries it.
 *
 * @param {(record: Record<string, unknown>, decision: Record<string, unknown>) => void} breakIt
 * @returns {Record<string, unknown>}
 */
function malformed(breakIt) {
  const clone = /** @type {Record<string, unknown>} */ (
    JSON.parse(serialiseTriageRecord(recordFixture()))
  );
  breakIt(clone, /** @type {Record<string, unknown>} */ (clone["decision"]));
  return clone;
}

describe("buildTriageRecord", () => {
  it("builds the expected record from valid run facts", () => {
    const record = recordFixture();
    expect(record).toEqual({
      schemaVersion: 1,
      repository: "octocat/example",
      event: { eventName: "issues", action: "labeled" },
      thread: { type: "issue", number: 41 },
      dryRun: false,
      model: "triage",
      policy: { basis: "base", branch: "main", sha: SHA },
      decision: {
        kind: "labels",
        add: ["bug", "priority: high"],
        remove: [{ name: "needs triage", reason: "marker" }],
        refusals: ["not-on-sheet"],
        rationale: "The report names a crash on save, so it is a bug and urgent.",
        signal: {
          needsMoreInfo: ["steps to reproduce"],
          modelJudgedQuality: false,
          related: { number: 12, type: "duplicate", title: "Crash when the file  name " },
        },
      },
      outcome: "published",
      reason: "labels decision: 2 to add, 1 to remove, 1 refused, 1 signal comment",
      verification: { requested: false, answers: [], downgraded: [] },
    });
  });

  it("omits the decision key when the run ended before decide()", () => {
    const record = recordFixture({
      decision: null,
      outcome: "failed",
      reason: "the pin did not resolve",
    });
    expect("decision" in record).toBe(false);
    expect(record.outcome).toBe("failed");
  });

  it("carries an abandoned run: the superseded decision stays, the divergence reason rides as the reason", () => {
    const reason = "the head is now bbbbbbbbbbbbbb, not the aaaaaaaaaaaaaaa this run read";
    const record = recordFixture({ outcome: "abandoned", reason });
    expect(record.outcome).toBe("abandoned");
    expect(record.decision).toBeDefined();
    expect(record.reason).toBe(reason);
    // Byte-determinism holds for this outcome too: the same run facts build
    // the same bytes, and the validator accepts the shape.
    expect(serialiseTriageRecord(record)).toBe(
      serialiseTriageRecord(recordFixture({ outcome: "abandoned", reason })),
    );
    expect(() => validateTriageRecord(JSON.parse(serialiseTriageRecord(record)))).not.toThrow();
  });

  it("carries a thread-less, policy-less record for a run that died before the payload parsed", () => {
    const record = recordFixture({
      eventAction: "",
      threadType: null,
      threadNumber: null,
      policy: null,
      decision: null,
      outcome: "failed",
      reason: "the event payload carries no 'issue' object",
    });
    expect(record.thread).toBeNull();
    expect(record.policy).toBeNull();
    expect(triageRecordFilename(record)).toBe("triage-record-issues.json");
  });

  it("carries the frozen verification block it is given", () => {
    const record = recordFixture({
      verification: {
        requested: true,
        answers: [{ opId: "add:bug", verdict: "confirmed", reasonDigest: DIGEST }],
        downgraded: ["remove:needs triage"],
      },
    });
    expect(record.verification).toEqual({
      requested: true,
      answers: [{ opId: "add:bug", verdict: "confirmed", reasonDigest: DIGEST }],
      downgraded: ["remove:needs triage"],
    });
  });

  it("is frozen — the code's record is not mutable by a consumer", () => {
    expect(Object.isFrozen(recordFixture())).toBe(true);
  });

  it("serialises to byte-identical JSON across two builds — no wall-clock anywhere", () => {
    const first = serialiseTriageRecord(recordFixture());
    const second = serialiseTriageRecord(recordFixture());
    expect(second).toBe(first);
    // Compact: no whitespace outside strings, no trailing newline.
    expect(first.endsWith("}")).toBe(true);
    expect(first).not.toContain("\n");
    expect(JSON.parse(first)).toEqual(recordFixture());
  });

  it("serialises with the keys sorted, so the byte order is the byte order", () => {
    const keys = Object.keys(JSON.parse(serialiseTriageRecord(recordFixture())));
    expect(keys).toEqual([...keys].sort());
  });

  it("round-trips validation — the serialiser validates before it writes bytes", () => {
    expect(validateTriageRecord(JSON.parse(serialiseTriageRecord(recordFixture())))).toBeTruthy();
  });

  it("caps model text at the build site, visibly", () => {
    const record = recordFixture({ reason: "r".repeat(REASON_CHARS + 200) });
    expect(record.reason.length).toBe(REASON_CHARS);
    expect(record.reason.endsWith(TRUNCATION_MARK)).toBe(true);
  });
});

describe("buildTriageRecord sanitisation at the build sites", () => {
  it("passes the rationale through the comment sanitiser: no structural token, no parsing mention", () => {
    const rationale =
      "Crash on save. <!-- action-agents:triage --> cc @octocat read <script>alert(1)</script>";
    const record = recordFixture({ decision: decisionFixture({ rationale }) });
    const decision = /** @type {import("./run-record.mjs").RecordDecision} */ (record.decision);
    expect(decision.rationale).not.toContain("<!--");
    expect(decision.rationale).not.toContain("-->");
    expect(decision.rationale).toContain("@‌octocat");
    expect(decision.rationale).toContain("&lt;script>alert(1)&lt;/script>");
  });

  it("flattens a multi-line rationale to one line", () => {
    const record = recordFixture({
      decision: decisionFixture({ rationale: "first line\nsecond line" }),
    });
    const decision = /** @type {import("./run-record.mjs").RecordDecision} */ (record.decision);
    expect(decision.rationale).toBe("first line second line");
  });

  it("sanitises a related title the way signalBody does: one line, no marker, no parsing mention", () => {
    const title = "Dup\tline\n <!-- forged --> and @someone";
    const record = recordFixture({
      decision: decisionFixture({
        signal: {
          needsMoreInfo: [],
          modelJudgedQuality: true,
          related: { number: 12, type: "duplicate", title },
        },
      }),
    });
    const signal = /** @type {import("./run-record.mjs").RecordSignal} */ (
      /** @type {import("./run-record.mjs").RecordDecision} */ (record.decision).signal
    );
    const related = /** @type {NonNullable<import("./run-record.mjs").RecordSignal["related"]>} */ (
      signal.related
    );
    expect(related.title).not.toContain("<!--");
    expect(related.title).toContain("@‌someone");
    expect(related.title.length).toBeLessThanOrEqual(80);
    expect(related.title).toBe("Dup line  forged  and @‌someone");
  });
});

describe("validateTriageRecord refusals", () => {
  it("refuses an unknown top-level key", () => {
    expect(() => validateTriageRecord(malformed((r) => (r["extra"] = true)))).toThrow(
      /unknown key 'extra'/u,
    );
  });

  it("refuses a missing mandatory key", () => {
    expect(() => validateTriageRecord(malformed((r) => delete r["reason"]))).toThrow(
      /missing 'reason'/u,
    );
  });

  it("refuses an outcome outside the run contract's terminal states", () => {
    expect(() => validateTriageRecord(malformed((r) => (r["outcome"] = "succeeded")))).toThrow(
      /outside the run contract's terminal states/u,
    );
  });

  it("refuses a wrong schemaVersion", () => {
    expect(() => validateTriageRecord(malformed((r) => (r["schemaVersion"] = 2)))).toThrow(
      /schemaVersion/u,
    );
  });

  it("refuses an event that is not the two-key shape", () => {
    expect(() =>
      validateTriageRecord(malformed((r) => (r["event"] = { eventName: "issues" }))),
    ).toThrow(/'event' is missing 'action'/u);
    expect(() =>
      validateTriageRecord(
        malformed((r) => {
          const event = /** @type {Record<string, unknown>} */ (r["event"]);
          event["action"] = 3;
        }),
      ),
    ).toThrow(/'event.action' is not a string/u);
  });

  it("refuses a partial thread but accepts the honest null", () => {
    expect(() => validateTriageRecord(malformed((r) => (r["thread"] = { type: "pr" })))).toThrow(
      /'thread' is missing 'number'/u,
    );
    expect(() =>
      validateTriageRecord(malformed((r) => (r["thread"] = { type: "note", number: 4 }))),
    ).toThrow(/neither 'issue' nor 'pr'/u);
    expect(() => validateTriageRecord(malformed((r) => (r["thread"] = null)))).not.toThrow();
  });

  it("refuses a policy pin whose sha is not 40 hex", () => {
    expect(() =>
      validateTriageRecord(
        malformed((r) => (r["policy"] = { basis: "base", branch: "main", sha: "abc" })),
      ),
    ).toThrow(/not a 40-hex commit sha/u);
  });

  it("refuses a decision carrying an executor field — the log lines stay the log's", () => {
    expect(() => validateTriageRecord(malformed((_r, d) => (d["logs"] = [])))).toThrow(
      /unknown key 'logs'/u,
    );
  });

  it("refuses a rationale over its cap", () => {
    expect(() =>
      validateTriageRecord(malformed((_r, d) => (d["rationale"] = "x".repeat(301)))),
    ).toThrow(/exceeds its 300-character cap/u);
  });

  it("refuses a reason over its cap", () => {
    expect(() =>
      validateTriageRecord(malformed((r) => (r["reason"] = "x".repeat(REASON_CHARS + 1)))),
    ).toThrow(/exceeds its 300-character cap/u);
  });

  it("validates the verification block it delegates to — good, extra key, bogus opId, bad verdict, bad digest", () => {
    expect(() =>
      validateTriageRecord(
        malformed((r) => (r["verification"] = { requested: false, answers: [], downgraded: [] })),
      ),
    ).not.toThrow();
    expect(() =>
      validateTriageRecord(
        malformed((r) => (r["verification"] = { requested: false, answers: [], extra: 1 })),
      ),
    ).toThrow(/other than requested\/answers\/downgraded/u);
    expect(() =>
      validateTriageRecord(
        malformed(
          (r) =>
            (r["verification"] = {
              requested: true,
              answers: [{ opId: "add bug", verdict: "confirmed", reasonDigest: DIGEST }],
              downgraded: [],
            }),
        ),
      ),
    ).toThrow(/opId is outside the code-minted vocabulary/u);
    expect(() =>
      validateTriageRecord(
        malformed(
          (r) =>
            (r["verification"] = {
              requested: true,
              answers: [{ opId: "add:bug", verdict: "sure", reasonDigest: DIGEST }],
              downgraded: [],
            }),
        ),
      ),
    ).toThrow(/verdict is outside the closed vocabulary/u);
    expect(() =>
      validateTriageRecord(
        malformed(
          (r) =>
            (r["verification"] = {
              requested: true,
              answers: [{ opId: "add:bug", verdict: "confirmed", reasonDigest: "zz" }],
              downgraded: [],
            }),
        ),
      ),
    ).toThrow(/not a well-formed digest/u);
  });
});

describe("triageRecordFilename", () => {
  it("names a thread's records after the thread, overwriting in place", () => {
    expect(triageRecordFilename(recordFixture({ threadType: "issue", threadNumber: 41 }))).toBe(
      "triage-record-issue-41.json",
    );
    expect(triageRecordFilename(recordFixture({ threadType: "pr", threadNumber: 7 }))).toBe(
      "triage-record-pr-7.json",
    );
  });

  it("names a pre-thread record after the event", () => {
    expect(triageRecordFilename(recordFixture({ threadType: null, threadNumber: null }))).toBe(
      "triage-record-issues.json",
    );
  });

  it("flattens an unsafe event name into the upload glob, never out of the directory", () => {
    const file = triageRecordFilename(
      recordFixture({ eventName: "weird/../name", threadType: null, threadNumber: null }),
    );
    expect(file).toBe("triage-record-weird-..-name.json");
    expect(file).toMatch(/^triage-record-.*\.json$/u);
    expect(file).not.toContain("/");
  });

  it("keeps every name inside the workflow's upload glob", () => {
    const records = [
      recordFixture(),
      recordFixture({ threadType: "pr", threadNumber: 7 }),
      recordFixture({ threadType: null, threadNumber: null, eventName: "pull_request" }),
      recordFixture({ threadType: null, threadNumber: null, eventName: "workflow run" }),
    ];
    for (const record of records) {
      expect(triageRecordFilename(record)).toMatch(/^triage-record-.*\.json$/u);
    }
  });
});

describe("the record's vocabulary is the run contract's", () => {
  it("carries the six terminal states, whole and in the contract's order", () => {
    expect([...TRIAGE_OUTCOMES]).toEqual([
      "published",
      "partial",
      "refused",
      "abandoned",
      "skip",
      "failed",
    ]);
  });

  it("pins the schema version the docs state", () => {
    expect(triageRecordSchemaVersion).toBe(1);
  });

  it("keeps the verification verdicts the frozen list issue #274 froze", () => {
    expect([...VERIFICATION_VERDICTS]).toEqual(["confirmed", "refuted", "uncertain"]);
  });
});
