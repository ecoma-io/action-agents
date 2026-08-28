// Tests for the risk classifier: every table row, the aggregation (maximum,
// union, the pinned critical combination), the deterministic signal order,
// and the shapes a hostile file list can take. Nothing here judges risk by
// hand — each expectation is pinned to what the table must say.

import { describe, expect, it } from "vitest";

import { classifyRisk } from "./risk.mjs";

/**
 * @param {string} filename
 * @param {number} [additions]
 * @param {number} [deletions]
 * @returns {import("./risk.mjs").ChangedFile}
 */
function file(filename, additions = 3, deletions = 1) {
  return { filename, status: "modified", additions, deletions };
}

/**
 * @param {string[]} filenames
 * @returns {import("./risk.mjs").ChangedFile[]}
 */
function files(...filenames) {
  return filenames.map((filename) => file(filename));
}

describe("the table, row by row", () => {
  it("reads a workflow file as ci-workflow: high, correctness and reliability", () => {
    expect(classifyRisk(files(".github/workflows/ci.yml"))).toEqual({
      risk: "high",
      lanes: ["correctness", "reliability"],
      signals: [{ kind: "ci-workflow", path: ".github/workflows/ci.yml" }],
    });
  });

  it("reads an action manifest at any depth as ci-workflow too", () => {
    expect(classifyRisk(files("tools/action.yaml")).signals).toEqual([
      { kind: "ci-workflow", path: "tools/action.yaml" },
    ]);
    expect(classifyRisk(files("sub/dir/action.yml")).risk).toBe("high");
  });

  it("reads a credential-surface segment as auth: high and security", () => {
    expect(classifyRisk(files("src/auth/login.ts"))).toEqual({
      risk: "high",
      lanes: ["correctness", "security"],
      signals: [{ kind: "auth", path: "src/auth/login.ts" }],
    });
  });

  it("hears every credential segment the table names, in either number", () => {
    for (const path of [
      "src/session/store.ts",
      "src/tokens/refresh.ts",
      "src/permissions/check.ts",
      "src/acl/matrix.ts",
    ]) {
      expect(classifyRisk(files(path)).signals).toEqual([{ kind: "auth", path }]);
    }
  });

  it("reads credential content in the path as crypto, not only segments", () => {
    for (const path of ["src/crypto/cipher.ts", "src/hash.ts", "config/secret.key"]) {
      const plan = classifyRisk(files(path));
      expect(plan.signals).toEqual([{ kind: "crypto", path }]);
      expect(plan.risk).toBe("high");
    }
  });

  it("reads the HTTP surface as network: medium, reliability and security", () => {
    expect(classifyRisk(files("src/api/users.ts"))).toEqual({
      risk: "medium",
      lanes: ["correctness", "security", "reliability"],
      signals: [{ kind: "network", path: "src/api/users.ts" }],
    });
  });

  it("hears network in a server segment and a client basename alike", () => {
    expect(classifyRisk(files("server/index.ts")).signals).toEqual([
      { kind: "network", path: "server/index.ts" },
    ]);
    expect(classifyRisk(files("client.ts")).signals).toEqual([
      { kind: "network", path: "client.ts" },
    ]);
    expect(classifyRisk(files("src/fetchUser.ts")).risk).toBe("medium");
  });

  it("reads persistence once even when three triggers fire on one file", () => {
    expect(classifyRisk(files("db/migrations/0001-add-users.sql"))).toEqual({
      risk: "medium",
      lanes: ["correctness", "reliability"],
      signals: [{ kind: "persistence", path: "db/migrations/0001-add-users.sql" }],
    });
  });

  it("reads the manifests the workspace installs from as dependencies", () => {
    expect(classifyRisk(files("package.json"))).toEqual({
      risk: "medium",
      lanes: ["correctness", "reliability"],
      signals: [{ kind: "dependencies", path: "package.json" }],
    });
    // The lock keyword is a runtime notion; the lockfile is dependencies'
    // evidence, so it earns no concurrency signal.
    expect(classifyRisk(files("pnpm-lock.yaml")).signals).toEqual([
      { kind: "dependencies", path: "pnpm-lock.yaml" },
    ]);
  });

  it("reads release plumbing as release: reliability, no raised risk", () => {
    for (const path of [
      "release-please-config.json",
      ".release-please-manifest.json",
      "VERSION",
      "version.txt",
    ]) {
      const plan = classifyRisk(files(path));
      expect(plan.risk).toBe("low");
      expect(plan.lanes).toEqual(["correctness", "reliability"]);
      expect(plan.signals).toEqual([{ kind: "release", path }]);
    }
  });

  it("reads coordination sources as concurrency: reliability, no raised risk", () => {
    for (const path of [
      "src/concurrency/lock.ts",
      "src/mutex.rs",
      "src/queue.ts",
      "src/state.ts",
    ]) {
      const plan = classifyRisk(files(path));
      expect(plan.risk).toBe("low");
      expect(plan.signals).toEqual([{ kind: "concurrency", path }]);
    }
  });

  it("reads a top-level barrel as api-surface, and a nested one as baseline", () => {
    expect(classifyRisk(files("index.js"))).toEqual({
      risk: "low",
      lanes: ["correctness"],
      signals: [{ kind: "api-surface", path: "index.js" }],
    });
    // Documented miss: `src/index.ts` is not top-level, so it is baseline.
    expect(classifyRisk(files("src/index.ts")).signals).toEqual([]);
  });

  it("reads a test change as tests: the testing lane, no raised risk", () => {
    expect(classifyRisk(files("src/foo.test.ts"))).toEqual({
      risk: "low",
      lanes: ["correctness", "testing"],
      signals: [{ kind: "tests", path: "src/foo.test.ts" }],
    });
  });

  it("hears a test tree segment and a spec basename alike", () => {
    expect(classifyRisk(files("tests/login.spec.ts")).signals).toEqual([
      { kind: "tests", path: "tests/login.spec.ts" },
    ]);
  });

  it("lands an unrecognised file at the baseline: low, correctness, no evidence", () => {
    expect(classifyRisk(files("README.md"))).toEqual({
      risk: "low",
      lanes: ["correctness"],
      signals: [],
    });
  });
});

