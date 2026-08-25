// Tests for the `triage` pipeline.
//
// The model seam is stubbed — no model is ever called from a test — and the
// forge is a recording fake, so what these tests pin is the pipeline's own
// behaviour: what reaches the model, what is refused before it, what a
// dry run does not write, and the write surface itself, which is labels and
// one comment and nothing else. The security-relevant edges each have a
// test: narrowing never widens, off-sheet answers are refused not coerced,
// size is measured from the listing and replaced, never asked and added.

import { afterEach, describe, expect, it, vi } from "vitest";

import { createEvidence } from "#core/untrusted.mjs";
import { PastFileCeilingError } from "#core/forge.mjs";
import { readContext } from "#core/runtime.mjs";

import { ACTION, main, readInputs, run } from "./index.mjs";

/**
 * A complete runner environment, from which each test removes what it is about.
 *
 * @type {import("#core/runtime.mjs").Env}
 */
const runner = {
  "INPUT_GITHUB-TOKEN": "ghs_x",
  "INPUT_API-URL": "https://api.example/v1",
  "INPUT_API-KEY": "sk-secret",
  INPUT_MODEL: "gpt-x",
  GITHUB_REPOSITORY: "ecoma-io/action-agents",
  GITHUB_WORKSPACE: "/work",
  GITHUB_EVENT_NAME: "issues",
  GITHUB_EVENT_PATH: "/work/event.json",
};

/** The repo's own sheet: universal ∪ issues for an issue, universal ∪ pr for a PR. */
const CONFIG = JSON.stringify({
  labels: {
    universal: { bug: "Incorrect behaviour.", docs: "Documentation only." },
    issues: { question: "Asking, not reporting." },
    pr: {
      breaking: "Consumers must act.",
      "size/xs": "",
      "size/s": "",
      "size/xl": "",
    },
  },
  size: {
    exclude: ["pnpm-lock.yaml"],
    ladder: [{ upTo: 10, label: "size/xs" }, { upTo: 50, label: "size/s" }, { label: "size/xl" }],
  },
});

const REPO_LABELS = ["bug", "docs", "question", "breaking", "size/xs", "size/s", "size/xl"];

const LABELS_ANSWER = '{"labels":["bug"],"rationale":"Fails on import."}';
const COMMENT_ANSWER = '{"classification":"bug report","rationale":"Fails on import."}';

/** @param {{ number?: number, labels?: string[], type?: "issue" | "pr" }} [thread] */
function issueEvent(thread = {}) {
  return {
    issue: {
      number: thread.number ?? 7,
      title: "Import fails on Node 24",
      body: "Steps to reproduce.",
      labels: (thread.labels ?? []).map((name) => ({ name })),
    },
    repository: { name: "action-agents", description: "AI GitHub Actions" },
  };
}

/** @param {{ number?: number, labels?: string[] }} [thread] */
function prEvent(thread = {}) {
  return {
    pull_request: {
      number: thread.number ?? 8,
      title: "Fix the import",
      body: "What changed.",
      labels: (thread.labels ?? []).map((name) => ({ name })),
    },
    repository: { name: "action-agents", description: "AI GitHub Actions" },
  };
}

/**
 * A recording forge: reads answer from tables, writes append to `writes`.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.files] path → content, default branch
 * @param {string[] | null} [options.repoLabels] null skips the check's read
 * @param {import("#core/forge.mjs").PullRequestFile[]} [options.prFiles]
 * @param {{ login: string }[]} [options.comments] existing comments, marker-shaped
 * @param {Error} [options.writeFailure] thrown by every write
 */
function fakeForge(options = {}) {
  const files = options.files ?? { ".github/action-agents/triage/triage.json5": CONFIG };
  const repoLabels = options.repoLabels ?? REPO_LABELS;
  /** @type {string[]} */
  const reads = [];
  /** @type {{ op: string, args: unknown[] }[]} */
  const writes = [];
  let commentId = 100;
  const comments = (options.comments ?? []).map((comment, index) => ({
    id: index + 1,
    body: "",
    user: comment,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }));

  const fail = () => {
    if (options.writeFailure) throw options.writeFailure;
  };

  return {
    reads,
    writes,
    async whoami() {
      return { login: "action-agents[bot]" };
    },
    /** @param {string} path */
    async getContents(path) {
      reads.push(path);
      const content = files[path];
      return content === undefined ? null : { content };
    },
    async listRepositoryLabels() {
      return repoLabels ?? [];
    },
    /** @param {number} number */
    async listPullRequestFiles(number) {
      if (options.prFiles !== undefined && options.prFiles.length >= 3000) {
        throw new PastFileCeilingError(number, options.prFiles.length);
      }
      return options.prFiles ?? [];
    },
    /** @param {number} number @param {string[]} names */
    async addLabels(number, names) {
      fail();
      writes.push({ op: "addLabels", args: [number, names] });
    },
    /** @param {number} number @param {string} name */
    async removeLabel(number, name) {
      fail();
      writes.push({ op: "removeLabel", args: [number, name] });
    },
    async listComments() {
      return comments.map((comment) => ({ ...comment }));
    },
    /** @param {number} number @param {string} body */
    async createComment(number, body) {
      fail();
      const id = ++commentId;
      writes.push({ op: "createComment", args: [number, body] });
      comments.push({
        id,
        body,
        user: { login: "action-agents[bot]" },
        created_at: "2026-02-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
      });
      return { id };
    },
    /** @param {number} id @param {string} body */
    async updateComment(id, body) {
      fail();
      writes.push({ op: "updateComment", args: [id, body] });
      const comment = comments.find((entry) => entry.id === id);
      if (comment) comment.body = body;
    },
    /** @param {number} id */
    async deleteComment(id) {
      fail();
      writes.push({ op: "deleteComment", args: [id] });
      const at = comments.findIndex((entry) => entry.id === id);
      if (at !== -1) comments.splice(at, 1);
    },
  };
}

