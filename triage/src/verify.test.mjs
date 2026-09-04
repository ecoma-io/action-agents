// Tests for the opt-in verification pass — the module that sits between the
// decision and any write. The chat seam is stubbed, so what these tests pin
// is the pass's own contract: op ids minted by code, one bounded call with
// no retry, an answer judged fail-closed against the closed vocabularies,
// and a downgrade-only filter that can only remove.

import { describe, expect, it } from "vitest";

import { createEvidence } from "#core/untrusted.mjs";

import { REASON_CHARS, isOpId, validateVerificationBlock } from "./run-record.mjs";
import {
  REFUSAL_CHARS,
  VERIFICATION_REASON_CHARS,
  applyVerification,
  judgeVerificationAnswer,
  mintVerificationPlan,
  reasonDigest,
  refusalLine,
  verifyDecision,
  verifierMessages,
} from "./verify.mjs";

/**
 * A labels decision with two adds and one marker clear — the widest plan a
 * sheet-mode run mints.
 *
 * @param {Partial<import("./decision.mjs").Decision>} [over]
 * @returns {import("./decision.mjs").Decision}
 */
function decisionFixture(over = {}) {
  /** @type {import("./decision.mjs").Decision} */
  const decision = {
    kind: "labels",
    add: ["bug", "docs"],
    remove: [{ name: "needs triage", reason: "marker" }],
    refusals: [],
    logs: [],
    rationale: "The report names a crash on save.",
    comment: undefined,
    signal: null,
  };
  return Object.assign(decision, over);
}

/** The widest plan, as `mintVerificationPlan(decisionFixture())` spells it. */
const WIDE_PLAN = {
  ops: [
    { opId: "add:bug", description: "apply the label 'bug'" },
    { opId: "add:docs", description: "apply the label 'docs'" },
    { opId: "remove:needs triage", description: "remove the label 'needs triage' (marker)" },
  ],
};

/** The one-op plan the answer-contract tests judge. */
const ONE_OP_PLAN = { ops: [{ opId: "add:bug", description: "apply the label 'bug'" }] };

/**
 * A chat seam that counts every ask and answers each with one scripted
 * content — the counter is what pins one bounded call, no retry.
 *
 * @param {{ content?: string, throwOnAsk?: Error }} [options]
 */
function chatStub(options = {}) {
  let calls = 0;
  /** @type {import("#core/chat.mjs").ChatMessage[][]} */
  const asks = [];
  return {
    calls: () => calls,
    asks: () => asks,
    /**
     * @param {{ model: string, messages: import("#core/chat.mjs").ChatMessage[] }} ask
     */
    async complete(ask) {
      calls++;
      asks.push(ask.messages);
      if (options.throwOnAsk) throw options.throwOnAsk;
      return { content: options.content ?? "", toolCalls: [], finishReason: undefined };
    },
  };
}

/** @type {import("./evidence.mjs").ThreadEvidence} */
const THREAD = {
  type: "issue",
  number: 7,
  title: "Import fails on Node 24",
  body: "Steps to reproduce.",
  labels: ["triage"],
  createdAt: "2026-01-01T00:00:00Z",
  creator: "someone",
  state: "open",
};

describe("mintVerificationPlan", () => {
  it("mints one id per concrete op, in decision order", () => {
    const plan = mintVerificationPlan(decisionFixture());
    expect(plan.ops.map((op) => op.opId)).toEqual(["add:bug", "add:docs", "remove:needs triage"]);
    expect(plan.ops[0]?.description).toBe("apply the label 'bug'");
    expect(plan.ops[2]?.description).toBe("remove the label 'needs triage' (marker)");
  });

  it("a label containing a colon stays one parseable id", () => {
    // The id grammar is `add:`-prefixed with the label verbatim after it, so
    // a colon inside a label cannot split the id in two.
    const plan = mintVerificationPlan(decisionFixture({ add: ["priority: high"], remove: [] }));
    expect(plan.ops.map((op) => op.opId)).toEqual(["add:priority: high"]);
    expect(isOpId("add:priority: high")).toBe(true);
    expect(plan.ops[0]?.description).toBe("apply the label 'priority: high'");
  });

  it("the comment kind mints the bare comment op, and no label ops", () => {
    const plan = mintVerificationPlan(
      decisionFixture({
        kind: "comment",
        add: [],
        remove: [],
        comment: { classification: "bug report", rationale: "r" },
      }),
    );
    expect(plan.ops.map((op) => op.opId)).toEqual(["comment"]);
    expect(isOpId("comment")).toBe(true);
    expect(plan.ops[0]?.description).toContain("comment");
  });

  it("mints no op for a decision that proposes nothing", () => {
    const plan = mintVerificationPlan(decisionFixture({ add: [], remove: [] }));
    expect(plan.ops).toEqual([]);
  });
});

