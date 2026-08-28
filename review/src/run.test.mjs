// Tests for the run orchestrator: the state law. Drafts skip, closed
// threads skip, moved heads abandon before writing, failures preserve the
// last complete review by never reaching a write, dry-run touches nothing,
// and publication goes through exactly one marker upsert guarded by the
// pre-publication re-read.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { reviewPullRequest } from "./run.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

/** A real checked-out-looking root: anchors count lines against this copy. */
/** @type {string} */
let wsRoot;

beforeAll(() => {
  wsRoot = mkdtempSync(p.join(tmpdir(), "run-test-ws-"));
  mkdirSync(p.join(wsRoot, "src"));
  writeFileSync(p.join(wsRoot, "src", "a.mjs"), "line1\nline2\nline3\n");
  CONTEXT.workspace = wsRoot;
});

/**
 * @param {Partial<import("#core/forge.mjs").PullRequestSnapshot>} [over]
 * @returns {import("#core/forge.mjs").PullRequestSnapshot}
 */
function snapshot(over = {}) {
  return {
    number: 7,
    state: "open",
    draft: false,
    merged: false,
    title: "the change",
    body: "",
    head: { ref: "feature", sha: HEAD },
    base: { ref: "main", sha: BASE },
    ...over,
  };
}

/**
 * A forge stub covering the reads a full happy-path run makes.
 *
 * @param {{ files?: unknown[], config?: string | null, instruction?: string | null, repoDescription?: string, snapshotOverride?: import("#core/forge.mjs").PullRequestSnapshot, whoamiLogin?: string, whoamiError?: Error }} [options]
 * @returns {import("./run.mjs").ReviewForge & { calls: { getPullRequests: string[], upserts: Array<{ id?: number, body?: string }> } }}
 */
function forgeStub(options = {}) {
  const calls = {
    /** @type {string[]} */
    getPullRequests: [],
    /** @type {Array<{ id?: number, body?: string }> } */
    upserts: [],
  };
  return {
    calls,
    async getPullRequest() {
      const snap = options.snapshotOverride ?? snapshot();
      void options;
      calls.getPullRequests.push(snap.head.sha);
      return snap;
    },
    async getRepository() {
      return { defaultBranch: "main", name: "widgets", description: options.repoDescription ?? "" };
    },
    /** @param {string} path */
    /** @param {string} path @returns {Promise<{ content: string } | null>} */
    async getContents(path) {
      if (path.endsWith("review.json5")) {
        return options.config === undefined
          ? null
          : { content: /** @type {string} */ (options.config) };
      }
      if (path.endsWith("review.json")) return null;
      if (path.includes("instruction")) {
        return typeof options.instruction === "string" ? { content: options.instruction } : null;
      }
      return null;
    },
    async listPullRequestFiles() {
      return (
        options.files ?? [
          /** @type {any} */ ({
            filename: "src/a.mjs",
            status: "modified",
            additions: 2,
            deletions: 1,
            patch: "@@ -1 +1,2 @@\n+x",
          }),
        ]
      );
    },
    async listComments() {
      return [];
    },
    async whoami() {
      if (options.whoamiError) throw options.whoamiError;
      return { login: options.whoamiLogin ?? "github-actions[bot]" };
    },
    /** @param {number} _number @param {string} body */
    async createComment(_number, body) {
      calls.upserts.push({ body });
      return { id: 101 };
    },
    /** @param {number} id @param {string} body */
    async updateComment(id, body) {
      calls.upserts.push({ id, body });
    },
    async deleteComment() {},
  };
}

/**
 * @param {string} [finalAnswer]
 * @returns {import("#core/chat.mjs").Chat}
 */
function chatStub(finalAnswer) {
  return {
    async complete() {
      return {
        content:
          finalAnswer ??
          '{"findings":[{"severity":"concern","file":"src/a.mjs","line":2,"message":"off-by-one"}],"summary":"one concern"}',
        toolCalls: [],
        finishReason: "stop",
      };
    },
  };
}

/**
 * A chat stub that can run reading turns before the final answer — the
 * shape a review that actually reads takes on the wire.
 *
 * @param {Array<{ content: string, toolCalls?: { id: string, name: string, arguments: string }[] }>} script
 * @returns {import("#core/chat.mjs").Chat}
 */