/**
 * The whole world `run` touches, as literal as it gets: `fakeForge`'s
 * options plus the event and the model seam's answer.
 *
 * @param {Parameters<typeof fakeForge>[0] & {
 *   event?: Record<string, unknown>,
 *   answer?: string,
 *   chatFailure?: Error,
 * }} [options]
 */
function io(options = {}) {
  const forge = fakeForge(options);
  /** @type {{ model: string, messages: { role: string, content: string }[] } | null} */
  let request = null;
  return {
    forge,
    request: () => request,
    chat: {
      /** @param {{ model: string, messages: { role: string, content: string }[] }} ask */
      async complete(ask) {
        if (options.chatFailure) throw options.chatFailure;
        request = ask;
        return { content: options.answer ?? LABELS_ANSWER };
      },
    },
    evidence: createEvidence(() => "aaaabbbb"),
    now: () => Date.parse("2026-07-01T11:00:00Z"),
    readEvent: async () => options.event ?? issueEvent(),
  };
}

/** @param {Partial<ReturnType<typeof readInputs>>} [overrides] */
function inputs(overrides = {}) {
  return { ...readInputs(runner), dryRun: false, ...overrides };
}

/** The context of a pull_request run, from the same fixture. */
const prContext = { ...readContext(runner), eventName: "pull_request" };

afterEach(() => {
  // setFailed sets it, and vitest shares one process across files.
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe("readInputs", () => {
  it("carries the shared inputs and its own through", () => {
    expect(readInputs(runner)).toMatchObject({
      githubToken: "ghs_x",
      apiUrl: "https://api.example/v1",
      apiKey: "sk-secret",
      model: "gpt-x",
      configPath: "",
    });
  });

  it("defaults to a dry run, so a first run cannot surprise anyone", () => {
    expect(readInputs(runner).dryRun).toBe(true);
  });

  it("reads the allowed labels as a list, and an empty one means every label", () => {
    expect(readInputs({ ...runner, INPUT_LABELS: "bug, docs ,," }).labels).toEqual(["bug", "docs"]);
    expect(readInputs(runner).labels).toEqual([]);
  });

  it("reads a configured config-path", () => {
    expect(readInputs({ ...runner, "INPUT_CONFIG-PATH": "policies/triage.json5" }).configPath).toBe(
      "policies/triage.json5",
    );
  });
});

describe("run — the sheet half", () => {
  it("classifies an issue and applies the on-sheet labels it does not already carry", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({ event: issueEvent({ labels: ["triage"] }) });

    await run(inputs(), readContext(runner), world);

    expect(world.forge.writes).toEqual([{ op: "addLabels", args: [7, ["bug"]] }]);
  });

  it("adds nothing when the chosen labels are already present", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({ event: issueEvent({ labels: ["bug"] }) });

    await run(inputs(), readContext(runner), world);

    expect(world.forge.writes).toEqual([]);
  });

  it("never removes a human label — add-only for the sheet's half", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({
      event: issueEvent({ labels: ["bug", "help wanted"] }),
      answer: '{"labels":["bug","docs"],"rationale":"r"}',
    });

    await run(inputs(), readContext(runner), world);

    expect(world.forge.writes).toEqual([{ op: "addLabels", args: [7, ["docs"]] }]);
  });

  it("applies a partly off-sheet answer's on-sheet half and logs the refused rest", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({
      answer: '{"labels":["bug","size/xl","made-up"],"rationale":"r"}',
    });

    await run(inputs(), readContext(runner), world);

    expect(world.forge.writes).toEqual([{ op: "addLabels", args: [7, ["bug"]] }]);
    const lines = log.mock.calls.map((call) => String(call[0])).join("\n");
    // size/xl is on the ladder: offered to no model, so a model choosing it
    // is off-sheet like any other unoffered name.
    expect(lines).toMatch(/refused the off-sheet label 'size\/xl'/);
    expect(lines).toMatch(/refused the off-sheet label 'made-up'/);
  });

  it("refuses an entirely off-sheet answer with a red run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({ answer: '{"labels":["nope"],"rationale":"r"}' });

    await expect(run(inputs(), readContext(runner), world)).rejects.toThrow(/entirely off-sheet/);
    expect(world.forge.writes).toEqual([]);
  });

  it("accepts an empty verdict — none fitting is a valid answer and writes nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({ answer: '{"labels":[],"rationale":"Nothing fits."}' });

    await run(inputs(), readContext(runner), world);

    expect(world.forge.writes).toEqual([]);
  });

  it("narrows the sheet the workflow names, and the model sees only that", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({
      event: issueEvent(),
      answer: '{"labels":["question"],"rationale":"r"}',
    });

    await run(inputs({ labels: ["question"] }), readContext(runner), world);

    const messages = world.request()?.messages ?? [];
    const system = messages[0]?.content ?? "";
    expect(system).toContain("question");
    expect(system).not.toContain("- bug");
    expect(world.forge.writes).toEqual([{ op: "addLabels", args: [7, ["question"]] }]);
  });

  it("refuses a narrowing name the config file does not declare", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({});

    await expect(run(inputs({ labels: ["nope"] }), readContext(runner), world)).rejects.toThrow(
      /'nope', which the config file does not declare/,
    );
  });

  it("refuses the labels input outright when there is no sheet to narrow", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({
      files: {},
      answer: COMMENT_ANSWER,
    });

    await expect(run(inputs({ labels: ["bug"] }), readContext(runner), world)).rejects.toThrow(
      /no config file to narrow/,
    );
  });
});

