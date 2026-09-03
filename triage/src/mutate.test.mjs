// Tests for the Controlled Mutation stage — the pipeline's only writer. A
// recording forge stands in for GitHub; what is pinned is the write surface
// itself: labels and one comment and nothing else, in the decision's order,
// and a dry run that writes literally nothing — not even the identity read a
// live comment write pays for. Every other forge method is a stub that fails
// loudly, so a regression that reaches beyond the write surface breaks here.

import { afterEach, describe, expect, it, vi } from "vitest";

import { mutate } from "./mutate.mjs";

/**
 * A recording forge: the write surface mutate may touch is real and recorded,
 * every other forge method fails loudly, so a regression that reaches beyond
 * the write surface breaks here. The live reads a write is judged against
 * answer from `options`: the issue's labels, and — merged over a default —
 * the pull request snapshot, when the test gives the thread a pull request
 * subject claim.
 *
 * @param {object} [options]
 * @param {string[]} [options.issueLabels] what the live issue read answers
 * @param {Partial<import("#core/forge.mjs").PullRequestSnapshot>} [options.prSnapshot] merged over the live pull request read
 */
function createFakeForge(options = {}) {
  /** @type {{ op: string, args: unknown[] }[]} */
  const writes = [];
  let commentId = 100;
  /**
   * @param {string} name
   */
  const fail = (name) =>
    vi.fn(async () => {
      throw new Error(`mutate touched the forge outside its write surface: ${name}`);
    });
  /** @type {{ writes: { op: string, args: unknown[] }[], forge: import("#core/forge.mjs").Forge }} */
  return {
    writes,
    forge: /** @type {import("#core/forge.mjs").Forge} */ (
      /** @type {unknown} */ ({
        whoami: vi.fn(async () => {
          writes.push({ op: "whoami", args: [] });
          return { login: "github-actions[bot]" };
        }),
        getRepository: fail("getRepository"),
        getRef: fail("getRef"),
        readRef: fail("readRef"),
        listTree: fail("listTree"),
        getContents: fail("getContents"),
        listRepositoryLabels: fail("listRepositoryLabels"),
        listRepositoryLabelsDetailed: fail("listRepositoryLabelsDetailed"),
        getPullRequest: options.prSnapshot
          ? vi.fn(async () => ({
              number: 7,
              state: "open",
              draft: false,
              merged: false,
              mergeable: null,
              mergeableState: null,
              title: "",
              body: "",
              labels: options.prSnapshot?.labels ?? [],
              head: { ref: "x", sha: "a".repeat(40) },
              base: { ref: "main", sha: "a".repeat(40) },
              ...options.prSnapshot,
            }))
          : fail("getPullRequest"),
        getIssue: vi.fn(async () => ({ labels: options.issueLabels ?? [] })),
        listPullRequestFiles: fail("listPullRequestFiles"),
        searchIssues: fail("searchIssues"),
        listCheckRuns: fail("listCheckRuns"),
        listPullRequestReviews: fail("listPullRequestReviews"),
        addLabels: vi.fn(async (number, labels) => {
          writes.push({ op: "addLabels", args: [number, labels] });
        }),
        removeLabel: vi.fn(async (number, name) => {
          writes.push({ op: "removeLabel", args: [number, name] });
        }),
        listComments: vi.fn(async () => []),
        createComment: vi.fn(async (number, body) => {
          writes.push({ op: "createComment", args: [number, body] });
          return { id: commentId++ };
        }),
        updateComment: vi.fn(async () => {
          writes.push({ op: "updateComment", args: [] });
        }),
        deleteComment: vi.fn(async () => {
          writes.push({ op: "deleteComment", args: [] });
        }),
        createBlob: fail("createBlob"),
        createTree: fail("createTree"),
        createCommit: fail("createCommit"),
        upsertBranch: fail("upsertBranch"),
        upsertPullRequest: fail("upsertPullRequest"),
      })
    ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mutate — labels decision", () => {
  it("emits the decision's logs before executing it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { forge } = createFakeForge();
    await mutate({
      decision: {
        kind: "labels",
        add: ["bug"],
        remove: [],
        refusals: ["made-up"],
        logs: [
          { level: "warning", text: "refused the off-sheet label 'made-up'" },
          { level: "info", text: "rationale: r" },
        ],
        rationale: "r",
        comment: undefined,
      },
      forge,
      issueNumber: 7,
      dryRun: false,
      now: () => 1,
      action: "triage",
      threadLabels: [],
      subject: null,
    });
    const [firstLine, secondLine] = /** @type {[unknown[], unknown[]]} */ (log.mock.calls);
    expect(firstLine[0]).toBe("::warning::refused the off-sheet label 'made-up'");
    expect(secondLine[0]).toBe("rationale: r");
    expect(forge.addLabels).toHaveBeenCalledWith(7, ["bug"]);
  });

  it("adds labels then removes them in decision order", async () => {
    const fake = createFakeForge();
    await mutate({
      decision: {
        kind: "labels",
        add: ["bug", "size/xs"],
        remove: [
          { name: "size/xl", reason: "size" },
          { name: "needs triage", reason: "marker" },
        ],
        refusals: [],
        logs: [],
        rationale: "r",
        comment: undefined,
      },
      forge: fake.forge,
      issueNumber: 7,
      dryRun: false,
      now: () => 1,
      action: "triage",
      threadLabels: [],
      subject: null,
    });
    expect(fake.writes).toEqual([
      { op: "addLabels", args: [7, ["bug", "size/xs"]] },
      { op: "removeLabel", args: [7, "size/xl"] },
      { op: "removeLabel", args: [7, "needs triage"] },
    ]);
  });

  it("skips a write operation entirely when the decision names nothing for it", async () => {
    const fake = createFakeForge();
    await mutate({
      decision: {
        kind: "labels",
        add: [],
        remove: [],
        refusals: [],
        logs: [],
        rationale: "r",
        comment: undefined,
      },
      forge: fake.forge,
      issueNumber: 7,
      dryRun: false,
      now: () => 1,
      action: "triage",
      threadLabels: [],
      subject: null,
    });
    expect(fake.writes).toEqual([]);
  });

  it("never writes in a dry run — it prints the preview and stops", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fake = createFakeForge();
    await mutate({
      decision: {
        kind: "labels",
        add: ["bug"],
        remove: [{ name: "size/xl", reason: "size" }],
        refusals: [],
        logs: [{ level: "info", text: "rationale: r" }],
        rationale: "r",
        comment: undefined,
      },
      forge: fake.forge,
      issueNumber: 7,
      dryRun: true,
      now: () => 1,
      action: "triage",
      threadLabels: [],
      subject: null,
    });
    expect(fake.writes).toEqual([]);
    expect(
      log.mock.calls.some((call) =>
        String(call[0]).includes("dry run — would add [bug] and remove [size/xl]"),
      ),
    ).toBe(true);
  });
});

