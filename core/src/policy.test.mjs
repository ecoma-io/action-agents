import { describe, expect, it } from "vitest";
import {
  PolicyResolutionError,
  assertPolicySchemaVersion,
  policyReader,
  policySourceAuditLine,
  resolvePolicySource,
} from "./policy.mjs";

/** A full 40-hex commit sha, distinct from every other sha in this file. */
const MAIN_SHA = "a".repeat(40);
const DEV_SHA = "b".repeat(40);
/** The payload's creation-time base sha — must never become the pin. */
const STALE_BASE_SHA = "c".repeat(40);

/**
 * A forge double that answers ref lookups from a table and records every
 * call, so tests can assert which branches were resolved — and how often.
 *
 * @param {{ defaultBranch?: string, refs?: Record<string, string> }} [options]
 * @returns {import("#core/forge.mjs").Forge & { refCalls: string[], contents: { path: string, ref: string | undefined }[] }}
 */
function forgeDouble({ defaultBranch = "main", refs = {} } = {}) {
  /** @type {string[]} */
  const refCalls = [];
  /** @type {{ path: string, ref: string | undefined }[]} */
  const contents = [];
  return /** @type {any} */ ({
    refCalls,
    contents,
    async getRepository() {
      return { defaultBranch, name: "widgets", description: "" };
    },
    /** @param {string} branch */
    async getRef(branch) {
      refCalls.push(branch);
      const sha = refs[branch];
      if (sha === undefined) {
        throw new Error(`404 no ref for '${branch}'`);
      }
      return { sha };
    },
    /** @param {string} path @param {{ ref?: string }} [options] */
    async getContents(path, options = {}) {
      contents.push({ path, ref: options.ref });
      return null;
    },
  });
}

describe("resolvePolicySource — pull_request and pull_request_target", () => {
  it("resolves the base branch's live tip, never the payload's base.sha", async () => {
    const forge = forgeDouble({ refs: { main: MAIN_SHA } });
    const source = await resolvePolicySource({
      eventName: "pull_request",
      event: {
        action: "synchronize",
        pull_request: { number: 7, base: { ref: "main", sha: STALE_BASE_SHA } },
      },
      forge,
    });
    expect(source).toEqual({ basis: "base", branch: "main", sha: MAIN_SHA });
    // The governance line's current tip is fetched; the payload's sha is not.
    expect(forge.refCalls).toEqual(["main"]);
  });

  it("resolves pull_request_target the same way — the base branch governs a fork too", async () => {
    const forge = forgeDouble({ refs: { main: MAIN_SHA } });
    const source = await resolvePolicySource({
      eventName: "pull_request_target",
      event: {
        action: "opened",
        pull_request: {
          number: 2,
          base: { ref: "main" },
          head: { ref: "fork:topic", sha: DEV_SHA },
        },
      },
      forge,
    });
    expect(source).toEqual({ basis: "base", branch: "main", sha: MAIN_SHA });
    expect(forge.refCalls).toEqual(["main"]);
  });

  it("refuses a pull_request event that names no base branch", async () => {
    const forge = forgeDouble();
    await expect(
      resolvePolicySource({
        eventName: "pull_request",
        event: { action: "opened", pull_request: { number: 3 } },
        forge,
      }),
    ).rejects.toThrow(PolicyResolutionError);
    expect(forge.refCalls).toEqual([]);
  });

  it("refuses a pull_request event whose base.ref is empty", async () => {
    const forge = forgeDouble();
    await expect(
      resolvePolicySource({
        eventName: "pull_request",
        event: { pull_request: { base: { ref: "" } } },
        forge,
      }),
    ).rejects.toThrow(/no base branch/);
  });
});