describe("run — the size half", () => {
  const FILES = [
    { filename: "src/a.mjs", status: "modified", additions: 3, deletions: 1 },
    { filename: "pnpm-lock.yaml", status: "modified", additions: 5_000, deletions: 0 },
  ];

  it("measures a PR's diff, applies the rung beside the chosen labels, and never asks the model", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({
      event: prEvent(),
      answer: '{"labels":["breaking"],"rationale":"r"}',
      prFiles: FILES,
    });

    await run(inputs(), prContext, world);

    expect(world.forge.writes).toEqual([{ op: "addLabels", args: [8, ["breaking", "size/xs"]] }]);
    const system = world.request()?.messages[0]?.content ?? "";
    expect(system).not.toContain("size/");
  });

  it("replaces the previous size label, including one a human applied by hand", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({
      event: prEvent({ labels: ["size/xl"] }),
      prFiles: FILES,
    });

    await run(inputs(), prContext, world);

    expect(world.forge.writes).toEqual([
      { op: "addLabels", args: [8, ["bug", "size/xs"]] },
      { op: "removeLabel", args: [8, "size/xl"] },
    ]);
  });

  it("leaves the size label alone when the measurement lands where it already is", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({
      event: prEvent({ labels: ["bug", "size/xs"] }),
      prFiles: FILES,
    });

    await run(inputs(), prContext, world);

    expect(world.forge.writes).toEqual([]);
  });

  it("refuses a pull request past the files listing's ceiling rather than guessing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({
      event: prEvent(),
      prFiles: Array.from({ length: 3_000 }, (_, index) => ({
        filename: `f${String(index)}.mjs`,
        status: "modified",
        additions: 1,
        deletions: 0,
      })),
    });

    await expect(run(inputs(), prContext, world)).rejects.toThrow(PastFileCeilingError);
  });

  it("never measures an issue — there is no diff to measure", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({ event: issueEvent() });

    await run(inputs(), readContext(runner), world);

    expect(world.forge.reads.some((path) => path.includes("/pulls/"))).toBe(false);
  });
});

