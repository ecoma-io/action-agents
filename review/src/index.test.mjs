// Tests for review's entry wiring.
//
// The orchestrator behind `run` has its own suite; what is pinned here is
// the seam the runner touches: inputs read and validated against the
// manifest, the key masked before anything prints, non-pull_request events
// and unlisted activity types refused loudly, and a pull_request event
// handed to the orchestrator over the injected io.

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { describe, expect, it, vi } from "vitest";

import { TransportError } from "#core/transport-errors.mjs";
import { readContext } from "#core/runtime.mjs";
import {
  ACTION,
  PULL_REQUEST_ACTIVITY_TYPES,
  main,
  readEvent,
  readInputs,
  run,
  writeRunArtifact,
} from "./index.mjs";
import { DeterministicRefusalError } from "./refusal.mjs";
import {
  buildAbandonedArtifact,
  buildArtifact,
  buildDryRunArtifact,
  buildSkipRecord,
  serialiseArtifact,
} from "./artifact.mjs";

/** @typedef {import("#core/runtime.mjs").Env} Env */

/** @type {string} */
let eventDir;

/**
 * A runner-shaped env for a same-repo pull_request run whose event payload
 * is a real file — no module mocking anywhere.
 *
 * @param {{ event?: unknown, eventName?: string, extra?: Partial<Env> }} [options]
 * @returns {Env}
 */
function runnerEnv(options = {}) {
  if (eventDir === undefined) eventDir = mkdtempSync(p.join(tmpdir(), "review-entry-"));
  const eventPath = p.join(eventDir, "event.json");
  writeFileSync(
    eventPath,
    JSON.stringify(
      options.event ?? {
        action: "opened",
        pull_request: { number: 41, base: { ref: "main" } },
      },
    ),
  );
  return {
    "INPUT_GITHUB-TOKEN": "ghs_x",
    "INPUT_API-URL": "https://llm.example/v1",
    "INPUT_API-KEY": "sk-secret",
    INPUT_MODEL: "review",
    GITHUB_REPOSITORY: "acme/widgets",
    GITHUB_WORKSPACE: "/w",
    GITHUB_EVENT_NAME: options.eventName ?? "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_API_URL: "https://api.github.com",
    ...options.extra,
  };
}

describe("readInputs", () => {
  it("defaults the knobs and keeps the shared shape", () => {
    const inputs = readInputs(runnerEnv());
    expect(inputs.model).toBe("review");
    expect(inputs.maxTurns).toBe(30);
    expect(inputs.contextWindow).toBe(128_000);
    expect(inputs.requestTimeoutMs).toBe(120_000);
    expect(inputs.dryRun).toBe(false);
    expect(inputs.configPath).toBe("");
  });

  it("refuses knob values under their floors", () => {
    expect(() => readInputs(runnerEnv({ extra: { "INPUT_MAX-TURNS": "0" } }))).toThrow();
    expect(() => readInputs(runnerEnv({ extra: { "INPUT_CONTEXT-WINDOW": "999" } }))).toThrow();
    expect(() => readInputs(runnerEnv({ extra: { "INPUT_DRY-RUN": "yes" } }))).toThrow();
    expect(() => readInputs(runnerEnv({ extra: { "INPUT_REQUEST-TIMEOUT-MS": "0" } }))).toThrow();
  });

  it("refuses a request-timeout-ms that is not a number", () => {
    expect(() => readInputs(runnerEnv({ extra: { "INPUT_REQUEST-TIMEOUT-MS": "soon" } }))).toThrow(
      /must be a number/,
    );
  });

  it("defaults artifact-path to the manifest's default", () => {
    expect(readInputs(runnerEnv()).artifactPath).toBe(".review-artifact");
  });

  it("reads an artifact-path override", () => {
    expect(
      readInputs(runnerEnv({ extra: { "INPUT_ARTIFACT-PATH": "out/reviews" } })).artifactPath,
    ).toBe("out/reviews");
  });
});

