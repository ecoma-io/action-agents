// Tests for the applicability-vs-capacity semantic boundaries — the second
// freeze in docs/run-contract.md ("cannot review is never encoded as not
// applicable").
//
// The existing suites pin most of the contract; these rows pin the seams the
// matrix found unasserted at the orchestration level:
//
//   D7  a red terminal (refused, failed) writes no SARIF and names no
//       `sarif-path` output — the Code Scanning column stays empty on the
//       two red states (ADR 006). The `artifact-file` still names the red
//       record, so the absence is an absence, not an unobserved write.
//   D6  the red boundary's classification is a function of the throw's
//       class, never its message: the same words in a plain Error record
//       `failed`, in a DeterministicRefusalError record `refused`.
//   E4  a coverage-accounting break (the expected set cannot be derived from
//       the diff) is a code defect, not a ceiling declining to act — the
//       entrypoint records it `failed`, never `refused`.
//   C1  a raw-oversized-but-eligible pull request publishes clean: ignore
//       shrank the eligible universe, the budget never even sees it, and the
//       run is green — "not applicable" and "budget-refused" both stay apart.
//   3a  the eligibility size guard reads the pre-ignore totals and can skip a
//       PR the budget would have happily reviewed, while a PR under the guard
//       but over the budget refuses (`refused`) rather than skipping.

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { describe, expect, it, vi } from "vitest";

import { readContext } from "#core/runtime.mjs";

import { DeterministicRefusalError } from "./refusal.mjs";
import { buildInventory } from "./inventory.mjs";
import {
  changeTotals,
  evaluateApplicability,
  validateApplicabilityPolicy,
} from "./applicability.mjs";
import { readInputs, run } from "./index.mjs";

/** @typedef {import("#core/runtime.mjs").Env} Env */

/** @type {string} */
let eventDir;

/**
 * A runner-shaped env for a same-repo pull_request run. Mirrors
 * `runnerEnv` in index.test.mjs; the event payload is a real file.
 *
 * @param {{ event?: unknown, eventName?: string, extra?: Partial<Env> }} [options]
 * @returns {Env}
 */