describe("aggregation", () => {
  it("takes the maximum floor across files, not the first or the last", () => {
    expect(classifyRisk(files("README.md", "src/api/users.ts", "src/auth/login.ts")).risk).toBe(
      "high",
    );
    expect(classifyRisk(files("README.md", "src/api/users.ts")).risk).toBe("medium");
  });

  it("unions lanes across files, in the plan's fixed order", () => {
    expect(
      classifyRisk(files("src/auth/login.ts", ".github/workflows/ci.yml", "src/foo.test.ts")).lanes,
    ).toEqual(["correctness", "security", "reliability", "testing"]);
  });

  it("pins critical to one file matching ci-workflow and a credential rule", () => {
    expect(classifyRisk(files(".github/workflows/secret-scan.yml"))).toEqual({
      risk: "critical",
      lanes: ["correctness", "security", "reliability"],
      signals: [
        { kind: "ci-workflow", path: ".github/workflows/secret-scan.yml" },
        { kind: "crypto", path: ".github/workflows/secret-scan.yml" },
      ],
    });
    expect(classifyRisk(files(".github/workflows/auth/rotate.yml")).risk).toBe("critical");
  });

  it("does not promote network plus ci-workflow — the shared lane is not the trigger", () => {
    expect(classifyRisk(files(".github/workflows/api/deploy.yml"))).toEqual({
      risk: "high",
      lanes: ["correctness", "security", "reliability"],
      signals: [
        { kind: "ci-workflow", path: ".github/workflows/api/deploy.yml" },
        { kind: "network", path: ".github/workflows/api/deploy.yml" },
      ],
    });
  });

  it("keeps a tests-only change low even next to a critical file", () => {
    const plan = classifyRisk(files(".github/workflows/secret-scan.yml", "src/foo.test.ts"));
    expect(plan.risk).toBe("critical");
    expect(plan.lanes).toEqual(["correctness", "security", "reliability", "testing"]);
  });
});

describe("deterministic output", () => {
  it("sorts signals byte-wise by kind then path, whatever the input order", () => {
    const plan = classifyRisk(files("src/queue.ts", "src/tokens/refresh.ts", "src/auth/login.ts"));
    expect(plan.signals).toEqual([
      { kind: "auth", path: "src/auth/login.ts" },
      { kind: "auth", path: "src/tokens/refresh.ts" },
      { kind: "concurrency", path: "src/queue.ts" },
    ]);
  });

  it("deduplicates a file listed twice to one signal", () => {
    const plan = classifyRisk([file("src/auth/login.ts"), file("src/auth/login.ts")]);
    expect(plan.signals).toEqual([{ kind: "auth", path: "src/auth/login.ts" }]);
  });

  it("returns an equal plan for any permutation of the same list", () => {
    const list = files(
      ".github/workflows/ci.yml",
      "src/auth/login.ts",
      "src/api/users.ts",
      "db/migrations/0001.sql",
      "src/foo.test.ts",
    );
    expect(classifyRisk([...list].reverse())).toEqual(classifyRisk(list));
  });
});

describe("shapes a hostile file list takes", () => {
  it("is case-blind in matching and case-faithful in evidence", () => {
    expect(classifyRisk(files("AUTH/SESSION.TS")).risk).toBe("high");
    expect(classifyRisk(files("Auth/Login.TS")).signals).toEqual([
      { kind: "auth", path: "Auth/Login.TS" },
    ]);
  });

  it("folds backslashes so a windows shape cannot hide from a rule", () => {
    expect(classifyRisk([file("src\\auth\\login.ts")])).toEqual({
      risk: "high",
      lanes: ["correctness", "security"],
      signals: [{ kind: "auth", path: "src/auth/login.ts" }],
    });
  });

  it("survives unicode paths and classifies the segment that still matches", () => {
    expect(classifyRisk([file("src/auth/用户.ts")])).toEqual({
      risk: "high",
      lanes: ["correctness", "security"],
      signals: [{ kind: "auth", path: "src/auth/用户.ts" }],
    });
  });

  it("survives very long paths", () => {
    const plan = classifyRisk([file(`${"x/".repeat(5000)}auth/login.ts`)]);
    expect(plan.risk).toBe("high");
  });

  it("degrades an empty or dot-shaped name to the baseline instead of throwing", () => {
    expect(classifyRisk([file("")])).toEqual({
      risk: "low",
      lanes: ["correctness"],
      signals: [],
    });
    expect(classifyRisk([file("./index.js")]).signals).toEqual([
      { kind: "api-surface", path: "index.js" },
    ]);
    expect(classifyRisk([file("//auth//login.ts")]).signals).toEqual([
      { kind: "auth", path: "auth/login.ts" },
    ]);
  });

  it("treats a dots-only name as a file that matches nothing", () => {
    expect(classifyRisk([file("...")])).toEqual({
      risk: "low",
      lanes: ["correctness"],
      signals: [],
    });
  });
});

describe("the empty plan", () => {
  it("is low, correctness alone, and no evidence", () => {
    expect(classifyRisk([])).toEqual({ risk: "low", lanes: ["correctness"], signals: [] });
  });
});
