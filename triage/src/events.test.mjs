import { describe, expect, it } from "vitest";
import {
  ISSUE_ACTIONS,
  PULL_REQUEST_ACTIONS,
  decideEvent,
  eventAuditLine,
  eventChangedLabel,
} from "./events.mjs";

/**
 * The event matrix (item 1 of #224): `issues` and `pull_request` events are
 * classified `retriage` when they could have changed triage-relevant
 * evidence, `skip` otherwise. The decision uses only payload facts and the
 * policy's own declarations, and a skip's audit line is its whole trace.
 */

const ROLES = new Map([
  ["bug", "semantic-classification"],
  ["docs", "semantic-classification"],
  ["question", "routing-area"],
]);
/** @type {(name: string) => string | undefined} */
const roleOf = (name) => ROLES.get(name);
const MARKER = "needs triage";

// The two meaningful label changes: the queue marker, and a classification
// category. Anything else a label event names cannot move the result.
/** @param {Record<string, unknown>} [overrides] */
const issueDecision = (overrides) =>
  decideEvent({
    eventName: "issues",
    action: "opened",
    changedLabel: null,
    markerLabels: [MARKER],
    roleOf,
    threadLabels: [],
    ...overrides,
  });
/** @param {Record<string, unknown>} [overrides] */
const prDecision = (overrides) =>
  decideEvent({
    eventName: "pull_request",
    action: "opened",
    changedLabel: null,
    markerLabels: [MARKER],
    roleOf,
    threadLabels: [],
    ...overrides,
  });

describe("the event matrix", () => {
  describe("issues", () => {
    it.each(["opened", "edited", "reopened"])(
      "%s re-triages — new or changed evidence",
      (action) => {
        expect(issueDecision({ action }).mode).toBe("retriage");
      },
    );

    it.each(["transferred", "milestoned"])("%s skips — no triage evidence", (action) => {
      expect(issueDecision({ action }).mode).toBe("skip");
    });

    it("closed skips — a closed thread awaits no triage", () => {
      expect(issueDecision({ action: "closed" }).mode).toBe("skip");
    });
  });

  describe("pull_request", () => {
    it.each(["opened", "edited", "synchronize", "ready_for_review", "reopened"])(
      "%s re-triages — content, diff or draft state changed",
      (action) => {
        expect(prDecision({ action }).mode).toBe("retriage");
      },
    );

    it.each(["review_requested", "converted_to_draft", "closed"])(
      "%s skips — no triage evidence",
      (action) => {
        expect(prDecision({ action }).mode).toBe("skip");
      },
    );
  });

  describe("events that cannot name themselves safely", () => {
    it("a missing action re-triages — never a silent skip", () => {
      expect(issueDecision({ action: "" }).mode).toBe("retriage");
    });

    it("an unlisted action re-triages — it may carry unseen evidence", () => {
      expect(issueDecision({ action: "assigned" }).mode).toBe("retriage");
      expect(prDecision({ action: "labeled_invalid" }).mode).toBe("retriage");
    });

    it("an unsupported event name is refused by name", () => {
      expect(() =>
        decideEvent({
          eventName: "workflow_dispatch",
          action: "",
          changedLabel: null,
          markerLabels: [],
        }),
      ).toThrow(/runs on 'issues' and 'pull_request'/);
    });
  });

  describe("labeled — moving the queue lifecycle", () => {
    it("applying a queue marker re-triages (the queue entry)", () => {
      const d = decideEvent({
        eventName: "issues",
        action: "labeled",
        changedLabel: MARKER,
        markerLabels: [MARKER],
        roleOf,
        threadLabels: [MARKER],
      });
      expect(d.mode).toBe("retriage");
      expect(d.reason).toContain("queue marker");
    });

    it("applying any marker from multiple markers re-triages", () => {
      const d = decideEvent({
        eventName: "issues",
        action: "labeled",
        changedLabel: "needs review",
        markerLabels: ["needs triage", "needs review"],
        roleOf,
        threadLabels: [],
      });
      expect(d.mode).toBe("retriage");
    });

    it("applying a classification category to a still-queued thread re-triages so the marker clears", () => {
      const d = decideEvent({
        eventName: "issues",
        action: "labeled",
        changedLabel: "bug",
        markerLabels: [MARKER],
        roleOf,
        threadLabels: [MARKER],
      });
      expect(d.mode).toBe("retriage");
    });

    it("applying a classification category to a thread queued by any marker re-triages", () => {
      const d = decideEvent({
        eventName: "issues",
        action: "labeled",
        changedLabel: "bug",
        markerLabels: ["needs triage", "needs review"],
        roleOf,
        threadLabels: ["needs review"],
      });
      expect(d.mode).toBe("retriage");
    });

    it("applying a classification category to a non-queued thread skips — nothing to clear, label already the human's", () => {
      const d = decideEvent({
        eventName: "issues",
        action: "labeled",
        changedLabel: "bug",
        markerLabels: [MARKER],
        roleOf,
        threadLabels: [],
      });
      expect(d.mode).toBe("skip");
    });

    it("applying any other sheet label skips — content evidence is unchanged", () => {
      const d = decideEvent({
        eventName: "issues",
        action: "labeled",
        changedLabel: "question",
        markerLabels: [MARKER],
        roleOf,
        threadLabels: [MARKER],
      });
      expect(d.mode).toBe("skip");
    });

    it("a label event that cannot name its change re-triages", () => {
      expect(
        decideEvent({
          eventName: "issues",
          action: "labeled",
          changedLabel: null,
          markerLabels: [MARKER],
          roleOf,
          threadLabels: [],
        }).mode,
      ).toBe("retriage");
      expect(
        decideEvent({
          eventName: "pull_request",
          action: "unlabeled",
          changedLabel: null,
          markerLabels: [MARKER],
          roleOf,
          threadLabels: [],
        }).mode,
      ).toBe("retriage");
    });
  });

  describe("unlabeled — a deterministic state change", () => {
    it("removing any label skips — no content evidence changes", () => {
      expect(
        decideEvent({
          eventName: "issues",
          action: "unlabeled",
          changedLabel: "bug",
          markerLabels: [MARKER],
          roleOf,
          threadLabels: [],
        }).mode,
      ).toBe("skip");
      expect(
        decideEvent({
          eventName: "pull_request",
          action: "unlabeled",
          changedLabel: "size/small",
          markerLabels: [MARKER],
          roleOf,
          threadLabels: [],
        }).mode,
      ).toBe("skip");
    });

    it("removing any queue marker is a human dequeue triage respects — skips and never rewrites it", () => {
      const d = decideEvent({
        eventName: "issues",
        action: "unlabeled",
        changedLabel: MARKER,
        markerLabels: [MARKER],
        roleOf,
        threadLabels: [],
      });
      expect(d.mode).toBe("skip");
      expect(d.reason).toContain("queue marker");
    });

    it("removing any marker from multiple markers is also a human dequeue", () => {
      const d = decideEvent({
        eventName: "issues",
        action: "unlabeled",
        changedLabel: "needs review",
        markerLabels: ["needs triage", "needs review"],
        roleOf,
        threadLabels: [],
      });
      expect(d.mode).toBe("skip");
      expect(d.reason).toContain("queue marker");
    });
  });

  describe("a policy without a queue marker", () => {
    it("delegates label events to a plain skip — no marker lifecycle to move", () => {
      const base = {
        eventName: "issues",
        action: "labeled",
        changedLabel: "bug",
        markerLabels: [],
        roleOf,
        threadLabels: [],
      };
      expect(decideEvent(base).mode).toBe("skip");
      expect(decideEvent({ ...base, action: "unlabeled" }).mode).toBe("skip");
    });
  });
});

