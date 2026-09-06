/**
 * Shared replay fixtures for the canonical-pipeline E2E suites: the three
 * suites that pin one published review's surfaces against each other and
 * against its attackers. Every replay here is a full `reviewPullRequest` —
 * a temp workspace, a scripted chat, a recording forge — deterministic and
 * offline, the same shape the canonical-gate fixtures use, factored once.
 *
 * Nothing here weakens a unit seam: the fixtures script the two honest
 * inputs a run has (what the model says, what the forge returns) and then
 * assert whatever the pipeline itself wrote.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import { readContext } from "#core/runtime.mjs";

import { readInputs, run } from "./index.mjs";
import { reviewPullRequest } from "./run.mjs";

/** The reviewed head — every replay judges this sha and no other. */
export const HEAD = "a".repeat(40);
/** The base head the policy source pins to. */
export const BASE = "b".repeat(40);
/** A foreign head a forged record may claim. */
export const FOREIGN = "c".repeat(40);
/** The head a push lands under a run that is still in flight. */
export const MOVED = "d".repeat(40);

/** The run inputs every replay carries — the happy-path knobs, nothing exotic. */
export const INPUTS = {
  model: "review",
  maxTurns: 5,
  contextWindow: 128_000,
  dryRun: false,
  configPath: "",
};

/** The parsed pull_request payload every replay resolves its policy from. */
export const EVENT = {
  action: "synchronize",
  pull_request: { number: 7, base: { ref: "main", sha: "8".repeat(40) } },
};

/** @typedef {import("#core/forge.mjs").PullRequestSnapshot} PullRequestSnapshot */

/** One temp root per workspace; every suite drains them in its own afterAll. */
/** @type {string[]} */
const roots = [];

/** Disposes every workspace the suite's replays created. Call from afterAll. */
export function drainWorkspaces() {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots.length = 0;
}

/**
 * A checked-out-looking root holding the named repo-relative files.
 *
 * @param {Record<string, string>} files repo-relative path → bytes
 * @returns {string} the workspace root
 */