function readingChat(script) {
  let cursor = 0;
  return {
    async complete() {
      const next = script[Math.min(cursor, script.length - 1)];
      cursor++;
      if (next === undefined || cursor > script.length) throw new Error("script exhausted");
      return {
        content: next.content,
        toolCalls: next.toolCalls ?? [],
        finishReason: next.toolCalls !== undefined ? "tool_calls" : "stop",
      };
    },
  };
}

/**
 * A chat stub that records the messages of every request — the prompt a
 * run actually assembled, lanes included.
 *
 * @param {string} [finalAnswer]
 * @returns {import("#core/chat.mjs").Chat & { captured: import("#core/chat.mjs").ChatMessage[][] }}
 */
function capturingChat(finalAnswer) {
  /** @type {import("#core/chat.mjs").ChatMessage[][]} */
  const captured = [];
  return {
    captured,
    async complete(request) {
      captured.push(request.messages);
      return {
        content: finalAnswer ?? '{"findings":[],"summary":"nothing to report"}',
        toolCalls: [],
        finishReason: "stop",
      };
    },
  };
}

/**
 * @param {import("./run.mjs").ReviewForge} forge
 * @param {import("#core/chat.mjs").Chat} [chat]
 * @returns {import("./run.mjs").Io}
 */
function io(forge, chat = chatStub()) {
  return {
    forge,
    chat,
    now: () => 1_000,
    info: () => undefined,
  };
}

const INPUTS = {
  model: "review",
  maxTurns: 5,
  contextWindow: 128_000,
  dryRun: false,
  configPath: "",
};
const CONTEXT = { owner: "acme", repo: "widgets", workspace: "" }; // set in beforeAll

describe("start-of-run state", () => {
  it("skips drafts without touching anything else", async () => {
    const forge = forgeStub({ snapshotOverride: snapshot({ draft: true }) });
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forge),
    });
    expect(result.outcome).toBe("skip");
    expect(forge.calls.getPullRequests).toHaveLength(1);
  });

  it("skips closed and merged pull requests", async () => {
    for (const over of [{ state: "closed" }, { state: "closed", merged: true }]) {
      const forge = forgeStub({ snapshotOverride: snapshot(over) });
      const result = await reviewPullRequest({
        inputs: INPUTS,
        context: CONTEXT,
        pullRequestNumber: 7,
        io: io(forge),
      });
      expect(result.outcome).toBe("skip");
    }
  });
});

describe("the universe and the budget", () => {
  it("clears an existing marker when every file is ignored, else stays silent", async () => {
    const withMarker = forgeStub({ files: [] });
    withMarker.listComments = async () => [
      {
        id: 55,
        body: `<!-- action-agents:review:0badcafe -->old findings`,
        user: { login: "github-actions[bot]" },
        created_at: "",
        updated_at: "",
      },
    ];
    const cleared = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(withMarker),
    });
    expect(cleared.outcome).toBe("nothing-to-review");
    expect(withMarker.calls.upserts[0]?.id).toBe(55);
    expect(withMarker.calls.upserts[0]?.body).toContain("Nothing to review");

    const bare = forgeStub({ files: [] });
    const skipped = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(bare),
    });
    expect(skipped.outcome).toBe("skip");
    expect(bare.calls.upserts).toHaveLength(0);
  });

  it("refuses diffs past the budget, red, naming both numbers — before any model call", async () => {
    const forge = forgeStub({
      files: [
        { filename: "a.mjs", status: "modified", additions: 6000, deletions: 0 },
        { filename: "b.mjs", status: "modified", additions: 1, deletions: 0 },
      ],
      config: `{ maxDiffLines: 100 }`,
    });
    await expect(
      reviewPullRequest({ inputs: INPUTS, context: CONTEXT, pullRequestNumber: 7, io: io(forge) }),
    ).rejects.toThrow(/past the break/);
  });
});