describe("eventChangedLabel", () => {
  it("reads the changed label's name", () => {
    expect(eventChangedLabel({ action: "labeled", label: { name: "bug" } })).toBe("bug");
  });

  it("returns null when the payload carries no readable label", () => {
    expect(eventChangedLabel({ action: "labeled" })).toBeNull();
    expect(eventChangedLabel({ action: "labeled", label: null })).toBeNull();
    expect(eventChangedLabel({ action: "labeled", label: {} })).toBeNull();
    expect(eventChangedLabel({ action: "labeled", label: { name: "" } })).toBeNull();
  });
});

describe("eventAuditLine", () => {
  it("names the event, the decision and the reason", () => {
    const line = eventAuditLine({
      eventName: "issues",
      action: "labeled",
      decision: {
        mode: "retriage",
        reason: "a queue marker was applied — re-triaged so a classified thread leaves the queue",
      },
    });
    expect(line).toBe(
      "triage: event issues.labeled → retriage — a queue marker was applied — re-triaged so a classified thread leaves the queue",
    );
  });
});

describe("the matrix enumerates the events triage understands", () => {
  it("lists the issues actions the action can receive", () => {
    expect(ISSUE_ACTIONS).toContain("labeled");
    expect(ISSUE_ACTIONS).toContain("unlabeled");
    expect(ISSUE_ACTIONS).toContain("transferred");
    expect(ISSUE_ACTIONS).toContain("milestoned");
  });

  it("lists the pull_request actions the action can receive", () => {
    expect(PULL_REQUEST_ACTIONS).toContain("synchronize");
    expect(PULL_REQUEST_ACTIONS).toContain("ready_for_review");
    expect(PULL_REQUEST_ACTIONS).toContain("review_requested");
    expect(PULL_REQUEST_ACTIONS).toContain("converted_to_draft");
    expect(PULL_REQUEST_ACTIONS).toContain("closed");
  });
});