describe("verifierMessages", () => {
  it("the contract is the system message and names the closed verdict vocabulary", () => {
    const messages = verifierMessages(WIDE_PLAN, THREAD);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain('"confirmed"|"refuted"|"uncertain"');
    expect(messages[1]?.role).toBe("user");
  });

  it("the thread snapshot sits inside the evidence wrap, the plan outside it", () => {
    const messages = verifierMessages(
      WIDE_PLAN,
      THREAD,
      createEvidence(() => "aaaabbbb"),
    );
    const content = messages[1]?.content ?? "";
    expect(content).toContain("title: Import fails on Node 24");
    expect(content).toContain("labels the thread carries: triage");
    expect(content.indexOf("[end-evidence:aaaabbbb]")).toBeLessThan(
      content.indexOf("Proposed operations:"),
    );
  });

  it("restates every plan op with its id and what it does", () => {
    const messages = verifierMessages(
      WIDE_PLAN,
      THREAD,
      createEvidence(() => "aaaabbbb"),
    );
    const content = messages[1]?.content ?? "";
    for (const op of WIDE_PLAN.ops) {
      expect(content).toContain(`- ${op.opId}: ${op.description}`);
    }
  });
});

describe("judgeVerificationAnswer", () => {
  it("a well-formed answer judges each op with its own verdict and reason", () => {
    const content = JSON.stringify([
      { opId: "add:bug", verdict: "confirmed", reason: "The report is a crash." },
      { opId: "add:docs", verdict: "refuted", reason: "Nothing here is about docs." },
      { opId: "remove:needs triage", verdict: "uncertain", reason: "Cannot tell." },
    ]);
    const { block, judged, notes } = judgeVerificationAnswer(content, WIDE_PLAN);

    expect(notes).toEqual([]);
    expect(judged.map((op) => [op.opId, op.verdict, op.reason])).toEqual([
      ["add:bug", "confirmed", "The report is a crash."],
      ["add:docs", "refuted", "Nothing here is about docs."],
      ["remove:needs triage", "uncertain", "Cannot tell."],
    ]);
    expect(block.requested).toBe(true);
    expect(block.downgraded).toEqual(["add:docs", "remove:needs triage"]);
    expect(block.answers.map((answer) => answer.reasonDigest)).toEqual([
      reasonDigest("The report is a crash."),
      reasonDigest("Nothing here is about docs."),
      reasonDigest("Cannot tell."),
    ]);
    // The block is the record's own frozen shape, exactly as the scaffold
    // typed it — filling it never reshapes it.
    expect(validateVerificationBlock(block)).toBe(block);
  });

  it("the digests are the sha256 of the reason text the verdict held", () => {
    const { block } = judgeVerificationAnswer(
      JSON.stringify([{ opId: "add:bug", verdict: "confirmed", reason: "digest me" }]),
      ONE_OP_PLAN,
    );
    expect(block.answers).toHaveLength(1);
    expect(block.answers[0]?.reasonDigest).toBe(reasonDigest("digest me"));
    expect(isOpId(block.answers[0]?.opId)).toBe(true);
  });

  it("a fenced answer still parses — the contract is shape, not framing", () => {
    const content =
      "```json\n" +
      JSON.stringify([{ opId: "add:bug", verdict: "confirmed", reason: "yes" }]) +
      "\n```";
    const { judged } = judgeVerificationAnswer(content, ONE_OP_PLAN);
    expect(judged[0]?.verdict).toBe("confirmed");
  });

  it("an entry missing the opId key judges nothing — a judgment pair is not an answer", () => {
    const { judged, notes } = judgeVerificationAnswer(
      JSON.stringify([{ verdict: "confirmed", reason: "r" }]),
      WIDE_PLAN,
    );
    expect(judged.map((op) => op.verdict)).toEqual(["uncertain", "uncertain", "uncertain"]);
    expect(notes).toHaveLength(1);
  });

  it("an entry carrying an extra key judges nothing", () => {
    const { judged } = judgeVerificationAnswer(
      JSON.stringify([{ opId: "add:bug", verdict: "confirmed", reason: "r", extra: 1 }]),
      WIDE_PLAN,
    );
    expect(judged[0]?.verdict).toBe("uncertain");
  });

  it("an opId outside the plan confirms nothing — every op it skips stays uncertain", () => {
    const { judged, notes } = judgeVerificationAnswer(
      JSON.stringify([{ opId: "add:admin", verdict: "confirmed", reason: "r" }]),
      WIDE_PLAN,
    );
    expect(judged.map((op) => op.verdict)).toEqual(["uncertain", "uncertain", "uncertain"]);
    expect(notes.join("\n")).toContain("not an operation in the plan");
  });

  it("an off-vocabulary verdict leaves its op uncertain", () => {
    const { judged } = judgeVerificationAnswer(
      JSON.stringify([{ opId: "add:bug", verdict: "probably", reason: "r" }]),
      ONE_OP_PLAN,
    );
    expect(judged[0]?.verdict).toBe("uncertain");
    expect(judged[0]?.reason).toContain("outside the closed vocabulary");
  });

  it("a reason over the 300-character cap leaves its op uncertain", () => {
    expect(VERIFICATION_REASON_CHARS).toBe(300);
    const { judged } = judgeVerificationAnswer(
      JSON.stringify([{ opId: "add:bug", verdict: "confirmed", reason: "a".repeat(301) }]),
      ONE_OP_PLAN,
    );
    expect(judged[0]?.verdict).toBe("uncertain");
    expect(judged[0]?.reason).toContain("cap");
  });

  it("a reason that is not a string leaves its op uncertain", () => {
    const { judged } = judgeVerificationAnswer(
      JSON.stringify([{ opId: "add:bug", verdict: "confirmed", reason: 7 }]),
      ONE_OP_PLAN,
    );
    expect(judged[0]?.verdict).toBe("uncertain");
  });

  it("an entry that is not an object is ignored", () => {
    const { judged, notes } = judgeVerificationAnswer(JSON.stringify(["confirmed"]), ONE_OP_PLAN);
    expect(judged[0]?.verdict).toBe("uncertain");
    expect(notes).toHaveLength(1);
  });

  it("an unparseable answer leaves every op uncertain, without throwing", () => {
    const { judged, notes, block } = judgeVerificationAnswer("no json here at all", WIDE_PLAN);
    expect(judged.map((op) => op.verdict)).toEqual(["uncertain", "uncertain", "uncertain"]);
    expect(notes.join("\n")).toContain("did not parse");
    expect(block.downgraded).toEqual(["add:bug", "add:docs", "remove:needs triage"]);
    expect(validateVerificationBlock(block)).toBe(block);
  });

  it("an answer that is not an array is the same disposition", () => {
    const content = JSON.stringify({ opId: "add:bug", verdict: "confirmed", reason: "r" });
    const { judged, notes } = judgeVerificationAnswer(content, WIDE_PLAN);
    expect(judged.map((op) => op.verdict)).toEqual(["uncertain", "uncertain", "uncertain"]);
    expect(notes.join("\n")).toContain("not a JSON array");
  });

  it("silence — an empty array — is not confirmation: every op stays uncertain", () => {
    const { judged, notes } = judgeVerificationAnswer("[]", WIDE_PLAN);
    expect(judged.map((op) => op.verdict)).toEqual(["uncertain", "uncertain", "uncertain"]);
    expect(judged.every((op) => op.reason.length > 0)).toBe(true);
    expect(notes).toEqual([]);
  });

  it("an empty-string reason is a string under the cap and judges", () => {
    const { judged } = judgeVerificationAnswer(
      JSON.stringify([{ opId: "add:bug", verdict: "confirmed", reason: "" }]),
      { ops: [{ opId: "add:bug", description: "apply the label 'bug'" }] },
    );
    expect(judged[0]?.verdict).toBe("confirmed");
    expect(judged[0]?.reason).toBe("");
  });

  it("a later valid entry for the same op replaces the earlier one — entries apply in order", () => {
    const { judged } = judgeVerificationAnswer(
      JSON.stringify([
        { opId: "add:bug", verdict: "refuted", reason: "first look" },
        { opId: "add:bug", verdict: "confirmed", reason: "second look" },
      ]),
      { ops: [{ opId: "add:bug", description: "apply the label 'bug'" }] },
    );
    expect(judged[0]?.verdict).toBe("confirmed");
    expect(judged[0]?.reason).toBe("second look");
  });
});