describe("publication", () => {
  it("publishes a complete review through one guarded upsert recording the head", async () => {
    const forge = forgeStub();
    const chat = readingChat([
      {
        content: "",
        toolCalls: [{ id: "r1", name: "read_file", arguments: '{"path":"src/a.mjs"}' }],
      },
      {
        content:
          '{"findings":[{"severity":"concern","file":"src/a.mjs","line":2,"message":"off-by-one"}],"summary":"one concern"}',
      },
    ]);
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forge, chat),
    });

    expect(result.outcome).toBe("published");
    expect(result.commentId).toBe(101);
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).toContain(`<!-- action-agents:review:`);
    expect(body).toContain(`head=${HEAD}`);
    expect(body).toContain("**Review** — Complete");
    expect(body).toContain("- `src/a.mjs:2` — off-by-one");
    expect(body).toContain("evidence: `src/a.mjs:1-4`");
    // Two reads pin the snapshot; the second guards publication.
    expect(forge.calls.getPullRequests).toHaveLength(2);
  });

  it("abandons instead of publishing when the head moved mid-review", async () => {
    let reads = 0;
    const forge = forgeStub();
    forge.getPullRequest = async () => {
      reads++;
      return snapshot(reads >= 2 ? { head: { ref: "feature", sha: "c".repeat(40) } } : {});
    };
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forge),
    });
    expect(result.outcome).toBe("abandoned");
    expect(forge.calls.upserts).toHaveLength(0);
  });

  it("abandons when the pull request closed while it was being reviewed", async () => {
    let reads = 0;
    const forge = forgeStub();
    forge.getPullRequest = async () => {
      reads++;
      return snapshot(reads >= 2 ? { state: "closed" } : {});
    };
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forge),
    });
    expect(result.outcome).toBe("abandoned");
  });
});

describe("dry run", () => {
  it("writes nothing anywhere — but logs the exact body", async () => {
    /** @type {string[]} */
    const logged = [];
    const forge = forgeStub();
    const result = await reviewPullRequest({
      inputs: { ...INPUTS, dryRun: true },
      context: CONTEXT,
      pullRequestNumber: 7,
      io: { forge, chat: chatStub(), now: () => 0, info: (m) => logged.push(m) },
    });
    expect(result.outcome).toBe("dry-run");
    expect(forge.calls.upserts).toHaveLength(0);
    expect(logged.some((line) => line.includes("**Review** — Complete"))).toBe(true);
  });
});

describe("strictness policy and strategy", () => {
  const MIXED_ANSWER =
    '{"findings":[{"severity":"concern","file":"src/a.mjs","line":2,"message":"off-by-one"},' +
    '{"severity":"nit","file":"src/a.mjs","line":1,"message":"style nit"}],"summary":"mixed"}';

  it("at low, nits leave the published set: concerns only, each drop logged", async () => {
    /** @type {string[]} */
    const logged = [];
    const forge = forgeStub({ config: '{ strictness: "low" }' });
    const chat = readingChat([
      {
        content: "",
        toolCalls: [{ id: "r1", name: "read_file", arguments: '{"path":"src/a.mjs"}' }],
      },
      { content: MIXED_ANSWER },
    ]);
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: { forge, chat, now: () => 0, info: (m) => logged.push(m) },
    });
    expect(result.outcome).toBe("published");
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).toContain("- `src/a.mjs:2` — off-by-one");
    expect(body).not.toContain("style nit");
    expect(body).not.toContain("Nits");
    expect(logged.some((line) => line.includes("nit dropped at low strictness"))).toBe(true);
  });

  it("at medium the same answer keeps its nit, and absent strategy equals explicit standard byte for byte", async () => {
    const forgeDefault = forgeStub();
    const forgeExplicit = forgeStub({ config: '{ strategy: "standard" }' });
    const reading = () =>
      readingChat([
        {
          content: "",
          toolCalls: [{ id: "r1", name: "read_file", arguments: '{"path":"src/a.mjs"}' }],
        },
        { content: MIXED_ANSWER },
      ]);
    const defaultRun = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forgeDefault, reading()),
    });
    const explicitRun = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forgeExplicit, reading()),
    });
    expect(defaultRun.outcome).toBe("published");
    expect(explicitRun.outcome).toBe("published");
    // medium+standard is today's behavior: same findings, same validation,
    // same rendered body. (The marker id is run-scoped, so the comparison
    // starts after the marker line.)
    const afterMarker = (/** @type {{ body?: string } | undefined} */ upsert) =>
      (upsert?.body ?? "").split("\n").slice(1).join("\n");
    expect(afterMarker(forgeExplicit.calls.upserts[0])).toBe(
      afterMarker(forgeDefault.calls.upserts[0]),
    );
    const body = forgeDefault.calls.upserts[0]?.body ?? "";
    expect(body).toContain("<details>");
    expect(body).toContain("- `src/a.mjs:1` — style nit");
  });

  it("adversarial+high: the system message carries both mode paragraphs", async () => {
    /** @type {{ messages?: import("#core/chat.mjs").ChatMessage[] }[]} */
    const requests = [];
    const chat =
      /** @type {import("#core/chat.mjs").Chat} */
      ({
        async complete(request) {
          requests.push(request);
          return { content: MIXED_ANSWER, toolCalls: [], finishReason: "stop" };
        },
      });
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forgeStub({ config: '{ strictness: "high", strategy: "adversarial" }' }), chat),
    });
    expect(result.outcome).toBe("published");
    expect(requests).toHaveLength(1);
    const system = requests[0]?.messages?.find((message) => message.role === "system")?.content;
    expect(system).toContain('strictness "high"');
    expect(system).toContain('Review strategy — "adversarial"');
    expect(system).toContain("hypotheses pending");
  });
});

