// Tests for the Controlled Mutation stage — the pipeline's only writer. A
// recording forge stands in for GitHub; what is pinned is the write surface
// itself: labels and one comment and nothing else, in the decision's order,
// and a dry run that writes literally nothing — not even the identity read a
// live comment write pays for. Every other forge method is a stub that fails
// loudly, so a regression that reaches beyond the write surface breaks here.

import { afterEach, describe, expect, it, vi } from "vitest";

import { OwnLoginsError } from "#core/comment.mjs";
import { PartialMutationError, ThreadMovedError, mutate } from "./mutate.mjs";

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

  it("removes first, then adds — a part-way death leaves the safer half-state", async () => {
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
      { op: "removeLabel", args: [7, "size/xl"] },
      { op: "removeLabel", args: [7, "needs triage"] },
      { op: "addLabels", args: [7, ["bug", "size/xs"]] },
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
          "dry run — would add [bug] and post a signal comment: <!-- action-agents:triage:dry-run --> Possibly duplicate of #12 — the same crash.",
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
   * Starts mutate with a labels decision against a quiet console. The
   * freshness gate rejects instead of returning, so the promise is returned
   * un-awaited: a divergence test asserts the `ThreadMovedError` with
   * `.rejects` and reads the log and the writes once it has settled.
   *
   * @param {ReturnType<typeof createFakeForge>} fake
   * @param {import("./decision.mjs").Decision} decision
   * @param {{ threadLabels: string[], subject: import("./mutate.mjs").SubjectClaim | null }} claims
   */
  function runMutation(fake, decision, claims) {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    return {
      run: mutate({
        decision,
        forge: fake.forge,
        issueNumber: 7,
        dryRun: false,
        now: () => 1,
        action: "triage",
        ...claims,
      }),
      log,
    };
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
    const { run, log } = runMutation(fake, staleDecision({ remove: [] }), {
      threadLabels: ["bug"],
      subject: null,
    });
    await expect(run).rejects.toThrow(ThreadMovedError);
    await expect(run).rejects.toThrow(
      "the labels are now [bug, size/l], not the [bug] the event carried",
    );
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

  it("a hostile label name in the divergence line cannot forge the run log", async () => {
    // The live read is typed as strings and nothing enforces GitHub's label
    // charset on it, so the strip happens at the emission boundary: an ESC
    // or BEL inside a label name becomes a space before the annotation is
    // written, never a workflow command inside the run log. The thrown
    // error carries the raw reason — the strip stays at the emission
    // boundary and at the record build site; mutate never strips inside.
    const fake = createFakeForge({ issueLabels: ["bug", "evil\u001b]2;owned\u0007"] });
    const { run, log } = runMutation(fake, staleDecision({ remove: [] }), {
      threadLabels: ["bug"],
      subject: null,
    });
    await expect(run).rejects.toThrow(ThreadMovedError);
    await expect(run).rejects.toThrow(
      "the labels are now [bug, evil\u001b]2;owned\u0007], not the [bug] the event carried",
    );
    expect(fake.writes).toEqual([]);
    const line = log.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes("nothing written"));
    expect(line).toBeDefined();
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\u0007");
    expect(line).toContain(
      "the labels are now [bug, evil ]2;owned ], not the [bug] the event carried",
    );
  });

  it("a label removal whose subject moved on the live thread never fires", async () => {
    const fake = createFakeForge({ issueLabels: ["bug"] });
    const { run, log } = runMutation(fake, staleDecision(), {
      threadLabels: ["bug", "needs triage"],
      subject: null,
    });
    await expect(run).rejects.toThrow(ThreadMovedError);
    await expect(run).rejects.toThrow(
      "the labels are now [bug], not the [bug, needs triage] the event carried",
    );
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
    const { run, log } = runMutation(fake, staleDecision(), {
      threadLabels: ["bug"],
      subject: { head: "a".repeat(40), state: "open", merged: false },
    });
    await expect(run).rejects.toThrow(ThreadMovedError);
    await expect(run).rejects.toThrow(
      "the head is now " + "b".repeat(12) + ", not the " + "a".repeat(12) + " this run read",
    );
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
      const { run, log } = runMutation(fake, staleDecision(), {
        threadLabels: ["bug"],
        subject: { head: "a".repeat(40), state: "open", merged: false },
      });
      await expect(run).rejects.toThrow(ThreadMovedError);
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

describe("mutate — partial-mutation accounting", () => {
  it("a failure part-way raises the accounting: what applied, what failed, what was never attempted", async () => {
    const fake = createFakeForge({ issueLabels: ["size/xl", "needs triage"] });
    // The first removal lands; the second fails — a classic half-applied
    // plan with a signal comment still queued behind it.
    fake.forge.removeLabel = vi.fn(
      async (/** @type {number} */ number, /** @type {string} */ name) => {
        if (name === "needs triage") {
          throw new Error("the label endpoint timed out");
        }
        fake.writes.push({ op: "removeLabel", args: [number, name] });
      },
    );
    const run = mutate({
      decision: {
        kind: "labels",
        add: ["bug"],
        remove: [
          { name: "size/xl", reason: "size" },
          { name: "needs triage", reason: "marker" },
        ],
        refusals: [],
        logs: [],
        rationale: "reason",
        comment: undefined,
        signal: { needsMoreInfo: [], modelJudgedQuality: false, related: null },
      },
      forge: fake.forge,
      issueNumber: 7,
      dryRun: false,
      now: () => 1,
      action: "triage",
      threadLabels: ["size/xl", "needs triage"],
      subject: null,
    });
    await expect(run).rejects.toThrow(PartialMutationError);
    await expect(run).rejects.toThrow(/applied \[removeLabel size\/xl\]/);
    await expect(run).rejects.toThrow(/removeLabel needs triage failed/);
    await expect(run).rejects.toThrow(
      /not attempted: \[addLabels \[bug\], upsertComment signal comment\]/,
    );
    // The recorded surface: exactly what applied — nothing after the
    // failure was attempted.
    expect(fake.writes).toEqual([{ op: "removeLabel", args: [7, "size/xl"] }]);
  });

  it("a failure on the first operation reports that nothing had applied", async () => {
    const fake = createFakeForge({ issueLabels: ["size/xl"] });
    fake.forge.removeLabel = vi.fn(async () => {
      throw new Error("the label endpoint timed out");
    });
    const run = mutate({
      decision: {
        kind: "labels",
        add: ["bug"],
        remove: [{ name: "size/xl", reason: "size" }],
        refusals: [],
        logs: [],
        rationale: "reason",
        comment: undefined,
      },
      forge: fake.forge,
      issueNumber: 7,
      dryRun: false,
      now: () => 1,
      action: "triage",
      threadLabels: ["size/xl"],
      subject: null,
    });
    await expect(run).rejects.toThrow(PartialMutationError);
    await expect(run).rejects.toThrow(/no operation had applied/);
    await expect(run).rejects.toThrow(/removeLabel size\/xl failed/);
    await expect(run).rejects.toThrow(/not attempted: \[addLabels \[bug\]\]/);
    expect(fake.writes).toEqual([]);
  });

  it("an identity-read failure red-runs before any comment write", async () => {
    const fake = createFakeForge();
    fake.forge.whoami = vi.fn(async () => {
      throw new Error("the token's identity read failed");
    });
    const run = mutate({
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
      threadLabels: [],
      subject: null,
    });
    const caught = await run.then(
      () => null,
      (cause) => cause,
    );
    expect(caught).toBeInstanceOf(PartialMutationError);
    expect(caught?.cause).toBeInstanceOf(OwnLoginsError);
    expect(caught?.message).toContain("upsertComment classification comment failed");
    // Nothing written: a run that cannot establish its identity does not
    // write at all — the upsert never runs on a guessed own-set. The write
    // now flows through the executor's accounting loop, so the identity-read
    // failure surfaces as the partial-mutation accounting, with the identity
    // read as its cause — the same shape a label op's failure already took.
    expect(fake.writes.filter((write) => write.op !== "whoami")).toEqual([]);
  });
});

describe("mutate — the re-run re-derives, it never replays a plan", () => {
  it("executes only the decision handed to it — there is no plan store to replay", async () => {
    const fake = createFakeForge({ issueLabels: ["size/xl"] });

    // Run one — a size swap that dies after its removal. Cancellation is the
    // no-throw producer of a partial mutation (the dogfood workflows run
    // `cancel-in-progress: true`): the removal landed, the addition did not,
    // and a dead process raises nothing — no catch boundary fires, nothing is
    // logged. There is no accounting line for a canceled run; the invariant
    // that covers it is the re-run's, pinned below.
    await mutate({
      decision: {
        kind: "labels",
        add: ["size/s"],
        remove: [{ name: "size/xl", reason: "size" }],
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
      threadLabels: ["size/xl"],
      subject: null,
    });

    // The live thread now answers with what run one left behind;
    fake.forge.getIssue = vi.fn(async () => ({ labels: ["size/s"] }));

    // Run two — the re-run. The policy engine derives its plan fresh from
    // the state the run reads; the live thread no longer carries `size/xl`,
    // so this plan removes nothing. mutate itself holds no plan across
    // calls: there is no persisted plan anywhere to replay.
    await mutate({
      decision: {
        kind: "labels",
        add: ["size/s"],
        remove: [],
        refusals: [],
        logs: [],
        rationale: "r",
        comment: undefined,
      },
      forge: fake.forge,
      issueNumber: 7,
      dryRun: false,
      now: () => 2,
      action: "triage",
      threadLabels: ["size/s"],
      subject: null,
    });

    // Run one completes in this test (a fake cannot kill a process); its
    // writes stand. The pinned fact is run two's segment: exactly its own
    // plan — one addition, and the removal run one already applied is not
    // repeated, because there is no plan store to replay it from.
    expect(fake.writes.slice(2)).toEqual([{ op: "addLabels", args: [7, ["size/s"]] }]);
  });
});

describe("mutate — an abandoned comment write is not an applied op", () => {
  const RACED = {
    id: 55,
    body: `<!-- action-agents:triage:d0d00001:head=${"b".repeat(40)} -->older classification`,
    user: { login: "github-actions[bot]" },
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T12:00:00Z",
  };

  it("the classification abandonment ends the run abandoned — nothing written, no owned id logged", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fake = createFakeForge({ prSnapshot: {} });
    fake.forge.listComments = async () => [RACED];
    const run = mutate({
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
      threadLabels: [],
      subject: { head: "a".repeat(40), state: "open", merged: false },
    });
    // The comment-op abandonment is the subject-moved race (F-12): the run
    // record ends abandoned — never partial-mutation failed, never applied.
    await expect(run).rejects.toThrow(ThreadMovedError);
    await expect(run).rejects.toThrow(/owned by a concurrent run/);
    // The standing comment belongs to the run that won the thread: no log
    // line claims an id for a write this run did not make.
    expect(
      log.mock.calls.some((call) =>
        /comment (created|updated|abandoned) \(\d+\)/.test(String(call[0])),
      ),
    ).toBe(false);
    // Zero mutations: the raced write touched nothing on the thread.
    expect(
      fake.writes.some(
        (write) =>
          write.op === "createComment" ||
          write.op === "updateComment" ||
          write.op === "deleteComment",
      ),
    ).toBe(false);
  });

  it("the signal abandonment ends the run abandoned the same way", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fake = createFakeForge({ prSnapshot: {} });
    fake.forge.listComments = async () => [RACED];
    const run = mutate({
      decision: {
        kind: "labels",
        add: [],
        remove: [],
        refusals: [],
        logs: [],
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
      subject: { head: "a".repeat(40), state: "open", merged: false },
    });
    await expect(run).rejects.toThrow(ThreadMovedError);
    await expect(run).rejects.toThrow(/owned by a concurrent run/);
    expect(
      log.mock.calls.some((call) =>
        /comment (created|updated|abandoned) \(\d+\)/.test(String(call[0])),
      ),
    ).toBe(false);
    expect(
      fake.writes.some(
        (write) =>
          write.op === "createComment" ||
          write.op === "updateComment" ||
          write.op === "deleteComment",
      ),
    ).toBe(false);
  });
});