describe("mutate — comment decision", () => {
  it("resolves its own logins, upserts the comment and logs the outcome", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fake = createFakeForge();
    await mutate({
      decision: {
        kind: "comment",
        add: [],
        remove: [],
        refusals: [],
        logs: [{ level: "info", text: "rationale: Because." }],
        rationale: "Because.",
        comment: { classification: "a bug", rationale: "Because." },
      },
      forge: fake.forge,
      issueNumber: 7,
      dryRun: false,
      now: () => 1,
      action: "triage",
      threadLabels: [],
      subject: null,
    });
    // Identity read first — the paid read only a live comment write needs.
    expect(fake.writes[0]).toEqual({ op: "whoami", args: [] });
    const commentWrite = /** @type {{ op: string, args: unknown[] }} */ (fake.writes[1]);
    expect(commentWrite.op).toBe("createComment");
    expect(commentWrite.args[0]).toBe(7);
    expect(String(commentWrite.args[1])).toContain("<!-- action-agents:triage:");
    expect(String(commentWrite.args[1])).toContain("**a bug**");
    expect(
      log.mock.calls.some((call) => String(call[0]) === "classification comment created (100)"),
    ).toBe(true);
  });

  it("never pays for the identity read in a dry run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fake = createFakeForge();
    await mutate({
      decision: {
        kind: "comment",
        add: [],
        remove: [],
        refusals: [],
        logs: [],
        rationale: "Because.",
        comment: { classification: "a bug", rationale: "Because." },
      },
      forge: fake.forge,
      issueNumber: 7,
      dryRun: true,
      now: () => 1,
      action: "triage",
      threadLabels: [],
      subject: null,
    });
    expect(fake.writes).toEqual([]);
    expect(
      log.mock.calls.some((call) =>
        String(call[0]).includes("dry run — the classification would be written as this comment:"),
      ),
    ).toBe(true);
  });
});