describe("failure posture", () => {
  it("fails red on a twice-invalid final answer and writes nothing", async () => {
    const forge = forgeStub();
    const bad = chatStub("this is prose, not JSON");
    await expect(
      reviewPullRequest({
        inputs: INPUTS,
        context: CONTEXT,
        pullRequestNumber: 7,
        io: io(forge, bad),
      }),
    ).rejects.toThrow(/failed the output contract twice/);
    expect(forge.calls.upserts).toHaveLength(0);
  });

  it("fails red when the prompt cannot fit half the window", async () => {
    const forge = forgeStub({
      files: Array.from({ length: 30 }, (_, i) => ({
        filename: `f${String(i)}.mjs`,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "x".repeat(4000),
      })),
    });
    await expect(
      reviewPullRequest({
        inputs: { ...INPUTS, contextWindow: 2000 },
        context: CONTEXT,
        pullRequestNumber: 7,
        io: io(forge),
      }),
    ).rejects.toThrow(/past half the .*window/);
    expect(forge.calls.upserts).toHaveLength(0);
  });

  it("re-asks once after a natural stop, then accepts the corrected answer", async () => {
    let asks = 0;
    const forge = forgeStub();
    const chatty = {
      complete: async () => {
        asks++;
        return {
          content: asks === 1 ? "prose first" : '{"findings":[],"summary":"clean now"}',
          toolCalls: [],
          finishReason: "stop",
        };
      },
    };
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: { forge, chat: /** @type {any} */ (chatty), now: () => 0, info: () => undefined },
    });
    expect(asks).toBe(2);
    expect(result.outcome).toBe("published");
  });
});

describe("comment identity", () => {
  it("claims its own prior comment under an App-token identity", async () => {
    const forge = forgeStub({ whoamiLogin: "docs-bot[bot]" });
    forge.listComments = async () => [
      {
        id: 55,
        body: `<!-- action-agents:review:0badcafe:head=${HEAD} -->old findings`,
        user: { login: "docs-bot[bot]" },
        created_at: "",
        updated_at: "",
      },
    ];

    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forge),
    });

    expect(result.outcome).toBe("published");
    expect(forge.calls.upserts[0]?.id).toBe(55);
  });

  it("falls back to github-actions[bot] when the identity read fails and leaves the foreign marker alone", async () => {
    /** @type {string[]} */
    const logged = [];
    const forge = forgeStub({ whoamiError: new Error("the token's identity read failed") });
    forge.listComments = async () => [
      {
        id: 55,
        body: `<!-- action-agents:review:0badcafe:head=${HEAD} -->old findings`,
        user: { login: "docs-bot[bot]" },
        created_at: "",
        updated_at: "",
      },
    ];

    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: { forge, chat: chatStub(), now: () => 1_000, info: (m) => logged.push(m) },
    });

    expect(result.outcome).toBe("published");
    // Created fresh — the docs-bot comment is foreign under the fallback
    // identity, and the upsert never claims what it did not author.
    expect(forge.calls.upserts[0]?.id).toBeUndefined();
    expect(logged.some((line) => line.includes("assuming github-actions[bot]"))).toBe(true);
  });
});