function runnerEnv(options = {}) {
  if (eventDir === undefined) eventDir = mkdtempSync(p.join(tmpdir(), "review-boundary-entry-"));
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

/**
 * A chat that can run reading turns before the final answer, script-wise.
 * @param {Array<{ content: string, toolCalls?: { id: string, name: string, arguments: string }[] }>} script
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

/** The junk chat that never satisfies the output contract — the refusal fixture. */
const junkChat = {
  complete: async () => ({
    content: "this is not the JSON object the contract specifies",
    toolCalls: [],
    finishReason: "stop",
  }),
};

/** A forge over the ordinary published-run shape. */
function openForge(over = {}) {
  return {
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
  };
}

/**
 * A forge over the published-run path, with a `src/a.mjs` present on disk.
 * @param {{ runnerTemp?: string }} [options]
 * @returns {{ env: ReturnType<typeof runnerEnv>, root: string, upserts: Array<{ id?: number, body?: string }>, forge: any }}
 */
function publishedForge(options = {}) {
  const root = mkdtempSync(p.join(tmpdir(), "gate-run-"));
  mkdirSync(p.join(root, "src"));
  writeFileSync(p.join(root, "src", "a.mjs"), "line1\nline2\nline3\n");
  /** @type {Array<{ id?: number, body?: string }>} */
  const upserts = [];
  const env = runnerEnv({
    extra: {
      GITHUB_WORKSPACE: root,
      ...(options.runnerTemp !== undefined ? { RUNNER_TEMP: options.runnerTemp } : {}),
    },
  });
  return {
    env,
    root,
    upserts,
    /** @type {any} */
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
          {
            filename: "src/a.mjs",
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "@@ -1,3 +1,3 @@\n-line1\n+line1 changed",
          },
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
  };
}

/**
 * The per-run SARIF and artifact outputs land under the given roots.
 * @param {string} runnerTemp a directory that will hold the run's outputs
 * @param {string} outFile the GITHUB_OUTPUT file path
 */
function withOutputs(runnerTemp, outFile) {
  writeFileSync(outFile, "");
  vi.stubEnv("GITHUB_OUTPUT", outFile);
  vi.stubEnv("RUNNER_TEMP", runnerTemp);
}

describe("a red terminal writes no SARIF (#440, ADR 006)", () => {
  it("a refused run names no `sarif-path` and lands no SARIF file", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "red-sarif-refused-"));
    const temp = mkdtempSync(p.join(tmpdir(), "red-sarif-temp-"));
    const outFile = p.join(temp, "gh-output.txt");
    const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
    withOutputs(temp, outFile);
    try {
      const cause = await run(readInputs(env), readContext(env), {
        forge: openForge(),
        chat: junkChat,
        sleep: async () => {},
        now: () => 0,
        info: () => undefined,
      }).then(
        () => null,
        (error) => error,
      );
      expect(cause).toBeInstanceOf(DeterministicRefusalError);
      // The refusal's artifact still landed.
      const files = readdirSync(p.join(root, ".review-artifact"));
      expect(files).toEqual([`review-artifact-refused-${"a".repeat(40)}.json`]);
      // The Code Scanning column stays empty: no sarif-path, no SARIF bytes.
      expect(readFileSync(outFile, "utf8")).not.toContain("sarif-path=");
      expect(readdirSync(temp).some((name) => name.startsWith("review-sarif-"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });

  it("a failed run names no `sarif-path` and lands no SARIF file", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "red-sarif-failed-"));
    const temp = mkdtempSync(p.join(tmpdir(), "red-sarif-temp-"));
    const outFile = p.join(temp, "gh-output.txt");
    const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
    withOutputs(temp, outFile);
    const breakage = new Error("connection reset");
    try {
      const cause = await run(readInputs(env), readContext(env), {
        forge: openForge({
          getPullRequest: async () => {
            throw /** @type {any} */ (breakage);
          },
        }),
        chat: junkChat,
        sleep: async () => {},
        now: () => 0,
        info: () => undefined,
      }).then(
        () => null,
        (error) => error,
      );
      expect(cause).toBe(breakage);
      const files = readdirSync(p.join(root, ".review-artifact"));
      expect(files).toEqual(["review-artifact-failed-no-head.json"]);
      expect(readFileSync(outFile, "utf8")).not.toContain("sarif-path=");
      expect(readdirSync(temp).some((name) => name.startsWith("review-sarif-"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });

  it("contrast: a published clean run names `sarif-path` with a byte-identical copy", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const temp = mkdtempSync(p.join(tmpdir(), "gate-temp-"));
    const outFile = p.join(temp, "gh-output.txt");
    writeFileSync(outFile, "");
    vi.stubEnv("GITHUB_OUTPUT", outFile);
    const { env, root, forge } = publishedForge({ runnerTemp: temp });
    try {
      const result = await run(readInputs(env), readContext(env), {
        forge,
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
      const outputs = readFileSync(outFile, "utf8");
      expect(outputs).toContain("sarif-path=");
      // The SARIF file landed under the runner temp — the projection is the
      // same copy the workflow uploads (review.yml gates on sarif-path != '').
      expect(readdirSync(temp).some((name) => name.startsWith("review-sarif-"))).toBe(true);
      // The workspace is untouched by the projection.
      expect(readdirSync(root)).toEqual([".review-artifact", "src"]);
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
});

describe("the class decides the record, never the message (#440)", () => {
  it("a plain Error with the words of a refusal records `failed`", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "class-failed-"));
    const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
    try {
      const breakage = new Error("the diff refuses to be half-reviewed");
      const cause = await run(readInputs(env), readContext(env), {
        forge: openForge({
          getPullRequest: async () => {
            throw breakage;
          },
        }),
        chat: junkChat,
        sleep: async () => {},
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
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a DeterministicRefusalError with the same words records `refused`", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "class-refused-"));
    const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
    try {
      const refusal = new DeterministicRefusalError("the diff refuses to be half-reviewed");
      const cause = await run(readInputs(env), readContext(env), {
        forge: openForge({
          listPullRequestFiles: async () => {
            throw refusal;
          },
        }),
        chat: junkChat,
        sleep: async () => {},
        now: () => 0,
        info: () => undefined,
      }).then(
        () => null,
        (error) => error,
      );
      expect(cause).toBe(refusal);
      const files = readdirSync(p.join(root, ".review-artifact"));
      expect(files.length).toBe(1);
      const record = JSON.parse(
        readFileSync(p.join(root, ".review-artifact", files[0] ?? ""), "utf8"),
      );
      expect(record.outcome.classification).toBe("refused");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("a coverage-accounting break is a defect, not a ceiling (#440)", () => {
  it("a diff whose expected set cannot be derived records `failed`, never `refused`", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "cov-defect-"));
    const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
    try {
      const cause = await run(readInputs(env), readContext(env), {
        forge: openForge({
          // A deletion whose diff header names a path the reviewed inventory
          // cannot account for — `parseDiffPaths(unifiedDiff(reviewed))` must
          // equal `reviewed` exactly, or the run refuses.
          listPullRequestFiles: async () => {
            return [
              /** @type {any} */ ({
                filename: "lib/gone.mjs",
                status: "removed",
                additions: 0,
                deletions: 1,
                patch: "@@ -1,1 +1,0 @@\n-x\n--- a/ghost.mjs",
              }),
            ];
          },
        }),
        chat: junkChat,
        sleep: async () => {},
        now: () => 0,
        info: () => undefined,
      }).then(
        () => null,
        (error) => error,
      );
      // A plain Error — the class of the accounting defect — so the boundary
      // records `failed`, not the capacity ceiling's `refused`.
      expect(cause).toBeInstanceOf(Error);
      expect(/** @type {Error} */ (cause).message).toMatch(/cannot account for the whole universe/);
      const files = readdirSync(p.join(root, ".review-artifact"));
      expect(files.length).toBe(1);
      const record = JSON.parse(
        readFileSync(p.join(root, ".review-artifact", files[0] ?? ""), "utf8"),
      );
      expect(record.outcome.classification).toBe("failed");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("raw vs eligible (#440)", () => {
  it("a raw-oversized-but-eligible PR publishes clean because ignore shrank the universe", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const temp = mkdtempSync(p.join(tmpdir(), "c1-temp-"));
    const outFile = p.join(temp, "gh-output.txt");
    writeFileSync(outFile, "");
    vi.stubEnv("GITHUB_OUTPUT", outFile);
    const root = mkdtempSync(p.join(tmpdir(), "c1-"));
    mkdirSync(p.join(root, "src"));
    writeFileSync(p.join(root, "src", "a.mjs"), "line1\nline2\nline3\n");
    const env = runnerEnv({
      extra: { GITHUB_WORKSPACE: root, RUNNER_TEMP: temp },
    });
    try {
      // The raw diff is enormous, but `dist/**` and `pnpm-lock.yaml` are in
      // the ignore set: the eligible universe is a single small file, well
      // under the budget. The run is applicable, eligible, and publishes.
      const result = await run(readInputs(env), readContext(env), {
        forge: openForge({
          /** @param {string} path */
          async getContents(path) {
            return path.endsWith("review.json5")
              ? {
                  content: '{\n  ignore: ["dist/**", "pnpm-lock.yaml"],\n  maxDiffLines: 5000,\n}',
                }
              : null;
          },
          async listPullRequestFiles() {
            return [
              /** @type {any} */ ({
                filename: "dist/bundle.min.js",
                status: "modified",
                additions: 10000,
                deletions: 0,
                patch: "@@ -1 +1 @@\n+// build",
              }),
              /** @type {any} */ ({
                filename: "pnpm-lock.yaml",
                status: "modified",
                additions: 400,
                deletions: 400,
                patch: "@@ -1 +1 @@\n+dep",
              }),
              /** @type {any} */ ({
                filename: "src/a.mjs",
                status: "modified",
                additions: 1,
                deletions: 0,
                patch: "@@ -1,3 +1,3 @@\n-line1\n+line1 changed",
              }),
            ];
          },
        }),
        chat: readingChat([
          {
            content: "",
            toolCalls: [{ id: "r1", name: "read_file", arguments: '{"path":"src/a.mjs"}' }],
          },
          {
            content: '{"findings":[],"summary":"clean"}',
          },
        ]),
        now: () => 0,
        info: () => undefined,
      });
      expect(result.outcome).toBe("published");
      expect(/** @type {any} */ (result).canonical?.run.verdict).toBe("pass");
      // The budget refusal is not taken: the eligible universe is small.
      expect(readFileSync(outFile, "utf8")).toContain("sarif-path=");
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
});

describe("eligibility reads pre-ignore, the budget reads post-ignore (#440)", () => {
  it("a size guard can skip a PR the budget would have reviewed", () => {
    // (A) A guard at gt 8000 pre-ignore lines skips a PR whose post-ignore
    // universe is tiny — eligibility, not capacity: the two axes measure
    // different universes on purpose, and the skip is an explicit recorded
    // decision, never a reclassification of the budget.
    const files = [
      /** @type {any} */ ({ filename: "pnpm-lock.yaml", additions: 9000, deletions: 0 }),
      /** @type {any} */ ({ filename: "src/a.mjs", additions: 1, deletions: 0 }),
    ];
    const totals = changeTotals(files);
    expect(totals).toEqual({ files: 2, lines: 9001 });
    const inventory = buildInventory({
      files,
      ignore: ["pnpm-lock.yaml"],
      maxDiffLines: 5000,
    });
    // The budget only sees the small survivor — the raw guard and the budget
    // measure different universes on purpose.
    expect(inventory.reviewed.map((file) => file.filename)).toEqual(["src/a.mjs"]);
    expect(inventory.countedDiffLines).toBe(1);
    expect(inventory.excluded.length).toBe(0);
    // The size-anchored eligibility decision reads the pre-ignore totals: a
    // gt-8000 guard skips this 9001-line PR even though the post-ignore
    // universe the budget counts is a single line.
    const policy = validateApplicabilityPolicy(
      {
        bots: [],
        rules: [{ id: "oversized", when: { changes: { lines: { gt: 8000 } } }, run: false }],
      },
      "medium",
    );
    const evaluated = evaluateApplicability({
      policy,
      context: "external",
      title: "chore: regenerate the generated modules",
      branch: "codegen/regenerate-all",
      changes: totals,
      paths: inventory.reviewed.map((file) => file.filename),
    });
    expect(evaluated).toEqual({
      applicable: false,
      matchedRule: "oversized",
      basis: "rule",
      posture: "standard",
    });
  });

  it("a PR under the size guard but over the budget refuses (red), never skips", async () => {
    // (B) The corollary of (A): the 3000–8000 band. A diff an eligibility
    // guard would not catch (under gt 8000) but the budget cannot hold
    // (over maxDiffLines) must end red `refused` as capacity — a refusal is
    // never reclassified into a green skip. This is the exact band the
    // retired dogfood `oversized` rule used to turn green.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(p.join(tmpdir(), "under-guard-over-budget-"));
    const env = runnerEnv({ extra: { GITHUB_WORKSPACE: root } });
    try {
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
        }),
        chat: junkChat,
        sleep: async () => {},
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
      // The refusal is a capacity outcome, not a skip: no negated eligibility
      // fact rides on the red record.
      expect(record.applicability).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
});