describe("verifyDecision", () => {
  it("an empty plan asks for nothing — no call, no answers, nothing downgraded", async () => {
    const chat = chatStub();
    const { block, judged } = await verifyDecision({
      plan: { ops: [] },
      thread: THREAD,
      chat,
      model: "gpt-x",
    });
    expect(chat.calls()).toBe(0);
    expect(judged).toEqual([]);
    expect(block).toEqual({ requested: true, answers: [], downgraded: [] });
  });

  it("makes exactly one call and never a second, even on a garbage answer", async () => {
    const chat = chatStub({ content: "garbage" });
    const { judged, notes } = await verifyDecision({
      plan: WIDE_PLAN,
      thread: THREAD,
      chat,
      model: "gpt-x",
    });
    expect(chat.calls()).toBe(1);
    expect(judged.map((op) => op.verdict)).toEqual(["uncertain", "uncertain", "uncertain"]);
    expect(notes.join("\n")).toContain("did not parse");
  });

  it("the one call carries the contract and the plan against the thread snapshot", async () => {
    const chat = chatStub({ content: "[]" });
    await verifyDecision({ plan: WIDE_PLAN, thread: THREAD, chat, model: "gpt-x" });
    const messages = chat.asks()[0] ?? [];
    expect(chat.asks()[0]?.[0]?.content).toContain('"confirmed"|"refuted"|"uncertain"');
    expect(messages[1]?.content).toContain("- add:bug: apply the label 'bug'");
    expect(messages[1]?.content).toContain("title: Import fails on Node 24");
  });

  it("a throw out of the call is the same disposition — all uncertain, nothing escapes", async () => {
    const chat = chatStub({ throwOnAsk: new Error("socket hang up") });
    const { judged, notes, block } = await verifyDecision({
      plan: WIDE_PLAN,
      thread: THREAD,
      chat,
      model: "gpt-x",
    });
    expect(judged.map((op) => op.verdict)).toEqual(["uncertain", "uncertain", "uncertain"]);
    expect(judged[0]?.reason).toContain("the verify call did not answer");
    expect(notes.join("\n")).toContain("the verify call did not answer");
    expect(block.downgraded).toEqual(["add:bug", "add:docs", "remove:needs triage"]);
    expect(validateVerificationBlock(block)).toBe(block);
  });
});