describe("coverage accounting and strict partial reviews", () => {
  const TWO_FILES = [
    {
      filename: "src/a.mjs",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1,2 @@\n+x",
    },
    {
      filename: "src/b.mjs",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1,2 @@\n+y",
    },
  ];

  it("at high strictness, a review that read nothing publishes as partial naming the gap", async () => {
    const forge = forgeStub({ files: TWO_FILES, config: '{ strictness: "high" }' });
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forge),
    });
    expect(result.outcome).toBe("published");
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).toContain("This review is partial");
    expect(body).toContain("2 of 2 changed files were never read: src/a.mjs, src/b.mjs.");
    expect(body).toContain("Changed files examined: 0/2.");
  });

  it("at the standard arm, zero coverage still completes — the count line rides along", async () => {
    const forge = forgeStub({ files: TWO_FILES });
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forge),
    });
    expect(result.outcome).toBe("published");
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).toContain("**Review** — Complete");
    expect(body).not.toContain("partial");
    expect(body).toContain("Changed files examined: 0/2.");
  });

  it("at high strictness, reading both expected files concludes complete at 2/2", async () => {
    const forge = forgeStub({ files: TWO_FILES, config: '{ strictness: "high" }' });
    const chat = readingChat([
      {
        content: "",
        toolCalls: [
          { id: "c1", name: "read_file", arguments: '{"path":"src/a.mjs"}' },
          { id: "c2", name: "read_file", arguments: '{"path":"src/b.mjs"}' },
        ],
      },
      { content: '{"findings":[],"summary":"read everything"}' },
    ]);
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forge, chat),
    });
    expect(result.outcome).toBe("published");
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).toContain("**Review** — Complete");
    expect(body).toContain("Changed files examined: 2/2.");
  });

  it("a summary that claims completeness cannot outvote the ledger", async () => {
    const forge = forgeStub({ files: TWO_FILES, config: '{ strictness: "high" }' });
    const chat = chatStub('{"findings":[],"summary":"every changed file was examined in full"}');
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forge, chat),
    });
    expect(result.outcome).toBe("published");
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).toContain("This review is partial");
    expect(body).toContain("never read");
  });

  it("a derivation that cannot account for the whole universe refuses the run", async () => {
    const forge = forgeStub({
      files: [
        {
          filename: "lib/gone.mjs",
          status: "removed",
          additions: 0,
          deletions: 1,
          patch: "@@ -1,1 +1,0 @@\n-x\n--- a/ghost.mjs",
        },
      ],
    });
    await expect(
      reviewPullRequest({ inputs: INPUTS, context: CONTEXT, pullRequestNumber: 7, io: io(forge) }),
    ).rejects.toThrow(/cannot account for the whole universe/);
  });
});

describe("risk lanes", () => {
  const LANED_FILES = [
    {
      filename: "src/a.mjs",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: "@@ -1 +1,2 @@\n+x",
    },
    {
      filename: "src/auth/login.ts",
      status: "modified",
      additions: 4,
      deletions: 0,
      patch: "@@ -1 +1,5 @@\n+token()",
    },
  ];

  it("renders code-assigned lanes into the assembled prompt as data", async () => {
    const forge = forgeStub({ files: LANED_FILES });
    const chat = capturingChat();
    await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forge, chat),
    });
    const [system, user] = chat.captured[0] ?? [];
    // The procedure is code-authored prose: attention weighting, never an
    // exemption, and the mode paragraphs stay authoritative.
    expect(system?.content).toContain("Review lanes");
    expect(system?.content).toContain("a lane is not an exemption");
    expect(system?.content).toContain("every changed file still counts toward coverage");
    expect(system?.content).toContain("The mode paragraphs above stay authoritative");
    // maxTurns 5 over two occupied lanes: deep 3, skim 2 — remainder deepest-first.
    expect(system?.content).toContain("deep: 3, standard: 0, skim: 2");
    // The assignments themselves ride as data on the inventory lines.
    const lines = (user?.content ?? "").split("\n");
    expect(lines).toContain("- src/a.mjs (+2/-1, modified, lane: skim)");
    expect(lines).toContain("- src/auth/login.ts (+4/-0, modified, lane: deep)");
  });

  it("a skim-lane file stays in the coverage universe — attention, not exemption", async () => {
    const forge = forgeStub({ files: LANED_FILES, config: '{ strictness: "high" }' });
    const chat = capturingChat(); // reads nothing, answers at once
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forge, chat),
    });
    expect(result.outcome).toBe("published");
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).toContain("This review is partial");
    expect(body).toContain("2 of 2 changed files were never read: src/a.mjs, src/auth/login.ts.");
  });
});