describe("readEvent", () => {
  it("extracts the pull request number from a pull_request event", () => {
    const env = runnerEnv({ event: { action: "opened", pull_request: { number: 41 } } });
    const read = readEvent("pull_request", /** @type {string} */ (env.GITHUB_EVENT_PATH));
    expect(read.eventName).toBe("pull_request");
    expect(read.pullRequestNumber).toBe(41);
    expect(read.event).toEqual({ action: "opened", pull_request: { number: 41 } });
  });

  it("declares exactly the activity types the workflow filter does", () => {
    expect([...PULL_REQUEST_ACTIVITY_TYPES]).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "ready_for_review",
    ]);
  });

  it("accepts every declared activity type", () => {
    for (const action of PULL_REQUEST_ACTIVITY_TYPES) {
      const env = runnerEnv({ event: { action, pull_request: { number: 41 } } });
      const read = readEvent("pull_request", /** @type {string} */ (env.GITHUB_EVENT_PATH));
      expect(read.pullRequestNumber).toBe(41);
      expect(read.event["action"]).toBe(action);
    }
  });

  it("refuses any other event name before touching the payload", () => {
    expect(() => readEvent("issues", "/dev/null")).toThrow(/runs on 'pull_request' events only/);
    expect(() => readEvent("workflow_dispatch", "/dev/null")).toThrow(/pull_request/);
  });

  it("refuses an activity type outside the declared set", () => {
    for (const action of ["edited", "labeled", "closed"]) {
      const env = runnerEnv({ event: { action, pull_request: { number: 41 } } });
      const read = () => readEvent("pull_request", /** @type {string} */ (env.GITHUB_EVENT_PATH));
      expect(read).toThrow(/runs on pull_request activity types/);
      expect(read).toThrow(new RegExp(`carries '${action}'`));
    }
  });

  it("refuses an event that carries no activity type", () => {
    const env = runnerEnv({ event: { pull_request: { number: 41 } } });
    expect(() => readEvent("pull_request", /** @type {string} */ (env.GITHUB_EVENT_PATH))).toThrow(
      /runs on pull_request activity types/,
    );
  });

  it("refuses an event payload without a pull request", () => {
    const env = runnerEnv({ event: { action: "opened" } });
    expect(() => readEvent("pull_request", /** @type {string} */ (env.GITHUB_EVENT_PATH))).toThrow(
      /no pull_request\.number/,
    );
  });
});

