// Tests for review's entry wiring.
//
// The orchestrator behind `run` has its own suite; what is pinned here is
// the seam the runner touches: inputs read and validated against the
// manifest, the key masked before anything prints, non-pull_request events
// and unlisted activity types refused loudly, and a pull_request event
// handed to the orchestrator over the injected io.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { describe, expect, it, vi } from "vitest";

import { readContext } from "#core/runtime.mjs";

import { ACTION, PULL_REQUEST_ACTIVITY_TYPES, main, readEvent, readInputs, run } from "./index.mjs";

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
    JSON.stringify(options.event ?? { action: "opened", pull_request: { number: 41 } }),
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
    expect(inputs.dryRun).toBe(false);
    expect(inputs.configPath).toBe("");
  });

  it("refuses knob values under their floors", () => {
    expect(() => readInputs(runnerEnv({ extra: { "INPUT_MAX-TURNS": "0" } }))).toThrow();
    expect(() => readInputs(runnerEnv({ extra: { "INPUT_CONTEXT-WINDOW": "999" } }))).toThrow();
    expect(() => readInputs(runnerEnv({ extra: { "INPUT_DRY-RUN": "yes" } }))).toThrow();
  });
});

describe("readEvent", () => {
  it("extracts the pull request number from a pull_request event", () => {
    const env = runnerEnv({ event: { action: "opened", pull_request: { number: 41 } } });
    expect(readEvent("pull_request", /** @type {string} */ (env.GITHUB_EVENT_PATH))).toEqual({
      eventName: "pull_request",
      pullRequestNumber: 41,
    });
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
      expect(readEvent("pull_request", /** @type {string} */ (env.GITHUB_EVENT_PATH))).toEqual({
        eventName: "pull_request",
        pullRequestNumber: 41,
      });
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
    const env = runnerEnv({ event: { action: "opened", pull_request: { number: 9 } } });
    try {
      await run(readInputs(env), readContext(env), {
        forge: {
          // Draft snapshot: the cheapest honest end of the orchestration.
          getPullRequest: async () => ({
            number: 9,
            state: "open",
            draft: true,
            merged: false,
            title: "",
            body: "",
            head: { ref: "x", sha: "a".repeat(40) },
            base: { ref: "main", sha: "b".repeat(40) },
          }),
          async getRepository() {
            return { defaultBranch: "main", name: "", description: "" };
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
    const env = runnerEnv({ extra: { GITHUB_API_URL: "https://ghe.example.com/api/v3" } });
    vi.stubGlobal(
      "fetch",
      /** @type {typeof globalThis.fetch} */ (
        /** @param {string | URL | Request} url */
        async (url) => {
          requested.push(String(url));
          // Draft snapshot: the cheapest honest end of the orchestration.
          return new Response(
            JSON.stringify({
              number: 9,
              state: "open",
              draft: true,
              merged: false,
              title: "",
              body: "",
              head: { ref: "x", sha: "a".repeat(40) },
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

describe("the action constant", () => {
  it("is review — the marker namespace everything downstream assumes", () => {
    expect(ACTION).toBe("review");
  });
});