describe("adversarial verification pass", () => {
  const CONCERN_ANSWER =
    '{"findings":[{"severity":"concern","file":"src/a.mjs","line":2,"message":"off-by-one"}],"summary":"one concern"}';
  const READ =
    /** @type {{ content: string, toolCalls: { id: string, name: string, arguments: string }[] }} */ ({
      content: "",
      toolCalls: [{ id: "r1", name: "read_file", arguments: '{"path":"src/a.mjs"}' }],
    });

  /**
   * A chat stub scripted turn by turn that records every request's messages
   * — the loop's reads and finals, then the pass's verdict calls.
   *
   * @param {Array<{ content: string, toolCalls?: { id: string, name: string, arguments: string }[] }>} script
   * @returns {import("#core/chat.mjs").Chat & { calls: import("#core/chat.mjs").ChatMessage[][] }}
   */
  function scriptedChat(script) {
    /** @type {import("#core/chat.mjs").ChatMessage[][]} */
    const calls = [];
    return {
      calls,
      async complete(request) {
        calls.push(request.messages);
        const next = script.shift();
        if (next === undefined) throw new Error("script exhausted");
        return {
          content: next.content,
          toolCalls: next.toolCalls ?? [],
          finishReason: next.toolCalls !== undefined ? "tool_calls" : "stop",
        };
      },
    };
  }

  it("verifies a planned finding once and drops a refuted one from the comment, logging its identity", async () => {
    const forge = forgeStub();
    const chat = scriptedChat([
      READ,
      { content: CONCERN_ANSWER },
      { content: '{"verdict":"refuted","reason":"the line is correct"}' },
    ]);
    /** @type {string[]} */
    const logged = [];
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: { forge, chat, now: () => 0, info: (m) => logged.push(m) },
    });
    expect(result.outcome).toBe("published");
    expect(result.reason).toContain("(0 findings)");
    // Read turn, final answer, one verdict call — bounded, no retries.
    expect(chat.calls).toHaveLength(3);
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).not.toContain("off-by-one");
    expect(
      logged.some(
        (line) =>
          line.includes("refuted") && line.includes("src/a.mjs:2") && line.includes("(finding 1)"),
      ),
    ).toBe(true);
    // The verdict call carries the code-authored contract and wrapped evidence.
    const [system, user] = chat.calls[2] ?? [];
    expect(system?.content).toContain('"confirmed"|"refuted"|"uncertain"');
    expect(user?.content).toContain("[evidence:");
  });

  it("verifies only planned findings — a skim-lane nit at standard strategy never reaches a verdict call", async () => {
    const forge = forgeStub();
    const chat = scriptedChat([
      READ,
      {
        content:
          '{"findings":[{"severity":"nit","file":"src/a.mjs","line":2,"message":"a nit"}],"summary":"one nit"}',
      },
    ]);
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: io(forge, chat),
    });
    expect(result.outcome).toBe("published");
    expect(chat.calls).toHaveLength(2);
    expect(forge.calls.upserts[0]?.body).toContain("a nit");
  });

  it("a failed verification call counts as uncertain and publishes unchanged", async () => {
    const forge = forgeStub();
    const chat = scriptedChat([READ, { content: CONCERN_ANSWER }]); // verdict call throws: exhausted
    /** @type {string[]} */
    const logged = [];
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: { forge, chat, now: () => 0, info: (m) => logged.push(m) },
    });
    expect(result.outcome).toBe("published");
    expect(chat.calls).toHaveLength(3);
    expect(forge.calls.upserts[0]?.body).toContain("off-by-one");
    expect(logged.some((line) => line.includes("counts as uncertain"))).toBe(true);
  });

  it("a refused verdict answer counts as uncertain and publishes unchanged", async () => {
    const forge = forgeStub();
    const chat = scriptedChat([
      READ,
      { content: CONCERN_ANSWER },
      { content: '{"verdict":"confirmed","reason":"ok","extra":1}' },
    ]);
    /** @type {string[]} */
    const logged = [];
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: { forge, chat, now: () => 0, info: (m) => logged.push(m) },
    });
    expect(result.outcome).toBe("published");
    expect(forge.calls.upserts[0]?.body).toContain("off-by-one");
    expect(logged.some((line) => line.includes("was refused"))).toBe(true);
  });

  it("the strict arm drops an uncertain verdict", async () => {
    const forge = forgeStub({ config: '{ strictness: "high", strategy: "adversarial" }' });
    const chat = scriptedChat([
      READ,
      {
        content:
          '{"findings":[{"severity":"concern","file":"src/a.mjs","line":2,"message":"off-by-one"},{"severity":"nit","file":"src/a.mjs","line":3,"message":"a nit"}],"summary":"two"}',
      },
      { content: '{"verdict":"uncertain","reason":"insufficient"}' },
      { content: '{"verdict":"uncertain","reason":"insufficient"}' },
    ]);
    /** @type {string[]} */
    const logged = [];
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: { forge, chat, now: () => 0, info: (m) => logged.push(m) },
    });
    expect(result.outcome).toBe("published");
    // Adversarial + high: every finding planned, one call each.
    expect(chat.calls).toHaveLength(4);
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).not.toContain("off-by-one");
    expect(body).not.toContain("a nit");
    expect(logged.filter((line) => line.includes("uncertain, dropped"))).toHaveLength(2);
  });

  it("an empty plan is a no-op — no verdict calls, findings published unchanged", async () => {
    const forge = forgeStub();
    const readChat = scriptedChat([
      READ,
      {
        content:
          '{"findings":[{"severity":"nit","file":"src/a.mjs","line":2,"message":"a nit"}],"summary":"one nit"}',
      },
    ]);
    /** @type {string[]} */
    const logged = [];
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: { forge, chat: readChat, now: () => 0, info: (m) => logged.push(m) },
    });
    expect(result.outcome).toBe("published");
    // Read turn, final answer — the unplannable nit never earns a call.
    expect(readChat.calls).toHaveLength(2);
    expect(forge.calls.upserts[0]?.body).toContain("a nit");
    expect(logged.some((line) => line.includes("planned 0 of 1 finding(s)"))).toBe(true);
  });
});