describe("main", () => {
  it("masks the key before the first log line", async () => {
    /** @type {string[]} */
    const written = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      written.push(String(line));
    });
    try {
      await main(runnerEnv(), async () => {});
      expect(written[0]).toContain("::add-mask::sk-secret");
      expect(written.some((line) => line.includes("review: acme/widgets"))).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("lands failures in setFailed with exit code 1 — never green-on-nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const before = process.exitCode;
    try {
      const outcome = await main(runnerEnv({ eventName: "push" }));
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toMatch(/pull_request' events only/);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
      vi.restoreAllMocks();
    }
  });

  it("reports success when the orchestrator completes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const outcome = await main(runnerEnv(), async () => {});
      expect(outcome.ok).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("run over injected io", () => {
  it("delegates a pull_request event into the orchestrator and logs its reason", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    /** @type {string[]} */
    const logged = [];
    const env = runnerEnv({
      event: { action: "opened", pull_request: { number: 9, base: { ref: "main" } } },
      extra: { GITHUB_WORKSPACE: mkdtempSync(p.join(tmpdir(), "review-wiring-skip-")) },
    });
    try {
      await run(readInputs(env), readContext(env), {
        forge: {
          // Draft snapshot: the cheapest honest end of the orchestration.
          getPullRequest: async () => ({
            number: 9,
            state: "open",
            draft: true,
            merged: false,
            mergeable: null,
            mergeableState: "unknown",
            title: "",
            body: "",
            head: { ref: "x", sha: "a".repeat(40) },
            labels: [],
            base: { ref: "main", sha: "b".repeat(40) },
          }),
          async getRepository() {
            return { defaultBranch: "main", name: "", description: "" };
          },
          async getRef() {
            return { sha: "c".repeat(40) };
          },
          async listPullRequestFiles() {
            return [];
          },
          async listComments() {
            return [];
          },
          async createComment() {
            return { id: 1 };
          },
          async updateComment() {},
          async deleteComment() {},
          async getContents() {
            return null;
          },
          // The draft path returns before any write, so it must never pay
          // the identity read; this fires if that gating regresses.
          async whoami() {
            throw new Error("the draft path never reads the token's identity");
          },
        },
        chat: {
          complete: async () => ({ content: "{}", toolCalls: [], finishReason: undefined }),
        },
        now: () => 0,
        info: (message) => logged.push(message),
      });
      expect(logged.some((line) => line.includes("is a draft"))).toBe(true);
      expect(logged.some((line) => line.includes("review-artifact-skip-"))).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("refuses non-pull_request events before any io touch", async () => {
    const env = runnerEnv({ eventName: "issues" });
    await expect(
      run(readInputs(env), readContext(env), {
        forge: /** @type {any} */ ({}),
        chat: /** @type {any} */ ({}),
        now: () => 0,
        info: () => undefined,
      }),
    ).rejects.toThrow(/pull_request' events only/);
  });
});

describe("run over the real forge", () => {
  it("sends the GitHub API calls to the runner's GITHUB_API_URL, not api.github.com", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    /** @type {string[]} */
    const requested = [];
    const env = runnerEnv({
      extra: {
        GITHUB_API_URL: "https://ghe.example.com/api/v3",
        GITHUB_WORKSPACE: mkdtempSync(p.join(tmpdir(), "review-wiring-url-")),
      },
    });
    vi.stubGlobal(
      "fetch",
      /** @type {typeof globalThis.fetch} */ (
        /** @param {string | URL | Request} url */
        async (url) => {
          requested.push(String(url));
          // The governance line resolves and its config file reads before a
          // draft skip can end the run: the ref read gets a ref-shaped
          // answer, the config read an empty object; everything else is the
          // draft snapshot, the cheapest honest end of the run.
          if (String(url).endsWith("/git/ref/heads/main")) {
            return new Response(JSON.stringify({ object: { sha: "c".repeat(40) } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (
            decodeURIComponent(String(url).replace(/\?.*$/, "")).endsWith(
              "/contents/.github/action-agents/review/review.json5",
            )
          ) {
            return new Response(JSON.stringify({ content: "e30=", encoding: "base64" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (String(url).split("?").at(0)?.includes("/contents/")) {
            return new Response("not found", { status: 404 });
          }
          return new Response(
            JSON.stringify({
              number: 9,
              state: "open",
              draft: true,
              merged: false,
              mergeable: null,
              mergeableState: "unknown",
              title: "",
              body: "",
              head: { ref: "x", sha: "a".repeat(40) },
              labels: [],
              base: { ref: "main", sha: "b".repeat(40) },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      ),
    );
    try {
      await run(readInputs(env), readContext(env), {
        chat: {
          complete: async () => ({ content: "{}", toolCalls: [], finishReason: undefined }),
        },
        now: () => 0,
        info: () => undefined,
      });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
    // One call is enough to know where the forge lives; the loop proves every
    // call, not just the first, stayed on the runner's host.
    expect(requested.length).toBeGreaterThan(0);

    for (const url of requested) {
      expect(url.startsWith("https://ghe.example.com/api/v3/")).toBe(true);
    }
  });
});

describe("run — request-timeout-ms wiring", () => {
  // The floor refusal above ("refuses knob values under their floors") pins
  // what `readInputs` accepts. These two pin that the accepted number
  // actually reaches the HTTP client `run` builds — the hop the floor
  // exists to guard.

  /**
   * The cheapest non-draft pull request: enough for the orchestrator to
   * reach the model instead of returning the draft snapshot, and nothing
   * more. Every write stays behind the dry-run gate.
   *
   * @returns {import("#core/forge.mjs").Forge}
   */
  function reviewableForge() {
    return /** @type {any} */ ({
      async getRepository() {
        return { defaultBranch: "main", name: "widgets", description: "" };
      },
      async getRef() {
        return { sha: "c".repeat(40) };
      },
      async getPullRequest() {
        return {
          number: 41,
          state: "open",
          draft: false,
          merged: false,
          mergeable: true,
          mergeableState: "clean",
          title: "",
          body: "",
          head: { ref: "x", sha: "a".repeat(40) },
          labels: [],
          base: { ref: "main", sha: "b".repeat(40) },
        };
      },
      async getContents() {
        return null;
      },
      async listPullRequestFiles() {
        return [
          {
            filename: "src/a.mjs",
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "@@ -1 +1,2 @@\n+x",
          },
        ];
      },
      async listComments() {
        return [];
      },
    });
  }

  /**
   * A transport that records every abort signal it was handed and never
   * answers: each request hangs until its signal fires, then rejects with
   * the signal's abort reason.
   *
   * @param {AbortSignal[]} signals
   * @returns {typeof globalThis.fetch}
   */
  function hangingFetch(signals) {
    return /** @type {typeof globalThis.fetch} */ (
      (_url, init) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("no abort signal reached the chat request");
        }
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    );
  }

  it("forwards the configured request-timeout-ms to the chat client as an abort signal", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    /** @type {AbortSignal[]} */
    const signals = [];
    const env = runnerEnv({
      extra: {
        GITHUB_WORKSPACE: mkdtempSync(p.join(tmpdir(), "review-wiring-a-")),
        "INPUT_DRY-RUN": "true",
        "INPUT_REQUEST-TIMEOUT-MS": "2500",
      },
    });
    await expect(
      run(readInputs(env), readContext(env), {
        forge: reviewableForge(),
        fetchImpl: /** @type {typeof globalThis.fetch} */ (
          async (_url, init) => {
            const signal = init?.signal;
            if (!(signal instanceof AbortSignal)) {
              throw new Error("no abort signal reached the chat request");
            }
            signals.push(signal);
            return new Response(
              JSON.stringify({
                choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
        ),
        now: () => 0,
        info: () => undefined,
      }),
    ).rejects.toThrow(/the final answer failed the output contract twice/);

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
  });

  it("aborts a hanging provider on every attempt and fails with the transport error", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    /** @type {AbortSignal[]} */
    const signals = [];
    const env = runnerEnv({
      extra: {
        GITHUB_WORKSPACE: mkdtempSync(p.join(tmpdir(), "review-wiring-b-")),
        "INPUT_DRY-RUN": "true",
        "INPUT_REQUEST-TIMEOUT-MS": "1000",
      },
    });

    await expect(
      run(readInputs(env), readContext(env), {
        forge: reviewableForge(),
        fetchImpl: hangingFetch(signals),
        now: () => 0,
        info: () => undefined,
      }),
    ).rejects.toThrow(TransportError);

    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(3);
  }, 30_000);
});

describe("writeRunArtifact", () => {
  const SHA = "a".repeat(40);
  const DIGEST = "c".repeat(64);

  /** @returns {import("./artifact.mjs").RunArtifact} */
  function artifactFixture() {
    return buildArtifact({
      repository: "acme/widgets",
      pullRequest: 7,
      headRef: SHA,
      outcome: { classification: "published", reason: "Complete review published (1 findings)" },
      policy: {
        strictness: "medium",
        strategy: "standard",
        basis: "base",
        branch: "main",
        sha: SHA,
      },
      risk: [{ path: "src/a.mjs", risk: "low", lane: "skim" }],
      findings: [
        {
          severity: "concern",
          file: "src/a.mjs",
          line: 2,
          message: "off-by-one",
          provenance: { path: "src/a.mjs", startLine: 1, endLine: 3, digest: DIGEST },
        },
      ],
      verification: { gate: { passed: true } },
      gates: [
        { gate: "conclusion", passed: true },
        { gate: "bound", passed: true },
        { gate: "coverage", passed: true },
        { gate: "provenance", passed: true },
        { gate: "verification", passed: true },
      ],
      coverage: { total: 1, covered: ["src/a.mjs"], uncovered: [] },
      phases: [{ from: "orient", to: "investigate" }],
      provenance: { commentId: 101 },
    });
  }

  it("writes a deterministically named file of deterministic bytes into the default directory", () => {
    const root = mkdtempSync(p.join(tmpdir(), "artifact-write-"));
    const file = writeRunArtifact({
      workspace: root,
      directory: ".review-artifact",
      artifact: artifactFixture(),
    });
    expect(file).toBe(p.join(root, ".review-artifact", `review-artifact-${SHA}.json`));
    const bytes = readFileSync(file, "utf8");
    expect(bytes).toBe(serialiseArtifact(artifactFixture()));
    expect(JSON.parse(bytes)).toMatchObject({ schemaVersion: 5, headRef: SHA });
  });

  it("names a skip record inside the artifact upload glob", () => {
    const root = mkdtempSync(p.join(tmpdir(), "artifact-write-"));
    const record = buildSkipRecord({
      repository: "acme/widgets",
      pullRequest: 7,
      headRef: SHA,
      reason: "#7 is a draft — not ready means not reviewed",
      kind: "state",
      policy: {
        strictness: "medium",
        strategy: "standard",
        basis: "base",
        branch: "main",
        sha: SHA,
      },
    });
    const file = writeRunArtifact({
      workspace: root,
      directory: ".review-artifact",
      artifact: record,
    });
    expect(file).toBe(p.join(root, ".review-artifact", `review-artifact-skip-${SHA}.json`));
    expect(p.basename(file)).toMatch(/^review-artifact-.*\.json$/);
    const bytes = readFileSync(file, "utf8");
    expect(bytes).toBe(serialiseArtifact(record));
    expect(JSON.parse(bytes)).toMatchObject({ schemaVersion: 6, kind: "state", headRef: SHA });
  });

  it("names an abandoned run's reduced artifact inside the upload glob, comment id included", () => {
    const root = mkdtempSync(p.join(tmpdir(), "artifact-write-"));
    const artifact = buildAbandonedArtifact({
      repository: "acme/widgets",
      pullRequest: 7,
      headRef: SHA,
      reason: "the head moved while the run was in flight",
      commentId: 101,
    });
    const file = writeRunArtifact({
      workspace: root,
      directory: ".review-artifact",
      artifact,
    });
    expect(file).toBe(p.join(root, ".review-artifact", `review-artifact-abandoned-${SHA}.json`));
    expect(p.basename(file)).toMatch(/^review-artifact-.*\.json$/);
    const bytes = readFileSync(file, "utf8");
    expect(bytes).toBe(serialiseArtifact(artifact));
    expect(JSON.parse(bytes)).toMatchObject({
      schemaVersion: 5,
      outcome: { classification: "abandoned" },
      provenance: { commentId: 101 },
      headRef: SHA,
    });
  });

  it("names a dry run's reduced artifact inside the upload glob", () => {
    const root = mkdtempSync(p.join(tmpdir(), "artifact-write-"));
    const artifact = buildDryRunArtifact({
      repository: "acme/widgets",
      pullRequest: 7,
      headRef: SHA,
      reason: "dry run — the model was called, nothing was written",
    });
    const file = writeRunArtifact({
      workspace: root,
      directory: ".review-artifact",
      artifact,
    });
    expect(file).toBe(p.join(root, ".review-artifact", `review-artifact-dry-run-${SHA}.json`));
    expect(p.basename(file)).toMatch(/^review-artifact-.*\.json$/);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      schemaVersion: 5,
      outcome: { classification: "dry-run" },
    });
  });

  it("clears a planted file matching the upload glob before writing — every shape's name included", () => {
    const root = mkdtempSync(p.join(tmpdir(), "artifact-clear-"));
    const dir = p.join(root, ".review-artifact");
    mkdirSync(dir, { recursive: true });
    // A PR-author-writable checkout plants files under the names every shape
    // writes; the write clears the namespace before it lays down its own.
    for (const planted of [
      `review-artifact-${SHA}.json`,
      `review-artifact-skip-${SHA}.json`,
      `review-artifact-abandoned-${SHA}.json`,
      `review-artifact-dry-run-${SHA}.json`,
    ]) {
      writeFileSync(p.join(dir, planted), "{}", "utf8");
    }
    writeFileSync(p.join(dir, "notes.txt"), "not the upload glob", "utf8");
    writeRunArtifact({
      workspace: root,
      directory: ".review-artifact",
      artifact: artifactFixture(),
    });
    expect(readdirSync(dir).sort()).toEqual(["notes.txt", `review-artifact-${SHA}.json`]);
  });

  it("creates a nested custom directory", () => {
    const root = mkdtempSync(p.join(tmpdir(), "artifact-write-"));
    const file = writeRunArtifact({
      workspace: root,
      directory: "out/reviews",
      artifact: artifactFixture(),
    });
    expect(file).toBe(p.join(root, "out", "reviews", `review-artifact-${SHA}.json`));
    expect(existsSync(file)).toBe(true);
  });

  it("refuses a relative path that climbs out of the workspace", () => {
    const root = mkdtempSync(p.join(tmpdir(), "artifact-write-"));
    expect(() =>
      writeRunArtifact({ workspace: root, directory: "../elsewhere", artifact: artifactFixture() }),
    ).toThrow(/outside the workspace/);
  });

  it("refuses an absolute path outside the workspace", () => {
    const root = mkdtempSync(p.join(tmpdir(), "artifact-write-"));
    expect(() =>
      writeRunArtifact({ workspace: root, directory: tmpdir(), artifact: artifactFixture() }),
    ).toThrow(/outside the workspace/);
  });

  it("refuses a path through .git", () => {
    const root = mkdtempSync(p.join(tmpdir(), "artifact-write-"));
    expect(() =>
      writeRunArtifact({
        workspace: root,
        directory: ".git/artifacts",
        artifact: artifactFixture(),
      }),
    ).toThrow(/touches .git/);
  });

  it("refuses a path through .git case-insensitively", () => {
    const root = mkdtempSync(p.join(tmpdir(), "artifact-write-"));
    expect(() =>
      writeRunArtifact({
        workspace: root,
        directory: ".Git/artifacts",
        artifact: artifactFixture(),
      }),
    ).toThrow(/touches \.git/);
  });

  it("refuses a symlinked directory that resolves into .git", () => {
    const root = mkdtempSync(p.join(tmpdir(), "artifact-write-"));
    mkdirSync(p.join(root, ".git"));
    // The lexical path carries no `.git` segment, so only the post-resolve
    // check can see that the real location is the metadata directory.
    symlinkSync(p.join(root, ".git"), p.join(root, "link"), "dir");
    expect(() =>
      writeRunArtifact({ workspace: root, directory: "link", artifact: artifactFixture() }),
    ).toThrow(/resolves inside \.git/);
  });

  it("refuses a symlinked directory that leaves the workspace", () => {
    const root = mkdtempSync(p.join(tmpdir(), "artifact-write-"));
    const outside = mkdtempSync(p.join(tmpdir(), "artifact-outside-"));
    mkdirSync(p.join(outside, "real"));
    symlinkSync(p.join(outside, "real"), p.join(root, "link"), "dir");
    expect(() =>
      writeRunArtifact({ workspace: root, directory: "link", artifact: artifactFixture() }),
    ).toThrow(/outside the workspace/);
  });
});

describe("run writes the artifact only after publication", () => {
  it("a draft run writes only its skip record", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "artifact-draft-"));
    const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
    try {
      await run(readInputs(env), readContext(env), {
        forge: {
          getPullRequest: async () => ({
            number: 41,
            state: "open",
            draft: true,
            merged: false,
            mergeable: null,
            mergeableState: "unknown",
            title: "",
            body: "",
            head: { ref: "x", sha: "a".repeat(40) },
            labels: [],
            base: { ref: "main", sha: "b".repeat(40) },
          }),
          async getRepository() {
            return { defaultBranch: "main", name: "", description: "" };
          },
          async getRef() {
            return { sha: "c".repeat(40) };
          },
          async listPullRequestFiles() {
            return [];
          },
          async listComments() {
            return [];
          },
          async createComment() {
            return { id: 1 };
          },
          async updateComment() {},
          async deleteComment() {},
          async getContents() {
            return null;
          },
          async whoami() {
            throw new Error("the draft path never reads the token's identity");
          },
        },
        chat: {
          complete: async () => ({ content: "{}", toolCalls: [], finishReason: undefined }),
        },
        now: () => 0,
        info: () => undefined,
      });
      const files = readdirSync(p.join(root, ".review-artifact"));
      expect(files).toEqual([`review-artifact-skip-${"a".repeat(40)}.json`]);
      const record = JSON.parse(
        readFileSync(p.join(root, ".review-artifact", files[0] ?? ""), "utf8"),
      );
      expect(record.kind).toBe("state");
      expect(record.outcome.classification).toBe("skip");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a post-publication artifact write failure stays green with the comment standing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "artifact-write-fail-"));
    mkdirSync(p.join(root, "src"));
    writeFileSync(p.join(root, "src", "a.mjs"), "line1\n");
    const env = runnerEnv({
      extra: { GITHUB_WORKSPACE: root, "INPUT_ARTIFACT-PATH": "../outside" },
    });
    /** @type {string[]} */
    const log = [];
    /** @type {Array<{ id?: number, body?: string }>} */
    const upserts = [];
    try {
      const result = await run(readInputs(env), readContext(env), {
        forge: {
          async getPullRequest() {
            return {
              number: 41,
              state: "open",
              draft: false,
              merged: false,
              mergeable: true,
              mergeableState: "clean",
              title: "Test PR",
              body: "",
              head: { ref: "x", sha: "a".repeat(40) },
              labels: [],
              base: { ref: "main", sha: "b".repeat(40) },
            };
          },
          async getRepository() {
            return { defaultBranch: "main", name: "widgets", description: "" };
          },
          async getRef() {
            return { sha: "c".repeat(40) };
          },
          async listPullRequestFiles() {
            return [
              /** @type {any} */ ({
                filename: "src/a.mjs",
                status: "modified",
                additions: 1,
                deletions: 0,
                patch: "@@ -1 +1,2 @@\n+x",
              }),
            ];
          },
          async listComments() {
            return [];
          },
          /** @param {number} _number @param {string} body */
          async createComment(_number, body) {
            upserts.push({ body });
            return { id: 101 };
          },
          async updateComment() {},
          async deleteComment() {},
          async getContents() {
            return null;
          },
          async whoami() {
            return { login: "github-actions[bot]" };
          },
        },
        chat: {
          complete: async () => ({
            content: '{"findings":[],"summary":"no findings"}',
            toolCalls: [],
            finishReason: "stop",
          }),
        },
        now: () => 0,
        info: (message) => log.push(message),
      });
      // The comment was published — the upsert happened.
      expect(upserts).toHaveLength(1);
      // The run stayed green — the outcome records the publication without
      // its artifact, not a failure that would contradict the comment.
      expect(result.outcome).toBe("published-without-artifact");
      expect(result.reason).toContain("not written");
      // The failure is logged.
      expect(log.some((line) => line.includes("not written"))).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("the red boundary (#355)", () => {
  /** The working orchestrator double — the post-publication test's shape. */
  const openForge = (over = {}) => ({
    async getPullRequest() {
      return {
        number: 41,
        state: "open",
        draft: false,
        merged: false,
        mergeable: true,
        mergeableState: "clean",
        title: "Test PR",
        body: "",
        head: { ref: "x", sha: "a".repeat(40) },
        labels: [],
        base: { ref: "main", sha: "b".repeat(40) },
      };
    },
    async getRepository() {
      return { defaultBranch: "main", name: "widgets", description: "" };
    },
    async getRef() {
      return { sha: "c".repeat(40) };
    },
    async listPullRequestFiles() {
      return [
        /** @type {any} */ ({
          filename: "src/a.mjs",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1,2 @@\n+x",
        }),
      ];
    },
    async listComments() {
      return [];
    },
    async createComment() {
      return { id: 101 };
    },
    async updateComment() {},
    async deleteComment() {},
    async getContents() {
      return null;
    },
    async whoami() {
      return { login: "github-actions[bot]" };
    },
    ...over,
  });
  /** A chat that never satisfies the output contract — the refusal fixture. */
  const junkChat = {
    complete: async () => ({
      content: "this is not the JSON object the contract specifies",
      toolCalls: [],
      finishReason: "stop",
    }),
  };

  it("an output-contract refusal writes the refused artifact and rethrows the original error", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "red-refused-"));
    const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
    try {
      const cause = await run(readInputs(env), readContext(env), {
        forge: openForge(),
        chat: junkChat,
        now: () => 0,
        info: () => undefined,
      }).then(
        () => null,
        (error) => error,
      );
      // The original error still fails the step — the record never masks
      // the throw it records.
      expect(cause).toBeInstanceOf(Error);
      expect(/** @type {Error} */ (cause).message).toMatch(/failed the output contract twice/);
      // The guard is the typed deterministic refusal, so the boundary
      // records it `refused`, not `failed`.
      expect(cause).toBeInstanceOf(DeterministicRefusalError);
      const files = readdirSync(p.join(root, ".review-artifact"));
      expect(files).toEqual([`review-artifact-refused-${"a".repeat(40)}.json`]);
      const record = JSON.parse(
        readFileSync(p.join(root, ".review-artifact", files[0] ?? ""), "utf8"),
      );
      expect(record.schemaVersion).toBe(5);
      expect(record.repository).toBe("acme/widgets");
      expect(record.pullRequest).toBe(41);
      expect(record.headRef).toBe("a".repeat(40));
      expect(record.outcome.classification).toBe("refused");
      expect(record.outcome.reason).toMatch(/failed the output contract twice/);
      expect(Object.keys(record).sort()).toEqual(
        ["headRef", "outcome", "pullRequest", "repository", "schemaVersion"].sort(),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a transport break on the snapshot read writes the failed artifact with the honest null head", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "red-failed-"));
    const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
    const breakage = new TransportError("https://api.github.com/prs/41", "connection reset");
    try {
      const cause = await run(readInputs(env), readContext(env), {
        forge: openForge({
          getPullRequest: async () => {
            throw breakage;
          },
        }),
        chat: junkChat,
        now: () => 0,
        info: () => undefined,
      }).then(
        () => null,
        (error) => error,
      );
      // The very error that broke the run, not a replacement.
      expect(cause).toBe(breakage);
      const files = readdirSync(p.join(root, ".review-artifact"));
      expect(files).toEqual(["review-artifact-failed-no-head.json"]);
      const record = JSON.parse(
        readFileSync(p.join(root, ".review-artifact", files[0] ?? ""), "utf8"),
      );
      expect(record.outcome.classification).toBe("failed");
      // The run died before the snapshot pinned a head — the honest null,
      // never a guessed sha.
      expect(record.headRef).toBeNull();
      expect(record.outcome.reason).toMatch(/connection reset/);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a red run whose comment already stands records the comment it leaves behind", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "red-after-comment-"));
    const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
    /** @type {Array<{ id?: number, body?: string }>} */
    const upserts = [];
    // getPullRequest is read four times on the publishing path — snapshot,
    // pre-publication freshness, pre-comment, write-time freshness — and the
    // fourth failing is a run that published and then died red.
    let reads = 0;
    try {
      const cause = await run(readInputs(env), readContext(env), {
        forge: openForge({
          async getPullRequest() {
            reads += 1;
            if (reads > 3) {
              throw new TransportError("https://api.github.com/prs/41", "connection reset");
            }
            return {
              number: 41,
              state: "open",
              draft: false,
              merged: false,
              mergeable: true,
              mergeableState: "clean",
              title: "Test PR",
              body: "",
              head: { ref: "x", sha: "a".repeat(40) },
              labels: [],
              base: { ref: "main", sha: "b".repeat(40) },
            };
          },
          /** @param {number} _number @param {string} body */
          async createComment(_number, body) {
            upserts.push({ body });
            return { id: 101 };
          },
        }),
        chat: {
          complete: async () => ({
            content: '{"findings":[],"summary":"no findings"}',
            toolCalls: [],
            finishReason: "stop",
          }),
        },
        now: () => 0,
        info: () => undefined,
      }).then(
        () => null,
        (error) => error,
      );
      // The comment stands — the upsert happened before the break.
      expect(upserts).toHaveLength(1);
      expect(cause).toBeInstanceOf(TransportError);
      const files = readdirSync(p.join(root, ".review-artifact"));
      expect(files).toEqual([`review-artifact-failed-${"a".repeat(40)}.json`]);
      const record = JSON.parse(
        readFileSync(p.join(root, ".review-artifact", files[0] ?? ""), "utf8"),
      );
      expect(record.outcome.classification).toBe("failed");
      expect(record.provenance).toEqual({ commentId: 101 });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a failed boundary artifact write is a logged loss — the original error still fails the step", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "red-write-loss-"));
    const env = runnerEnv({
      extra: { GITHUB_WORKSPACE: root, "INPUT_ARTIFACT-PATH": "../outside" },
    });
    /** @type {string[]} */
    const log = [];
    const breakage = new TransportError("https://api.github.com/prs/41", "connection reset");
    try {
      const cause = await run(readInputs(env), readContext(env), {
        forge: openForge({
          getPullRequest: async () => {
            throw breakage;
          },
        }),
        chat: junkChat,
        now: () => 0,
        info: (message) => log.push(message),
      }).then(
        () => null,
        (error) => error,
      );
      // The transport break, not the record write's failure: the carve-out
      // keeps the write-loss tier with the write site (F-14).
      expect(cause).toBe(breakage);
      expect(log.some((line) => line.includes("the failed run's artifact was not written"))).toBe(
        true,
      );
      expect(existsSync(p.join(root, ".review-artifact"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a throw with no message still records — the fixed sentence stands in for the empty reason", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      // The builder refuses an empty reason, so before the fallback this
      // exit wrote no artifact at all — a third unrecorded red exit. The
      // fixed sentence keeps the boundary recording.
      for (const message of ["", " \t "]) {
        const root = mkdtempSync(p.join(tmpdir(), "red-wordless-"));
        const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
        const breakage = new Error(message);
        const cause = await run(readInputs(env), readContext(env), {
          forge: openForge({
            getPullRequest: async () => {
              throw breakage;
            },
          }),
          chat: junkChat,
          now: () => 0,
          info: () => undefined,
        }).then(
          () => null,
          (error) => error,
        );
        expect(cause).toBe(breakage);
        const files = readdirSync(p.join(root, ".review-artifact"));
        expect(files).toEqual(["review-artifact-failed-no-head.json"]);
        const record = JSON.parse(
          readFileSync(p.join(root, ".review-artifact", files[0] ?? ""), "utf8"),
        );
        expect(record.outcome.classification).toBe("failed");
        expect(record.outcome.reason).toBe("the run failed without a message");
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a refused record never names a comment — the refusal arms write nothing first", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    /** @type {string[]} */
    const writes = [];
    /**
     * A write op the refusal paths must never reach; reaching it fails loudly.
     *
     * @param {string} name
     * @returns {(...args: unknown[]) => Promise<never>}
     */
    const counting =
      (name) =>
      async (..._args) => {
        writes.push(name);
        throw new Error(`the refusal path never calls ${name}`);
      };
    try {
      // Arm 1: the twice-failed output contract.
      {
        const root = mkdtempSync(p.join(tmpdir(), "red-nowrite-1-"));
        const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
        const cause = await run(readInputs(env), readContext(env), {
          forge: openForge({
            createComment: counting("createComment"),
            updateComment: counting("updateComment"),
            deleteComment: counting("deleteComment"),
          }),
          chat: junkChat,
          now: () => 0,
          info: () => undefined,
        }).then(
          () => null,
          (error) => error,
        );
        expect(cause).toBeInstanceOf(DeterministicRefusalError);
        const record = JSON.parse(
          readFileSync(
            p.join(root, ".review-artifact", `review-artifact-refused-${"a".repeat(40)}.json`),
            "utf8",
          ),
        );
        expect(record.outcome.classification).toBe("refused");
        expect(record.provenance).toBeUndefined();
      }
      // Arm 2: the diff-line budget — one file past the 5000-line default.
      {
        const root = mkdtempSync(p.join(tmpdir(), "red-nowrite-2-"));
        const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
        const cause = await run(readInputs(env), readContext(env), {
          forge: openForge({
            listPullRequestFiles: async () => [
              /** @type {any} */ ({
                filename: "src/huge.mjs",
                status: "modified",
                additions: 6001,
                deletions: 0,
                patch: "@@ -1 +1,2 @@\n+x",
              }),
            ],
            createComment: counting("createComment"),
            updateComment: counting("updateComment"),
            deleteComment: counting("deleteComment"),
          }),
          chat: junkChat,
          now: () => 0,
          info: () => undefined,
        }).then(
          () => null,
          (error) => error,
        );
        expect(cause).toBeInstanceOf(DeterministicRefusalError);
        expect(/** @type {Error} */ (cause).message).toMatch(/against a 5000-line budget/);
        const record = JSON.parse(
          readFileSync(
            p.join(root, ".review-artifact", `review-artifact-refused-${"a".repeat(40)}.json`),
            "utf8",
          ),
        );
        expect(record.outcome.classification).toBe("refused");
        expect(record.provenance).toBeUndefined();
      }
      // Every write op on the forge, across both arms: zero.
      expect(writes).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a skip record's failed write is red and unrecorded — the boundary never fires for it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "red-skip-write-"));
    const env = runnerEnv({
      extra: { GITHUB_WORKSPACE: root, "INPUT_ARTIFACT-PATH": "../outside" },
    });
    try {
      // A draft pull request — the cheapest skip that carries a record. The
      // record IS the skip's whole outcome, so the escaping artifact-path
      // propagates its refusal; and because that throw leaves the run after
      // the boundary's try, no red artifact is written beside the loss.
      await expect(
        run(readInputs(env), readContext(env), {
          forge: openForge({
            getPullRequest: async () => ({
              number: 41,
              state: "open",
              draft: true,
              merged: false,
              mergeable: null,
              mergeableState: "unknown",
              title: "",
              body: "",
              head: { ref: "x", sha: "a".repeat(40) },
              labels: [],
              base: { ref: "main", sha: "b".repeat(40) },
            }),
            whoami: async () => {
              throw new Error("the draft path never reads the token's identity");
            },
          }),
          chat: junkChat,
          now: () => 0,
          info: () => undefined,
        }),
      ).rejects.toThrow(/outside the workspace/);
      expect(existsSync(p.join(root, ".review-artifact"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a green run writes no red artifact — the boundary never fires on a resolution", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "red-green-"));
    const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
    try {
      const result = await run(readInputs(env), readContext(env), {
        forge: openForge(),
        chat: {
          complete: async () => ({
            content: '{"findings":[],"summary":"no findings"}',
            toolCalls: [],
            finishReason: "stop",
          }),
        },
        now: () => 0,
        info: () => undefined,
      });
      expect(result.outcome).toBe("published");
      const files = readdirSync(p.join(root, ".review-artifact"));
      expect(files).toEqual([`review-artifact-${"a".repeat(40)}.json`]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("the action constant", () => {
  it("is review — the marker namespace everything downstream assumes", () => {
    expect(ACTION).toBe("review");
  });
});
