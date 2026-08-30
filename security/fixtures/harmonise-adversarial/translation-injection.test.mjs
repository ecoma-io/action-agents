// Translation-content injection — a hostile model's answer, attacked as the
// one thing the model controls: the text of the proposed translation.
//
// Attack: the model's answer smuggles HTML into the target-language document
// (`<script>`, `on*` event handlers, a `javascript:` href) or retargets a
// markdown link to a foreign host — the two ways model text becomes more than
// text once committed and viewed.
//   -> capability must remain bounded: the proposal is judged before it
//      reaches the forge. `sanitizeTranslationHtml` (`harmonise/src/plan.mjs`)
//      blanks dangerous constructs in place (same-length spaces, fixpoint
//      loop), and `validateLinkGraph` (`harmonise/src/link-graph.mjs`) refuses
//      the pair when a link's destination identity changed — an internal link
//      swapped for a scheme destination, or an external destination rewritten
//      byte for byte. A hostile summary is additionally sanitised on its way
//      into the PR body (`harmonise/src/pull-request.mjs` ->
//      `core/src/sanitise.mjs`): tag-shaped `<` escaped, `@handles` broken
//      with a zero-width non-joiner.
//
// Pinned through one real `run()` (`harmonise/src/index.mjs`) on a scripted
// chat and a recording forge: DVD-safe committed bytes, exactly one PR (side
// effects never multiplied), and refusals that never retry the model and
// never write to the forge. Deterministic and offline.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { BranchMovedError, isRefAbsentError } from "#core/forge.mjs";

import { readInputs, run } from "../../../harmonise/src/index.mjs";

/**
 * A real event payload file on disk: the default `readEvent` in the entry
 * point parses this exact file, as it would in a runner.
 */
const EVENT_PATH = (() => {
  const dir = mkdtempSync(join(tmpdir(), "harmonise-adversarial-event-"));
  const path = join(dir, "event.json");
  writeFileSync(path, JSON.stringify({ ref: "refs/heads/main" }));
  return path;
})();

/** The runner environment the fixtures execute under: en, one target (vi). */
const runner = {
  "INPUT_GITHUB-TOKEN": "ghs_x",
  "INPUT_API-URL": "https://api.example/v1",
  "INPUT_API-KEY": "sk-secret",
  INPUT_MODEL: "gpt-x",
  GITHUB_REPOSITORY: "ecoma-io/action-agents",
  GITHUB_WORKSPACE: "/work",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_EVENT_PATH: EVENT_PATH,
  "INPUT_SOURCE-LANGUAGE": "en",
};

const CONFIG_PATH = ".github/action-agents/harmonise/harmonise.json5";

/**
 * The harmonise config document the fixture works against: one source
 * language, one target language, a plain manual/ map.
 *
 * @returns {string}
 */
function makeConfig() {
  return JSON.stringify(
    {
      sourceLanguage: "en",
      languages: { en: "manual/{document}.md", vi: "manual/vi/{document}.md" },
    },
    null,
    2,
  );
}

/**
 * The repository content a forge double serves: the config at its one real
 * path plus the source document, with whatever the caller overrides.
 *
 * @param {{ documents?: Record<string, string> }} [overrides]
 * @returns {Record<string, string>} path -> bytes
 */
function makeRepo(overrides = {}) {
  return {
    [CONFIG_PATH]: makeConfig(),
    "manual/dev.md": "# Dev\n\nProse.\n",
    ...overrides.documents,
  };
}

/**
 * The branch tree a forge double reports: every named path as a blob.
 *
 * @param {string[]} paths
 * @returns {{ path: string, type: string }[]}
 */
function makeInventory(paths) {
  return paths.map((path) => ({ path, type: "blob" }));
}

/**
 * A forge double whose whole write surface records into `writes` and whose
 * reads answer from `files` — the real Git integration is never exercised.
 *
 * @param {Record<string, string>} files
 * @param {{ path: string, type: string }[]} [tree]
 * @returns {{ writes: { op: string, args: unknown[] }[], baseSha: string } & Record<string, (...args: unknown[]) => Promise<unknown>>}
 */