describe("evidence provenance", () => {
  it("quarantines an unanchored finding — absent from the comment, present in the log with its identity", async () => {
    const forge = forgeStub();
    /** @type {string[]} */
    const logged = [];
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: { forge, chat: chatStub(), now: () => 0, info: (m) => logged.push(m) },
    });
    expect(result.outcome).toBe("published");
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).not.toContain("off-by-one");
    expect(body).toContain("No findings.");
    expect(
      logged.some(
        (line) =>
          line.includes("finding quarantined") &&
          line.includes("unanchored") &&
          line.includes("src/a.mjs:2"),
      ),
    ).toBe(true);
  });

  it("with an empty ledger, every finding is quarantined and the run still concludes through the normal path", async () => {
    const forge = forgeStub();
    /** @type {string[]} */
    const logged = [];
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: {
        forge,
        chat: chatStub(
          '{"findings":[{"severity":"concern","file":"src/a.mjs","line":2,"message":"off-by-one"},' +
            '{"severity":"nit","file":"src/a.mjs","line":1,"message":"style nit"}],"summary":"two findings"}',
        ),
        now: () => 0,
        info: (m) => logged.push(m),
      },
    });
    expect(result.outcome).toBe("published");
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).toContain("No findings.");
    expect(
      logged.filter((line) => line.includes("finding quarantined") && line.includes("unanchored")),
    ).toHaveLength(2);
  });
});