describe("run — no sheet, the comment half", () => {
  it("writes the classification as one marker comment, sanitised", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({
      files: {},
      answer:
        '{"classification":"bug report <!-- fake --> cc @maintainer","rationale":"<b>Fails</b> on import."}',
    });

    await run(inputs(), readContext(runner), world);

    expect(world.forge.writes).toHaveLength(1);
    const write = world.forge.writes[0];
    if (write === undefined) throw new Error("no comment was written");
    expect(write.args[0]).toBe(7);
    const body = String(write.args[1]);
    expect(body).toContain("<!-- action-agents:triage:");
    // Model text survives only sanitised: no marker of its own, no mention,
    // no raw HTML.
    expect(body).not.toContain("<!-- fake -->");
    expect(body).not.toMatch(/@maintainer/);
    expect(body).toContain("&lt;b>");
  });

  it("upserts rather than commenting twice", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const existing = [{ login: "action-agents[bot]" }];
    const world = io({ files: {}, answer: COMMENT_ANSWER, comments: existing });
    // The existing comment carries the marker; the fake's body is blank, so
    // give it one the upsert can find.
    world.forge.writes.length = 0;

    await run(inputs(), readContext(runner), world);
    // A blank body means no marker, so the upsert creates; the marker-id
    // preservation and duplicate deletion are comment.mjs's own tests.
    expect(world.forge.writes.length).toBeGreaterThanOrEqual(1);
  });

  it("writes nothing in a dry run, and says what it would have written", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({ files: {}, answer: COMMENT_ANSWER });

    await run(inputs({ dryRun: true }), readContext(runner), world);

    expect(world.forge.writes).toEqual([]);
    const lines = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(lines).toMatch(/dry run/);
    expect(lines).toContain("bug report");
  });
});

describe("run — dry run", () => {
  it("decides and logs, writes nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({
      event: prEvent({ labels: ["size/xl"] }),
      prFiles: [{ filename: "src/a.mjs", status: "modified", additions: 5, deletions: 5 }],
    });

    await run(inputs({ dryRun: true }), prContext, world);

    expect(world.forge.writes).toEqual([]);
    const lines = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(lines).toMatch(/would add \[bug, size\/xs\]/);
    expect(lines).toMatch(/remove \[size\/xl\]/);
  });
});

describe("run — failure posture", () => {
  it("refuses an event it was not built for, by name", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({ event: { push: {} } });

    const context = { ...readContext(runner), eventName: "push" };
    await expect(run(inputs(), context, world)).rejects.toThrow(
      /runs on 'issues' and 'pull_request'/,
    );
  });

  it("refuses a label the repository no longer has, before the model is called", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({ repoLabels: ["bug", "docs", "question", "breaking", "size/xs", "size/s"] });

    await expect(run(inputs(), readContext(runner), world)).rejects.toThrow(
      /'size\/xl', which the repository does not have/,
    );
    expect(world.request()).toBeNull();
  });

  it("refuses a malformed model answer rather than parsing optimistically", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({ answer: "It looks like a bug to me." });

    await expect(run(inputs(), readContext(runner), world)).rejects.toThrow(/no JSON object/);
  });

  it("carries a provider failure out as a red run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({ chatFailure: new Error("the provider's response body is not JSON") });

    await expect(run(inputs(), readContext(runner), world)).rejects.toThrow(/not JSON/);
  });

  it("fails loudly when the token cannot write", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({ writeFailure: new Error("adding labels to #7 failed (HTTP 403)") });

    await expect(run(inputs(), readContext(runner), world)).rejects.toThrow(/403/);
    // The failed write is the only one — no comment fallback, no partial run.
    expect(world.forge.writes).toEqual([]);
  });
});

describe("run — where configuration is read from", () => {
  it("reads the config from the default branch, never the working tree", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({});

    await run(inputs(), readContext(runner), world);

    expect(world.forge.reads).toContain(".github/action-agents/triage/triage.json5");
  });

  it("sends the model only through the seam, with the evidence wrapped", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = io({});

    await run(inputs(), readContext(runner), world);

    const request = world.request();
    expect(request?.model).toBe("gpt-x");
    const messages = request?.messages ?? [];
    const evidence = messages[1]?.content ?? "";
    expect(evidence).toContain("[evidence:aaaabbbb thread-body]");
    expect(evidence).toContain("Steps to reproduce.");
  });
});

describe("main", () => {
  it("turns a pipeline failure into a failed step, not a green one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await main(runner, async () => {
      throw new Error("the provider's response body is not JSON");
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not JSON/);
    expect(process.exitCode).toBe(1);
  });

  it("masks the key before it writes anything else", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(runner, () => Promise.resolve());

    expect(log.mock.calls[0]?.[0]).toBe("::add-mask::sk-secret");
  });

  it("reports success when the work succeeds", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await main(runner, () => Promise.resolve());

    expect(result).toEqual({ ok: true });
    expect(process.exitCode).toBe(0);
  });

  it("fails on a missing required input without reaching the work", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const incomplete = { ...runner };
    delete incomplete["INPUT_API-URL"];

    const result = await main(incomplete, () => Promise.reject(new Error("must not run")));

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/'api-url'/);
  });

  it("says so in the log when it is a dry run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main({ ...runner, "INPUT_DRY-RUN": "true" }, () => Promise.resolve());

    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(
      /\(dry run — nothing will be written\)/,
    );
  });

  it("names itself", () => {
    expect(ACTION).toBe("triage");
  });
});