export function makeWorkspace(files) {
  const root = mkdtempSync(join(tmpdir(), "e2e-review-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

/**
 * A pull-request snapshot over HEAD, the one shape a happy-path run reads.
 *
 * @param {Partial<PullRequestSnapshot>} [over]
 * @returns {PullRequestSnapshot}
 */
export function snapshot(over = {}) {
  return {
    number: 7,
    state: "open",
    draft: false,
    merged: false,
    title: "the change",
    body: "",
    mergeable: true,
    mergeableState: "clean",
    labels: [],
    head: { ref: "feature", sha: HEAD },
    base: { ref: "main", sha: BASE },
    ...over,
  };
}

/**
 * A changed-file entry matching the workspace bytes a replay anchors against.
 *
 * @param {string} filename repo-relative path
 * @param {Partial<import("#core/forge.mjs").PullRequestFile>} [over]
 * @returns {import("#core/forge.mjs").PullRequestFile}
 */
export function changedFile(filename, over = {}) {
  return {
    filename,
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: "@@ -1 +1,2 @@\n+x",
    ...over,
  };
}

/**
 * A chat that serves its script in order and refuses to improvise: a call
 * past the script's end is a test bug, so it throws. A step carrying
 * `toolCalls` finishes as a tool turn; everything else is a natural stop.
 *
 * @param {Array<{ content?: string, toolCalls?: Array<{ id: string, name: string, arguments: string }> }>} steps
 * @returns {import("#core/chat.mjs").Chat & { calls: () => number }}
 */
export function scriptedChat(steps) {
  let cursor = 0;
  return {
    /** How many requests the run has made so far. */
    calls: () => cursor,
    async complete() {
      const next = steps[cursor];
      cursor += 1;
      if (next === undefined) {
        throw new Error(`chat script exhausted after ${String(cursor)} call(s)`);
      }
      return {
        content: next.content ?? "",
        toolCalls: next.toolCalls ?? [],
        finishReason: next.toolCalls !== undefined ? "tool_calls" : "stop",
      };
    },
  };
}

/** A one-turn reading script: the loop's read_file over one path. */
/** @param {string} path */
export function readTurn(path) {
  return { toolCalls: [{ id: "r1", name: "read_file", arguments: JSON.stringify({ path }) }] };
}

/**
 * A recording forge covering every read a full happy-path run makes, and
 * recording every write the run attempts — the evidence the suites judge.
 * Snapshots are served from a queue, repeating the last entry, so a run
 * that re-reads mid-flight sees a stable subject unless the test stages a
 * move.
 *
 * @typedef {import("./run.mjs").ReviewForge & {
 *   calls: {
 *     pullRequests: string[],
 *     upserts: Array<{ op: string, id?: number, body?: string }>,
 *     checkRuns: Array<{ headSha: string, name: string, conclusion: string, output: { title: string, summary: string } }>,
 *   },
 * }} RecordingForge
 *
 * @param {{ files?: import("#core/forge.mjs").PullRequestFile[], config?: string, documents?: Record<string, string>, comments?: import("#core/forge.mjs").CommentEntry[], snapshotQueue?: PullRequestSnapshot[], repoDescription?: string }} [options]
 * @returns {RecordingForge}
 */
export function forgeStub(options = {}) {
  const calls = {
    /** @type {string[]} */
    pullRequests: [],
    /** @type {Array<{ op: string, id?: number, body?: string }>} */
    upserts: [],
    /** @type {Array<{ headSha: string, name: string, conclusion: string, output: { title: string, summary: string } }>} */
    checkRuns: [],
  };
  const snapshots = options.snapshotQueue ?? [snapshot()];
  return {
    calls,
    async getPullRequest() {
      const snap = /** @type {PullRequestSnapshot} */ (
        snapshots[Math.min(calls.pullRequests.length, snapshots.length - 1)]
      );
      calls.pullRequests.push(snap.head.sha);
      return snap;
    },
    async getRepository() {
      return { defaultBranch: "main", name: "widgets", description: options.repoDescription ?? "" };
    },
    async getRef(/** @type {string} */ branch) {
      if (branch !== "main") throw new Error(`unexpected ref lookup '${branch}'`);
      return { sha: "7".repeat(40) };
    },
    async getContents(/** @type {string} */ path) {
      const documents = options.documents ?? {};
      if (documents[path] !== undefined) return { content: documents[path] };
      if (path.endsWith("review.json5")) {
        return options.config === undefined ? null : { content: options.config };
      }
      if (path.endsWith("review.json")) return null;
      if (path.includes("instruction")) return null;
      return null;
    },
    async listPullRequestFiles() {
      return options.files ?? [changedFile("src/a.mjs")];
    },
    async listComments() {
      return options.comments ?? [];
    },
    async whoami() {
      return { login: "github-actions[bot]" };
    },
    async createComment(_number, body) {
      calls.upserts.push({ op: "created", id: 101, body });
      return { id: 101 };
    },
    async updateComment(id, body) {
      calls.upserts.push({ op: "updated", id, body });
    },
    async deleteComment() {},
    async createCheckRun(input) {
      calls.checkRuns.push(input);
      return { id: 501 };
    },
  };
}

/**
 * The io a replay runs over: a frozen clock, a silenced log that keeps
 * every line for the tests that assert what the run said about itself.
 *
 * @param {RecordingForge} forge
 * @param {import("#core/chat.mjs").Chat} chat
 * @returns {{ io: import("./run.mjs").Io, log: string[] }}
 */
export function replayIo(forge, chat) {
  /** @type {string[]} */
  const log = [];
  return { io: { forge, chat, now: () => 0, info: (line) => void log.push(line) }, log };
}

/** The context a replay runs against — owner, repo, and the fresh workspace. */
/** @param {string} workspace */
export function context(workspace) {
  return { owner: "acme", repo: "widgets", workspace };
}

/**
 * The runner-shaped env the entrypoint tests drive `run` over: a real event
 * payload file, the workspace a replay's bytes live in, and no gate-mode
 * unless the test demands one.
 *
 * @param {{ workspace: string, event?: unknown, extra?: Record<string, string> }} options
 * @returns {Record<string, string>}
 */
export function runnerEnv(options) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-entry-"));
  roots.push(dir);
  const eventPath = join(dir, "event.json");
  writeFileSync(
    eventPath,
    JSON.stringify(options.event ?? { action: "synchronize", pull_request: EVENT.pull_request }),
  );
  return {
    "INPUT_GITHUB-TOKEN": "ghs_x",
    "INPUT_API-URL": "https://llm.example/v1",
    "INPUT_API-KEY": "sk-secret",
    INPUT_MODEL: "review",
    GITHUB_REPOSITORY: "acme/widgets",
    GITHUB_WORKSPACE: options.workspace,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_API_URL: "https://api.github.com",
    ...options.extra,
  };
}

/**
 * The marker line a review's own comment carries — the exact shape
 * `markerLine` renders for this action, with the run-scoped id slot left
 * explicit so tests can pin the structure while the id varies.
 *
 * @param {string} id the run-scoped marker id (12 hex)
 * @param {string} head the head the comment records
 * @returns {string}
 */
export function reviewMarker(id, head) {
  return `<!-- action-agents:review:${id}:head=${head} -->`;
}

/** The bytes of `src/a.mjs` as the scenario workspaces write them. */
export const A_CONTENT = "line1\nline2\nline3\n";

/** @typedef {import("./run.mjs").RunResult} RunResult */

/**
 * The canonical concern scenario, replayed end to end: one read turn, one
 * finding (`concern`/`correctness` at `src/a.mjs:2`), one confirming
 * verdict. The published comment, the SARIF projection and the gate all
 * read the one record this replay returns.
 *
 * @returns {Promise<{ workspace: string, forge: ReturnType<typeof forgeStub>, chat: ReturnType<typeof scriptedChat>, log: string[], result: RunResult }>}
 */
export async function confirmedConcern() {
  const workspace = makeWorkspace({ "src/a.mjs": A_CONTENT });
  const forge = forgeStub();
  const chat = scriptedChat([
    readTurn("src/a.mjs"),
    {
      content:
        '{"findings":[{"severity":"concern","kind":"correctness","file":"src/a.mjs","line":2,' +
        '"message":"off-by-one"}],"summary":"one concern"}',
    },
    { content: '{"verdict":"confirmed","kind":"correctness","reason":"the guard is missing"}' },
  ]);
  const { io, log } = replayIo(forge, chat);
  const result = await reviewPullRequest({
    inputs: INPUTS,
    context: context(workspace),
    pullRequestNumber: 7,
    eventName: "pull_request",
    event: EVENT,
    io,
  });
  return { workspace, forge, chat, log, result };
}

/**
 * The clean scenario: every changed file read, no findings at all — the
 * only shape a PASS verdict honestly comes from.
 *
 * @returns {Promise<{ workspace: string, forge: ReturnType<typeof forgeStub>, chat: ReturnType<typeof scriptedChat>, log: string[], result: RunResult }>}
 */
export async function cleanRun() {
  const workspace = makeWorkspace({ "src/a.mjs": A_CONTENT });
  const forge = forgeStub();
  const chat = scriptedChat([
    readTurn("src/a.mjs"),
    { content: '{"findings":[],"summary":"nothing to report"}' },
  ]);
  const { io, log } = replayIo(forge, chat);
  const result = await reviewPullRequest({
    inputs: INPUTS,
    context: context(workspace),
    pullRequestNumber: 7,
    eventName: "pull_request",
    event: EVENT,
    io,
  });
  return { workspace, forge, chat, log, result };
}

// ── The entrypoint harness: the three surfaces behind `main()` ──

/** @type {string[]} */
const entryTempDirs = [];

/** Frees the entrypoint harness's runner-temp directories. Call in afterAll. */
export function drainEntryTemps() {
  for (const dir of entryTempDirs) rmSync(dir, { recursive: true, force: true });
}

/**
 * Drives the action's entrypoint over a scripted replay and reports both
 * endings the same way, plus where the runner's surfaces landed: the gate
 * output file and a runner temp that only a SARIF write could fill.
 *
 * @param {{ workspace: string, forge: ReturnType<typeof forgeStub>, chat: import("#core/chat.mjs").Chat, gateMode?: "observe" | "required" }} setup
 * @returns {Promise<{ ok: boolean, result: import("./run.mjs").RunResult | undefined, cause: unknown, outFile: string, temp: string }>}
 */
export async function driveEntrypoint(setup) {
  const temp = mkdtempSync(join(tmpdir(), "e2e-entrypoint-"));
  entryTempDirs.push(temp);
  const outFile = join(temp, "github-output.txt");
  writeFileSync(outFile, "");
  // The runner's output file rides process.env: the core runtime's
  // setOutput defaults there, so the harness stubs it around the run.
  vi.stubEnv("GITHUB_OUTPUT", outFile);
  try {
    const env = runnerEnv({
      workspace: setup.workspace,
      extra: {
        RUNNER_TEMP: temp,
        ...(setup.gateMode === undefined ? {} : { "INPUT_GATE-MODE": setup.gateMode }),
      },
    });
    const settled = await run(readInputs(env), readContext(env), {
      forge: setup.forge,
      chat: setup.chat,
      now: () => 0,
      info: () => undefined,
    }).then(
      (result) => ({ ok: true, value: result, error: undefined }),
      (error) => ({ ok: false, value: undefined, error }),
    );
    return { ok: settled.ok, result: settled.value, cause: settled.error, outFile, temp };
  } finally {
    vi.unstubAllEnvs();
  }
}

/**
 * Reads the run artifact the entrypoint wrote into the workspace.
 *
 * @param {string} workspace
 * @param {string} name
 * @returns {any}
 */
export function artifactOf(workspace, name) {
  return JSON.parse(readFileSync(join(workspace, ".review-artifact", name), "utf8"));
}