function forge(
  files,
  tree = makeInventory(["manual/dev.md", "manual/vi/dev.md"]),
  /** @type {{ branches?: Record<string, { sha: string, files: Record<string, string> }> }} */ options = {},
) {
  const branches = /** @type {Record<string, { sha: string, files: Record<string, string> }>} */ (
    options.branches ?? {}
  );
  const baseSha = "a".repeat(40);
  /** @type {{ op: string, args: unknown[] }[]} */
  const writes = [];
  let blobSeq = 0;
  return /** @type {any} */ ({
    writes,
    baseSha,
    /** @param {string} path @param {{ ref?: string }} [opts] */
    async getContents(path, opts = {}) {
      const ref = opts.ref;
      const branch =
        ref !== undefined
          ? Object.values(branches).find((candidate) => candidate.sha === ref)
          : undefined;
      const source = branch !== undefined ? branch.files : files;
      const content = source[path];
      return content === undefined ? null : { content };
    },
    async getRepository() {
      return { defaultBranch: "main", name: "action-agents", description: "AI GitHub Actions" };
    },
    /** @param {string} name */
    async getRef(name) {
      const branch = branches[name];
      return branch !== undefined ? { sha: branch.sha } : { sha: baseSha };
    },
    /** @param {string} name */
    async readRef(name) {
      try {
        return await this.getRef(name);
      } catch (cause) {
        if (isRefAbsentError(cause)) return null;
        throw cause;
      }
    },
    /** @param {string} _sha */
    async listTree(_sha) {
      return tree;
    },
    /** @param {string} content */
    async createBlob(content) {
      writes.push({ op: "createBlob", args: [content] });
      blobSeq++;
      return { sha: `blob${String(blobSeq).padStart(38, "0")}` };
    },
    /** @param {string} base @param {{ path: string, blobSha: string }[]} changes */
    async createTree(base, changes) {
      writes.push({ op: "createTree", args: [base, changes] });
      return { sha: `tree-${base.slice(0, 4)}` };
    },
    /** @param {string} message @param {string} treeSha @param {string} parent */
    async createCommit(message, treeSha, parent) {
      writes.push({ op: "createCommit", args: [message, treeSha, parent] });
      return { sha: "c".repeat(40) };
    },
    /** @param {string} branch @param {string} commitSha @param {string | null} expectedCurrentSha */
    async upsertBranch(branch, commitSha, expectedCurrentSha) {
      const found = branches[branch]?.sha ?? baseSha;
      if (expectedCurrentSha !== null && expectedCurrentSha !== found) {
        throw new BranchMovedError(branch, expectedCurrentSha, found);
      }
      writes.push({ op: "upsertBranch", args: [branch, commitSha, expectedCurrentSha] });
      branches[branch] = { sha: commitSha, files: {} };
    },
    /** @param {{ base: string, head: string, title: string, body: string }} input */
    async upsertPullRequest(input) {
      writes.push({ op: "upsertPullRequest", args: [input] });
      return { number: 42, created: true };
    },
  });
}

/**
 * A chat double answering from a script of model contents, one per request;
 * the last answer repeats, which is what a retry loop meets.
 *
 * @param {(string | Error)[]} answers
 * @returns {{ calls: () => number, complete: (request: unknown) => Promise<{ content: string }> }}
 */
function chat(answers) {
  let cursor = 0;
  let calls = 0;
  return {
    calls: () => calls,
    /** @param {unknown} _request */
    async complete(_request) {
      const answer = answers[Math.min(cursor, answers.length - 1)];
      cursor++;
      calls++;
      if (answer instanceof Error) throw answer;
      return { content: /** @type {string} */ (answer) };
    },
  };
}

/**
 * A model answer proposing a translation, in the answer contract's JSON
 * shape — with the summary the caller chooses (hostile when it must be).
 *
 * @param {string} content the proposed translation text
 * @param {string} [summary] the model's one-line summary
 * @returns {string}
 */
function proposes(content, summary = "kept in step") {
  return JSON.stringify({ drift: true, summary, content });
}

/** The evidence wrapper, shaped exactly as the real createEvidence frames it. */
const evidence = {
  /** @param {string} label @param {string} content */
  wrap(label, content) {
    return `[${label}]\n${content}`;
  },
};

/**
 * An Io whose forge is given and whose chat answers from the script.
 *
 * @param {ReturnType<typeof forge>} forgeDouble
 * @param {(string | Error)[]} answers
 */
function io(forgeDouble, answers) {
  return { forge: forgeDouble, chat: chat(answers), evidence };
}

/**
 * @returns {{ owner: string, repo: string, eventName: string, eventPath: string, workspace: string, apiUrl: string }}
 */
function context() {
  return {
    owner: "ecoma-io",
    repo: "action-agents",
    eventName: "workflow_dispatch",
    eventPath: EVENT_PATH,
    workspace: "/work",
    apiUrl: "https://api.github.com",
  };
}

/**
 * A hostile translation: script tag, event handler and `javascript:` href —
 * each spelled to defeat a case-sensitive or single-pass strip.
 */
const HOSTILE_HTML = [
  "# Dev",
  "",
  "<sCrIpT>alert(1)</sCrIpT>",
  "",
  '<a href="javascript:alert(1)">go</a> <img src="x" onerror="alert(1)">',
  "",
  "Prose.",
].join("\n");

/**
 * The translation blob among a forge double's writes, found by its shape —
 * the created blob carrying this fixture's hostile marker.
 *
 * @param {{ op: string, args: unknown[] }[]} writes
 * @returns {string | undefined}
 */
function translationBlobOf(writes) {
  const write = writes.find(
    (w) =>
      w.op === "createBlob" &&
      typeof w.args[0] === "string" &&
      /** @type {string} */ (w.args[0]).includes("alert(1)"),
  );
  if (write === undefined || typeof write.args[0] !== "string") return undefined;
  return write.args[0];
}