describe("mutate — signal comment on a labels decision", () => {
  it("writes the labels, then resolves logins and upserts the signal comment", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fake = createFakeForge();
    await mutate({
      decision: {
        kind: "labels",
        add: ["bug"],
        remove: [],
        refusals: [],
        logs: [{ level: "info", text: "rationale: Because." }],
        rationale: "Because.",
        comment: undefined,
        signal: {
          needsMoreInfo: ["Steps to reproduce"],
          modelJudgedQuality: false,
          related: null,
        },
      },
      forge: fake.forge,
      issueNumber: 7,
      dryRun: false,
      now: () => 1,
      action: "triage",
      threadLabels: [],
      subject: null,
    });
    // Order: the labels first, then the identity read a comment write pays
    // for, then the comment itself.
    expect(fake.writes[0]).toEqual({ op: "addLabels", args: [7, ["bug"]] });
    expect(fake.writes[1]).toEqual({ op: "whoami", args: [] });
    const commentWrite = /** @type {{ op: string, args: unknown[] }} */ (fake.writes[2]);
    expect(commentWrite.op).toBe("createComment");
    const body = String(commentWrite.args[1]);
    expect(body).toContain("<!-- action-agents:triage:");
    expect(body).toContain("This issue looks incomplete. This is a note, not a closing");
    expect(body).toContain("The following required field is empty: Steps to reproduce.");
    expect(body).toContain("_Posted by the `triage` action._");
    expect(log.mock.calls.some((call) => String(call[0]) === "signal comment created (100)")).toBe(
      true,
    );
  });

  it("renders the signal comment in a dry run and writes nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fake = createFakeForge();
    await mutate({
      decision: {
        kind: "labels",
        add: ["bug"],
        remove: [],
        refusals: [],
        logs: [{ level: "info", text: "rationale: Because." }],
        rationale: "Because.",
        comment: undefined,
        signal: {
          needsMoreInfo: [],
          modelJudgedQuality: false,
          related: { number: 12, title: "the same crash", type: "duplicate" },
        },
      },
      forge: fake.forge,
      issueNumber: 7,
      dryRun: true,
      now: () => 1,
      action: "triage",
      threadLabels: [],
      subject: null,
    });
    expect(
      log.mock.calls.some((call) =>
        String(call[0]).includes(
          "dry run — would add [bug] and post a signal comment: <!-- action-agents:triage:dry-run -->  Possibly duplicate of #12 — the same crash.",
        ),
      ),
    ).toBe(true);
  });
});

