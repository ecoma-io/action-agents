// Tests for the `review` entry point.
//
// Two properties are pinned here that no later change may quietly drop:
//
//   1. **The unimplemented state fails loudly.** `run` refusing must reach
//      `setFailed`, so a workflow goes red rather than green on an action that
//      did nothing. A seed that reported success would be worse than no action.
//   2. **The key is masked before anything can print it.** `add-mask` has to be
//      issued before the first log line, or a later message carrying the
//      request can put the key in a public build log.

import { afterEach, describe, expect, it, vi } from "vitest";

import { readContext } from "#core/runtime.mjs";

import { ACTION, main, readInputs, run } from "./index.mjs";

/**
 * A complete runner environment, from which each test removes what it is about.
 * Typed as `Env` rather than inferred: an inferred literal has required keys, and
 * `delete` on one is a type error — which would push these tests towards
 * asserting on a fixture they could not actually take a value out of.
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
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_EVENT_PATH: "/work/event.json",
};

afterEach(() => {
  // setFailed sets it, and vitest shares one process across files.
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe("readInputs", () => {
  it("carries the shared inputs through", () => {
    expect(readInputs(runner)).toMatchObject({
      githubToken: "ghs_x",
      apiUrl: "https://api.example/v1",
      apiKey: "sk-secret",
      model: "gpt-x",
    });
  });

  it("defaults the rubric path, the turn ceiling and the context window", () => {
    expect(readInputs(runner)).toMatchObject({
      instructionsPath: ".github/review-instructions.md",
      maxTurns: 30,
      contextWindow: 128_000,
    });
  });

  it("reads a configured config-path, empty for the default locations", () => {
    expect(readInputs(runner).configPath).toBe("");
    expect(readInputs({ ...runner, "INPUT_CONFIG-PATH": "p/review.json5" }).configPath).toBe(
      "p/review.json5",
    );
  });

  it("refuses a turn ceiling of zero, which would review nothing and say nothing", () => {
    expect(() => readInputs({ ...runner, "INPUT_MAX-TURNS": "0" })).toThrow(/at least 1/);
  });

  it("does not default to a dry run — a review that writes no comment is not a review", () => {
    expect(readInputs(runner).dryRun).toBe(false);
  });
});

describe("run", () => {
  it("refuses, rather than reporting success for work it never attempted", async () => {
    await expect(run(readInputs(runner), readContext(runner))).rejects.toThrow(
      /not implemented yet/,
    );
  });
});

describe("main", () => {
  it("turns a refusal into a failed step, not a green one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await main(runner);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not implemented yet/);
    expect(process.exitCode).toBe(1);
  });

  it("masks the key before it writes anything else", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(runner);

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
    expect(ACTION).toBe("review");
  });
});