describe("resolvePolicySource — push", () => {
  it("is governed by the pushed commit itself, with no ref lookup", async () => {
    const forge = forgeDouble({ refs: { main: MAIN_SHA } });
    const source = await resolvePolicySource({
      eventName: "push",
      event: { ref: "refs/heads/main", after: DEV_SHA },
      forge,
    });
    expect(source).toEqual({ basis: "pushed", branch: "main", sha: DEV_SHA });
    // The event fixes the tip: no extra call, no racing a second push.
    expect(forge.refCalls).toEqual([]);
  });

  it("refuses a push whose after sha is not 40-hex", async () => {
    const forge = forgeDouble();
    await expect(
      resolvePolicySource({
        eventName: "push",
        event: { ref: "refs/heads/main", after: "b".repeat(39) },
        forge,
      }),
    ).rejects.toThrow(/no 40-hex after sha/);
  });

  it("refuses a branch-deletion push — an all-zero after names no source", async () => {
    const forge = forgeDouble();
    await expect(
      resolvePolicySource({
        eventName: "push",
        event: { ref: "refs/heads/main", after: "0".repeat(40) },
        forge,
      }),
    ).rejects.toThrow(/deletes the branch/);
  });

  it("falls to the default branch for a tag push — a tag is content, not governance", async () => {
    const forge = forgeDouble({ refs: { main: MAIN_SHA } });
    const source = await resolvePolicySource({
      eventName: "push",
      event: { ref: "refs/tags/v1.2.3", after: DEV_SHA },
      forge,
    });
    expect(source).toEqual({ basis: "default", branch: "main", sha: MAIN_SHA });
    expect(forge.refCalls).toEqual(["main"]);
  });

  it("refuses a push event without a ref", async () => {
    const forge = forgeDouble();
    await expect(
      resolvePolicySource({ eventName: "push", event: { after: DEV_SHA }, forge }),
    ).rejects.toThrow(/names no ref/);
  });
});

describe("resolvePolicySource — workflow_dispatch", () => {
  it("is governed by the dispatched branch's tip", async () => {
    const forge = forgeDouble({ refs: { dev: DEV_SHA } });
    const source = await resolvePolicySource({
      eventName: "workflow_dispatch",
      event: { ref: "refs/heads/dev" },
      forge,
    });
    expect(source).toEqual({ basis: "dispatched", branch: "dev", sha: DEV_SHA });
    expect(forge.refCalls).toEqual(["dev"]);
  });

  it("falls to the default branch when dispatched on a tag", async () => {
    const forge = forgeDouble({ refs: { main: MAIN_SHA } });
    const source = await resolvePolicySource({
      eventName: "workflow_dispatch",
      event: { ref: "refs/tags/v9" },
      forge,
    });
    expect(source).toEqual({ basis: "default", branch: "main", sha: MAIN_SHA });
  });

  it("refuses a dispatch event without a ref", async () => {
    const forge = forgeDouble();
    await expect(
      resolvePolicySource({ eventName: "workflow_dispatch", event: {}, forge }),
    ).rejects.toThrow(/names no ref/);
  });
});

describe("resolvePolicySource — every other event falls to the default branch", () => {
  it("resolves schedule through the repository's declared line", async () => {
    const forge = forgeDouble({ defaultBranch: "trunk", refs: { trunk: MAIN_SHA } });
    const source = await resolvePolicySource({ eventName: "schedule", event: {}, forge });
    expect(source).toEqual({ basis: "default", branch: "trunk", sha: MAIN_SHA });
    expect(forge.refCalls).toEqual(["trunk"]);
  });

  it("resolves issues the same way — issues never carry a line fact", async () => {
    const forge = forgeDouble({ refs: { main: MAIN_SHA } });
    const source = await resolvePolicySource({
      eventName: "issues",
      event: { action: "opened", issue: { number: 11 } },
      forge,
    });
    expect(source).toEqual({ basis: "default", branch: "main", sha: MAIN_SHA });
  });
});