describe("mutate — the live re-read before any write", () => {
  /**
   * A decision carrying a plan derived from a stale payload view. What the
   * assertions pin is that the live read — never this plan's premises —
   * decides what lands.
   *
   * @param {Partial<import("./decision.mjs").Decision>} [overrides]
   * @returns {import("./decision.mjs").Decision}
   */
  function staleDecision(overrides = {}) {
    return {
      kind: "labels",
      add: ["size/m"],
      remove: [],
      refusals: [],
      logs: [],
      rationale: "r",
      comment: undefined,
      ...overrides,
    };
  }

  /**
   * Runs mutate with a labels decision against a quiet console.
   *
   * @param {ReturnType<typeof createFakeForge>} fake
   * @param {import("./decision.mjs").Decision} decision
   * @param {{ threadLabels: string[], subject: import("./mutate.mjs").SubjectClaim | null }} claims
   */
  async function runMutation(fake, decision, claims) {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await mutate({
      decision,
      forge: fake.forge,
      issueNumber: 7,
      dryRun: false,
      now: () => 1,
      action: "triage",
      ...claims,
    });
    return log;
  }

  it("claims matched on a pull request — the writes proceed and the marker records the head", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fake = createFakeForge({ prSnapshot: { labels: ["bug"] } });
    await mutate({
      decision: {
        kind: "comment",
        add: [],
        remove: [],
        refusals: [],
        logs: [],
        rationale: "Because.",
        comment: { classification: "a bug", rationale: "Because." },
      },
      forge: fake.forge,
      issueNumber: 7,
      dryRun: false,
      now: () => 1,
      action: "triage",
      threadLabels: ["bug"],
      subject: { head: "a".repeat(40), state: "open", merged: false },
    });
    const commentWrite = /** @type {{ op: string, args: unknown[] }} */ (fake.writes[1]);
    expect(commentWrite.op).toBe("createComment");
    expect(String(commentWrite.args[1])).toContain(`<!-- action-agents:triage:`);
    expect(String(commentWrite.args[1])).toContain(":head=" + "a".repeat(40));
    expect(log.mock.calls.some((call) => String(call[0]).includes("nothing written"))).toBe(false);
  });

  it("claims matched on an issue — the marker records no head", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fake = createFakeForge({ issueLabels: ["bug"] });
    await mutate({
      decision: {
        kind: "comment",
        add: [],
        remove: [],
        refusals: [],
        logs: [],
        rationale: "Because.",
        comment: { classification: "a bug", rationale: "Because." },
      },
      forge: fake.forge,
      issueNumber: 7,
      dryRun: false,
      now: () => 1,
      action: "triage",
      threadLabels: ["bug"],
      subject: null,
    });
    const commentWrite = /** @type {{ op: string, args: unknown[] }} */ (fake.writes[1]);
    expect(String(commentWrite.args[1])).not.toContain(":head=");
    expect(log.mock.calls.some((call) => String(call[0]).includes("nothing written"))).toBe(false);
  });

  it("a label the live thread carries but the payload view does not is never removed", async () => {
    const fake = createFakeForge({ issueLabels: ["bug", "size/l"] });
    const log = await runMutation(fake, staleDecision({ remove: [] }), {
      threadLabels: ["bug"],
      subject: null,
    });
    expect(fake.writes).toEqual([]);
    expect(
      log.mock.calls.some((call) =>
        String(call[0]).includes(
          "nothing written — the thread changed while this run was in flight: " +
            "the labels are now [bug, size/l], not the [bug] the event carried",
        ),
      ),
    ).toBe(true);
  });

  it("a label removal whose subject moved on the live thread never fires", async () => {
    const fake = createFakeForge({ issueLabels: ["bug"] });
    const log = await runMutation(fake, staleDecision(), {
      threadLabels: ["bug", "needs triage"],
      subject: null,
    });
    expect(fake.writes).toEqual([]);
    expect(
      log.mock.calls.some((call) =>
        String(call[0]).includes("the labels are now [bug], not the [bug, needs triage]"),
      ),
    ).toBe(true);
  });

  it("a pull request that moved on while the run was in flight receives nothing", async () => {
    const fake = createFakeForge({
      prSnapshot: { head: { ref: "x", sha: "b".repeat(40) }, labels: ["bug"] },
    });
    const log = await runMutation(fake, staleDecision(), {
      threadLabels: ["bug"],
      subject: { head: "a".repeat(40), state: "open", merged: false },
    });
    expect(fake.writes).toEqual([]);
    expect(
      log.mock.calls.some((call) =>
        String(call[0]).includes(
          "the head is now " + "b".repeat(12) + ", not the " + "a".repeat(12) + " this run read",
        ),
      ),
    ).toBe(true);
  });

  it("a merged or closed pull request receives nothing", async () => {
    for (const live of [
      { merged: true, state: "open" },
      { merged: false, state: "closed" },
    ]) {
      const fake = createFakeForge({ prSnapshot: { labels: ["bug"], ...live } });
      const log = await runMutation(fake, staleDecision(), {
        threadLabels: ["bug"],
        subject: { head: "a".repeat(40), state: "open", merged: false },
      });
      expect(fake.writes).toEqual([]);
      expect(
        log.mock.calls.some(
          (call) =>
            String(call[0]).includes("the pull request is now merged") ||
            String(call[0]).includes("the pull request is now closed"),
        ),
      ).toBe(true);
    }
  });
});