describe("applyVerification", () => {
  /** @type {import("./verify.mjs").JudgedOp[]} */
  const MIXED = [
    { opId: "add:bug", verdict: "confirmed", reason: "The report is a crash." },
    { opId: "add:docs", verdict: "refuted", reason: "Nothing here is about docs." },
    { opId: "remove:needs triage", verdict: "uncertain", reason: "Cannot tell." },
  ];

  it("a confirmed op stands; a refuted or uncertain one is downgraded to a refusal", () => {
    const { decision, downgraded } = applyVerification(decisionFixture(), WIDE_PLAN, MIXED);
    expect(decision.add).toEqual(["bug"]);
    expect(decision.remove).toEqual([]);
    expect(downgraded).toEqual(["add:docs", "remove:needs triage"]);
    expect(decision.refusals).toEqual([
      "verification downgraded 'add:docs' (refuted): Nothing here is about docs.",
      "verification downgraded 'remove:needs triage' (uncertain): Cannot tell.",
    ]);
  });

  it("each downgraded op also leaves one warning log line", () => {
    const { decision } = applyVerification(decisionFixture(), WIDE_PLAN, MIXED);
    expect(decision.logs.map((log) => [log.level, log.text])).toEqual([
      ["warning", expect.stringContaining("verification refuted 'add:docs'")],
      ["warning", expect.stringContaining("verification uncertain 'remove:needs triage'")],
    ]);
  });

  it("an op the pass never judged is dropped, and the drop is recorded as a refusal", () => {
    const { decision, downgraded } = applyVerification(decisionFixture(), WIDE_PLAN, []);
    expect(decision.add).toEqual([]);
    expect(decision.remove).toEqual([]);
    expect(downgraded).toEqual(["add:bug", "add:docs", "remove:needs triage"]);
    expect(decision.refusals.every((line) => line.includes("no valid entry"))).toBe(true);
  });

  it("every op downgraded leaves nothing to write, with the refusals carried", () => {
    /** @type {import("./verify.mjs").JudgedOp[]} */
    const allUncertain = WIDE_PLAN.ops.map((op) => ({
      opId: op.opId,
      verdict: "uncertain",
      reason: "no evidence either way",
    }));
    const { decision, downgraded } = applyVerification(decisionFixture(), WIDE_PLAN, allUncertain);
    expect(downgraded).toHaveLength(3);
    expect(decision.add).toEqual([]);
    expect(decision.remove).toEqual([]);
    expect(decision.refusals).toHaveLength(3);
    expect(decision.refusals.every((line) => line.includes("no evidence either way"))).toBe(true);
  });

  it("the input decision is untouched — the filter is pure", () => {
    const decision = decisionFixture();
    const before = JSON.parse(JSON.stringify(decision));
    applyVerification(decision, WIDE_PLAN, MIXED);
    expect(JSON.parse(JSON.stringify(decision))).toEqual(before);
  });

  it("a signal the decision composed rides through the filter untouched", () => {
    const signal = { needsMoreInfo: ["steps"], modelJudgedQuality: false, related: null };
    const { decision } = applyVerification(decisionFixture({ signal }), WIDE_PLAN, MIXED);
    expect(decision.signal).toEqual(signal);
  });
});