/**
 * The pull-request write among a forge double's writes, if one happened.
 *
 * @param {{ op: string, args: unknown[] }[]} writes
 * @returns {{ base: string, head: string, title: string, body: string } | undefined}
 */
function pullRequestOf(writes) {
  const write = writes.find((w) => w.op === "upsertPullRequest");
  if (write === undefined) return undefined;
  return /** @type {{ base: string, head: string, title: string, body: string }} */ (write.args[0]);
}

describe("harmonise — hostile translation content stays bounded", () => {
  it("defangs hostile HTML in the translation before it is committed", async () => {
    const forgeDouble = forge(makeRepo());
    const ioDouble = io(forgeDouble, [proposes(HOSTILE_HTML)]);

    await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble);

    const translation = translationBlobOf(forgeDouble.writes);
    assert.ok(translation !== undefined, "the translation blob must be written");
    // The script tag is gone entirely, the event handler is blanked, the
    // javascript: URI is blanked, and the anchor carries no href attribute —
    // nothing left that could execute or navigate when the page renders.
    assert.doesNotMatch(translation, /<script/i);
    assert.doesNotMatch(translation, /onerror/i);
    assert.doesNotMatch(translation, /javascript:/i);
    assert.doesNotMatch(translation, /<a\s+href/i);

    // Hostile text does not multiply side effects: one commit, one branch
    // move, one pull request — the same shape an honest run makes.
    for (const op of ["createCommit", "upsertBranch", "upsertPullRequest"]) {
      assert.equal(
        forgeDouble.writes.filter((w) => w.op === op).length,
        1,
        `${op} must be written exactly once`,
      );
    }

    const pr = pullRequestOf(forgeDouble.writes);
    assert.ok(pr !== undefined, "a pull request must be opened");
    assert.match(pr.body, /## What changed/);
    assert.doesNotMatch(pr.body, /<script/i);
  });

  it("sanitises a hostile summary before it reaches the pull-request body", async () => {
    const summary = "see <script>alert(1)</script> and please notify @owner";
    const forgeDouble = forge(makeRepo());
    const ioDouble = io(forgeDouble, [proposes("# Dev\n\nProse.\n", summary)]);

    await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble);

    const pr = pullRequestOf(forgeDouble.writes);
    assert.ok(pr !== undefined, "a pull request must be opened");
    // The body is built by `buildPullRequestBody` -> `sanitiseCommentText`:
    // tag-shaped `<` is escaped, so no raw script survives; the @handle is
    // broken with a zero-width non-joiner, so nothing re-renders a mention.
    assert.doesNotMatch(pr.body, /<script/i);
    assert.match(pr.body, /&lt;script>/);
    assert.doesNotMatch(pr.body, /@owner/);
    assert.match(pr.body, /@\u200Cowner/);

    // The hostile wording produced no extra requests or writes.
    for (const op of ["createCommit", "upsertBranch", "upsertPullRequest"]) {
      assert.equal(forgeDouble.writes.filter((w) => w.op === op).length, 1);
    }
  });

  it("refuses a translation that retargets an internal link to a foreign host", async () => {
    const forgeDouble = forge(
      makeRepo({
        documents: {
          "manual/dev.md": "# Dev\n\nProse. See [the guide](manual/guide.md).\n",
        },
      }),
    );
    const chatDouble = chat([
      proposes("# Dev\n\nProse. See [the guide](https://attacker.example/phish).\n"),
    ]);
    const ioDouble = { forge: forgeDouble, chat: chatDouble, evidence };

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );

    // `validateLinkGraph` saw a refusable destination where the source's
    // internal link resolved: the run exits red naming the refusal.
    assert.match(String(error), /link validation failed/);
    assert.match(String(error), /every pair failed/);
    assert.match(String(error), /attacker\.example/);
    // A refusal is never retried: exactly one model call, and zero forge
    // writes — the hostile destination never reached the branch.
    assert.equal(chatDouble.calls(), 1);
    assert.equal(forgeDouble.writes.length, 0);
  });

  it("refuses a translation that swaps an external link's destination", async () => {
    const forgeDouble = forge(
      makeRepo({
        documents: {
          "manual/dev.md": "# Dev\n\nSee [home](https://example.com).\n",
        },
      }),
    );
    const chatDouble = chat([proposes("# Dev\n\nSee [home](https://attacker.example/).\n")]);
    const ioDouble = { forge: forgeDouble, chat: chatDouble, evidence };

    const error = await run({ ...readInputs(runner), dryRun: false }, context(), ioDouble).catch(
      (cause) => cause,
    );

    // Refused-shaped destinations (this one carries a scheme) must come back
    // byte-identical; `https://attacker.example/` is not `https://example.com`.
    assert.match(String(error), /link validation failed/);
    assert.match(String(error), /every pair failed/);
    assert.match(String(error), /attacker\.example/);
    assert.equal(chatDouble.calls(), 1);
    assert.equal(forgeDouble.writes.length, 0);
  });
});