describe("resolvePolicySource — refusal shape", () => {
  it("wraps a getRef failure in a typed refusal, preserving the cause", async () => {
    const forge = forgeDouble({ refs: {} });
    const error = await resolvePolicySource({
      eventName: "schedule",
      event: {},
      forge,
    }).then(
      () => undefined,
      /** @param {unknown} e */
      (e) => e,
    );
    expect(error).toBeInstanceOf(PolicyResolutionError);
    expect(/** @type {PolicyResolutionError} */ (error).message).toMatch(
      /tip of branch 'main' could not be resolved/,
    );
    expect(/** @type {PolicyResolutionError} */ (error).cause).toBeInstanceOf(Error);
  });

  it("wraps a getRepository failure in a typed refusal", async () => {
    const forge = forgeDouble();
    forge.getRepository = async () => {
      throw new Error("502");
    };
    await expect(resolvePolicySource({ eventName: "issues", event: {}, forge })).rejects.toThrow(
      /default branch could not be read/,
    );
  });

  it("refuses a getRef answer that is not a 40-hex sha", async () => {
    const forge = forgeDouble({ refs: { main: "short" } });
    await expect(resolvePolicySource({ eventName: "issues", event: {}, forge })).rejects.toThrow(
      /not a 40-hex commit sha/,
    );
  });
});

describe("policyReader", () => {
  it("pins every read to the resolved source's sha", async () => {
    const forge = forgeDouble();
    const read = policyReader(forge, { basis: "pushed", branch: "main", sha: DEV_SHA });
    await read(".github/action-agents/review/review.json5");
    await read("docs/a.md");
    expect(forge.contents).toEqual([
      { path: ".github/action-agents/review/review.json5", ref: DEV_SHA },
      { path: "docs/a.md", ref: DEV_SHA },
    ]);
  });
});

describe("policySourceAuditLine", () => {
  it("records event, basis, branch, full sha, and path on one line", () => {
    const line = policySourceAuditLine({
      eventName: "pull_request",
      source: { basis: "base", branch: "main", sha: MAIN_SHA },
      path: ".github/action-agents/review/review.json5",
    });
    expect(line).toBe(
      `policy source: event=pull_request basis=base branch=main sha=${MAIN_SHA} ` +
        "path=.github/action-agents/review/review.json5",
    );
  });

  it("says (none) when the run reads no policy file", () => {
    const line = policySourceAuditLine({
      eventName: "issues",
      source: { basis: "default", branch: "main", sha: DEV_SHA },
      path: "",
    });
    expect(line).toBe(
      `policy source: event=issues basis=default branch=main sha=${DEV_SHA} path=(none)`,
    );
  });
});

describe("assertPolicySchemaVersion", () => {
  /** @type {import("./policy.mjs").PolicySource} */
  const source = { basis: "base", branch: "main", sha: MAIN_SHA };
  const path = ".github/action-agents/review/review.json5";

  it("accepts an absent schemaVersion — pre-versioning files keep working", () => {
    expect(() =>
      assertPolicySchemaVersion({ raw: { strictness: "high" }, supportedMajor: 1, path, source }),
    ).not.toThrow();
  });

  it("accepts a null raw — no policy file at all", () => {
    expect(() =>
      assertPolicySchemaVersion({ raw: null, supportedMajor: 1, path, source }),
    ).not.toThrow();
  });

  it("accepts the supported major", () => {
    expect(() =>
      assertPolicySchemaVersion({ raw: { schemaVersion: 1 }, supportedMajor: 1, path, source }),
    ).not.toThrow();
  });

  it("refuses a newer major, naming branch, sha, path, and both majors", () => {
    expect(() =>
      assertPolicySchemaVersion({ raw: { schemaVersion: 2 }, supportedMajor: 1, path, source }),
    ).toThrow(
      new RegExp(
        `'${path}' on branch 'main' at ${MAIN_SHA} declares schemaVersion 2, ` +
          "but this action understands schema major 1 only",
      ),
    );
  });

  it("refuses a string value — a version is a number, not a label", () => {
    expect(() =>
      assertPolicySchemaVersion({ raw: { schemaVersion: "1" }, supportedMajor: 1, path, source }),
    ).toThrow(/declares schemaVersion "1"/);
  });

  it("refuses a fractional value", () => {
    expect(() =>
      assertPolicySchemaVersion({ raw: { schemaVersion: 1.5 }, supportedMajor: 1, path, source }),
    ).toThrow(/declares schemaVersion 1\.5/);
  });

  it("refuses an older major with the same message shape", () => {
    expect(() =>
      assertPolicySchemaVersion({ raw: { schemaVersion: 0 }, supportedMajor: 1, path, source }),
    ).toThrow(/declares schemaVersion 0, but this action understands schema major 1 only/);
  });
});