describe("refusalLine", () => {
  it("names the op id, the verdict and the verifier's reason", () => {
    expect(refusalLine("add:bug", "refuted", "The evidence contradicts it.")).toBe(
      "verification downgraded 'add:bug' (refuted): The evidence contradicts it.",
    );
  });

  it("an empty reason reads as no reason given, not as an empty entry", () => {
    expect(refusalLine("comment", "uncertain", "")).toBe(
      "verification downgraded 'comment' (uncertain): no reason given",
    );
  });

  it("a hostile reason is sanitised: no raw HTML, no live mention, one line", () => {
    const line = refusalLine("add:bug", "refuted", "<script>alert(1)</script>\ncc @maintainer");
    expect(line).not.toContain("<script>");
    expect(line).not.toMatch(/@maintainer/u);
    expect(line).not.toContain("\n");
    expect(line).toContain("verification downgraded 'add:bug' (refuted):");
  });

  it("the refusal width is the record's own reason width, and a long reason is capped inside it", () => {
    expect(REFUSAL_CHARS).toBe(REASON_CHARS);
    const line = refusalLine("add:bug", "uncertain", "a".repeat(400));
    expect(line.length).toBeLessThanOrEqual(REFUSAL_CHARS);
    expect(line).toContain("…[truncated]");
  });
});