describe("run gates", () => {
  const TWO_FILES = [
    {
      filename: "src/a.mjs",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1,2 @@\n+x",
    },
    {
      filename: "src/b.mjs",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1,2 @@\n+y",
    },
  ];

  /**
   * @param {import("./run.mjs").ReviewForge} forge
   * @param {import("#core/chat.mjs").Chat} chat
   * @param {(line: string) => void} info
   */
  function loggingIo(forge, chat, info) {
    return { forge, chat, now: () => 0, info };
  }

  it("attributes a strict-coverage refusal to the coverage gate and still publishes partial", async () => {
    /** @type {string[]} */
    const logged = [];
    const forge = forgeStub({ files: TWO_FILES, config: '{ strictness: "high" }' });
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: loggingIo(forge, chatStub(), (line) => logged.push(line)),
    });
    expect(result.outcome).toBe("published");
    expect(logged).toContain(
      "review: gate coverage failed — 2 of 2 changed files were never read: src/a.mjs, src/b.mjs.",
    );
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).toContain("This review is partial");
    expect(body).toContain("2 of 2 changed files were never read: src/a.mjs, src/b.mjs.");
  });

  it("attributes an exhausted turn budget to the bound gate in the log and the body", async () => {
    /** @type {string[]} */
    const logged = [];
    const forge = forgeStub();
    const chat = readingChat([
      {
        content: "",
        toolCalls: [{ id: "t1", name: "read_file", arguments: '{"path":"src/a.mjs"}' }],
      },
      {
        content: "",
        toolCalls: [{ id: "t2", name: "read_file", arguments: '{"path":"src/a.mjs"}' }],
      },
      {
        content: "",
        toolCalls: [{ id: "t3", name: "read_file", arguments: '{"path":"src/a.mjs"}' }],
      },
      {
        content: "",
        toolCalls: [{ id: "t4", name: "read_file", arguments: '{"path":"src/a.mjs"}' }],
      },
      {
        content: "",
        toolCalls: [{ id: "t5", name: "read_file", arguments: '{"path":"src/a.mjs"}' }],
      },
      { content: '{"findings":[],"summary":"out of turns"}' },
    ]);
    const result = await reviewPullRequest({
      inputs: INPUTS, // maxTurns: 5 — the script's fifth reading turn fires the bound
      context: CONTEXT,
      pullRequestNumber: 7,
      io: loggingIo(forge, chat, (line) => logged.push(line)),
    });
    expect(result.outcome).toBe("published");
    expect(logged).toContain(
      "review: gate bound failed — the reading-turn budget was reached before the reviewer stopped asking questions.",
    );
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).toContain("This review is partial");
    expect(body).toContain(
      "the reading-turn budget was reached before the reviewer stopped asking questions.",
    );
  });

  it("a run whose gates all pass publishes complete and logs no gate refusals", async () => {
    /** @type {string[]} */
    const logged = [];
    const forge = forgeStub({ files: TWO_FILES });
    const chat = readingChat([
      {
        content: "",
        toolCalls: [
          { id: "c1", name: "read_file", arguments: '{"path":"src/a.mjs"}' },
          { id: "c2", name: "read_file", arguments: '{"path":"src/b.mjs"}' },
        ],
      },
      { content: '{"findings":[],"summary":"read everything"}' },
    ]);
    const result = await reviewPullRequest({
      inputs: INPUTS,
      context: CONTEXT,
      pullRequestNumber: 7,
      io: loggingIo(forge, chat, (line) => logged.push(line)),
    });
    expect(result.outcome).toBe("published");
    expect(logged.some((line) => line.startsWith("review: gate"))).toBe(false);
    const body = forge.calls.upserts[0]?.body ?? "";
    expect(body).toContain("**Review** — Complete");
  });

  it("attributes a twice-invalid answer to the conclusion gate before any verification spend", async () => {
    /** @type {string[]} */
    const logged = [];
    let completeCalls = 0;
    const chat = {
      async complete() {
        completeCalls++;
        return { content: "prose, not JSON", toolCalls: [], finishReason: "stop" };
      },
    };
    const forge = forgeStub();
    await expect(
      reviewPullRequest({
        inputs: INPUTS,
        context: CONTEXT,
        pullRequestNumber: 7,
        io: loggingIo(forge, /** @type {any} */ (chat), (line) => logged.push(line)),
      }),
    ).rejects.toThrow(/failed the output contract twice/);
    expect(logged).toContain("review: gate conclusion failed — the answer holds no JSON object");
    // Exactly the first ask and the one re-ask: the conclusion gate's refusal
    // fires before validation, verification or publication spend a call.
    expect(completeCalls).toBe(2);
  });
});
