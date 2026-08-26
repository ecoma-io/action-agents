// Tests for the `harmonise` entry point.
//
// Three properties are pinned here that no later change may quietly drop:
//
//   1. **Refusals stay refusals.** A real-run request this build cannot honor,
//      an empty document set, a filter that narrows to nothing, every pair
//      failing or skipping — each goes red rather than green-on-nothing.
//   2. **The key is masked before anything can print it.**
//   3. **The report is honest about what it saw** — proposals, unchanged
//      documents, skipped and failed pairs and orphans each get their line,
//      and a malformed model answer costs exactly one retry before the pair
//      is recorded as failed.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTION, main, readInputs, run } from "./index.mjs";

/**
 * @type {import("#core/runtime.mjs").Env}
 */
const runner = {
  "INPUT_GITHUB-TOKEN": "ghs_x",
  "INPUT_API-URL": "https://api.example/v1",
  "INPUT_API-KEY": "sk-secret",
  INPUT_MODEL: "gpt-x",
  GITHUB_REPOSITORY: "ecoma-io/action-agents",
  GITHUB_WORKSPACE: "/work",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_EVENT_PATH: "/work/event.json",
  "INPUT_SOURCE-LANGUAGE": "en",
};

const CONFIG = `{
  sourceLanguage: "en",
  languages: { en: "manual/{document}.md", vi: "manual/vi/{document}.md" },
}`;

/** Files a happy-path inventory needs. @returns {Record<string, string>} */
function files() {
  return {
    ".github/action-agents/harmonise/harmonise.json5": CONFIG,
    "manual/dev.md": "# Dev\n\nProse.\n",
  };
}

/**
 * A forge double carrying only the reads this build makes; the write surface
 * lands with the Git integration and stays unexercised here.
 *
 * @param {Record<string, string>} files
 * @param {{ path: string, type: string }[]} [tree]
 * @returns {import("#core/forge.mjs").Forge}
 */
function forge(
  files,
  tree = [
    { path: "manual/dev.md", type: "blob" },
    { path: "manual/vi/dev.md", type: "blob" },
  ],
) {
  return /** @type {import("#core/forge.mjs").Forge} */ (
    /** @type {any} */ ({
      /** @param {string} path */
      async getContents(path) {
        const content = files[path];
        return content === undefined ? null : { content };
      },
      async getRepository() {
        return { defaultBranch: "main", name: "action-agents", description: "AI GitHub Actions" };
      },
      async getRef() {
        return { sha: "a".repeat(40) };
      },
      /** @param {string} _sha */
      async listTree(_sha) {
        return tree;
      },
    })
  );
}

/**
 * A chat double answering from a script of model contents (one per request;
 * the last answer repeats, which is what a retry loop meets).
 *
 * @param {(string | Error)[]} answers
 * @returns {{ calls: () => number, complete: import("#core/chat.mjs").Chat["complete"] }}
 */
function chat(answers) {
  let cursor = 0;
  let calls = 0;
  return {
    calls: () => calls,
    /** @param {{ model: string, messages: import("#core/chat.mjs").ChatMessage[] }} _request */
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
 * A chat that translates honestly by echoing the prepared document back:
 * restoration then reproduces the source byte-for-byte, which every
 * structural comparison accepts.
 * @returns {import("#core/chat.mjs").Chat}
 */
function echoingChat() {
  return /** @type {any} */ ({
    /** @param {{ messages: { role: string, content: string }[] }} request */
    async complete(request) {
      const user = request.messages[request.messages.length - 1]?.content ?? "";
      const source = /\[source-document\]\n([\s\S]*)$/.exec(user)?.[1] ?? "";
      return {
        content: JSON.stringify({ drift: true, summary: "kept in step", content: source }),
      };
    },
  });
}

/** @param {string} content @returns {string} a JSON answer proposing a translation */
function proposes(content) {
  return JSON.stringify({ drift: true, summary: "kept in step", content });
}

const evidence = {
  /** @param {string} label @param {string} content */
  wrap(label, content) {
    return `[${label}]\n${content}`;
  },
};

/**
 * An Io whose forge is given and whose chat echoes by default; explicit
 * answers replace the echo.
 *
 * @param {ReturnType<typeof forge>} forgeDouble
 * @param {(string | Error)[]} [answers]
 */
function io(forgeDouble, answers = []) {
  const chatDouble =
    answers.length > 0
      ? chat(answers)
      : /** @type {any} */ ({ calls: () => 0, ...{}, ...echoingChat() });
  return /** @type {any} */ ({ forge: forgeDouble, chat: chatDouble, evidence });
}

/** @returns {ReturnType<typeof import("#core/runtime.mjs").readContext>} */
function context() {
  return {
    owner: "ecoma-io",
    repo: "action-agents",
    eventName: "workflow_dispatch",
    eventPath: "/work/event.json",
    workspace: "/work",
    apiUrl: "https://api.github.com",
  };
}

/** @param {import("vitest").MockInstance} log @returns {string} */
function logged(log) {
  return log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

afterEach(() => {
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

  it("requires the source of truth, because every other version is judged against it", () => {
    const missing = { ...runner };
    delete missing["INPUT_SOURCE-LANGUAGE"];
    expect(() => readInputs(missing)).toThrow(/'source-language'/);
  });

  it("reads a configured config-path, empty for the default locations", () => {
    expect(readInputs(runner).configPath).toBe("");
    expect(readInputs({ ...runner, "INPUT_CONFIG-PATH": "p/harmonise.json5" }).configPath).toBe(
      "p/harmonise.json5",
    );
  });

  it("defaults the documents filter to empty — the map defines the space", () => {
    expect(readInputs(runner).documents).toEqual([]);
    expect(
      readInputs({ ...runner, INPUT_DOCUMENTS: "manual/a.md, manual/b.md" }).documents,
    ).toEqual(["manual/a.md", "manual/b.md"]);
  });

  it("defaults to a dry run, because this action edits files rather than comments", () => {
    expect(readInputs(runner).dryRun).toBe(true);
  });
});

describe("run", () => {
  it("refuses a real run outright — opening pull requests is not this build's job yet", async () => {
    const inputs = { ...readInputs(runner), dryRun: false };
    await expect(run(inputs, context(), /** @type {any} */ ({}))).rejects.toThrow(
      /cannot open pull requests yet/,
    );
  });

  it("reports translated proposals, missing translations and orphans on a dry run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const config = `{
      sourceLanguage: "en",
      languages: { en: "manual/{document}.md", vi: "manual/vi/{document}.md" },
      glossary: ["repository"],
    }`;
    const ioDouble = io(
      forge(
        {
          ".github/action-agents/harmonise/harmonise.json5": config,
          "manual/dev.md": "# Dev\n\nThe repository holds guides.\n\n![diagram](images/dev.png)\n",
        },
        [
          { path: "manual/dev.md", type: "blob" },
          { path: "manual/vi/dev.md", type: "blob" },
          { path: "manual/images/dev.vi.png", type: "blob" },
          { path: "manual/vi/legacy.md", type: "blob" },
        ],
      ),
    );

    await expect(run(readInputs(runner), context(), ioDouble)).resolves.toBeUndefined();

    const out = logged(log);
    expect(out).toMatch(
      /translated vi manual\/dev\.md → manual\/vi\/dev\.md \[existing\] proposed/,
    );
    expect(out).toMatch(/glossary=1/);
    expect(out).toMatch(/links=1/); // the localized image exists
    expect(out).toMatch(/orphans: 1 \(reported, never touched\)/);
    expect(out).toMatch(/orphan manual\/vi\/legacy\.md \[vi\]/);
  });

  it("records an unchanged pair when the answer is byte-identical to the translation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const current = "# Dev\n\nDéjà traduit.\n";
    const ioDouble = io(
      forge(
        {
          ".github/action-agents/harmonise/harmonise.json5": CONFIG,
          "manual/dev.md": "# Dev\n\nProse.\n",
          "manual/vi/dev.md": current,
        },
        [
          { path: "manual/dev.md", type: "blob" },
          { path: "manual/vi/dev.md", type: "blob" },
        ],
      ),
      // drift=false carrying exactly the existing translation: a clean no-op.
      [JSON.stringify({ drift: false, summary: "none", content: current })],
    );

    await expect(run(readInputs(runner), context(), ioDouble)).resolves.toBeUndefined();
    expect(logged(log)).toMatch(/unchanged/);
    expect(logged(log)).not.toMatch(/proposed/);
  });

  it("reports an honest no-op even when glossary tokens are in play", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const config = `{
      sourceLanguage: "en",
      languages: { en: "manual/{document}.md", vi: "manual/vi/{document}.md" },
      glossary: ["repository"],
    }`;
    const published = "# Dev\n\nLe dépôt repository grandit.\n";
    const ioDouble = io(
      forge(
        {
          ".github/action-agents/harmonise/harmonise.json5": config,
          "manual/dev.md": "# Dev\n\nThe repository grows.\n",
          "manual/vi/dev.md": published,
        },
        [
          { path: "manual/dev.md", type: "blob" },
          { path: "manual/vi/dev.md", type: "blob" },
        ],
      ),
      // The honest answer: drift=false carrying the published bytes verbatim.
      // It holds no run tokens — and must not need any.
      [JSON.stringify({ drift: false, summary: "none", content: published })],
    );

    await expect(run(readInputs(runner), context(), ioDouble)).resolves.toBeUndefined();
    expect(logged(log)).toMatch(/unchanged/);
  });

  it("refuses a translation that deletes a code block adjacent to another", async () => {
    const source = "# Dev\n\n```js\nfirst()\n```\n```py\nsecond()\n```\n";
    const ioDouble = io(
      forge({
        ".github/action-agents/harmonise/harmonise.json5": CONFIG,
        "manual/dev.md": source,
      }),
      // Two adjacent blocks in, one out: the count walk must see both.
      [proposes("# Dev\n\n```js\nfirst()\n```\n"), proposes("# Dev\n\n```js\nfirst()\n```\n")],
    );

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/fenced code block count changed: 2 → 1/);
  });

  it("skips a pair whose existing translation is past the cap", async () => {
    const ioDouble = io(
      forge(
        {
          ".github/action-agents/harmonise/harmonise.json5": CONFIG,
          "manual/dev.md": "# Dev\n\nFine.\n",
          "manual/vi/dev.md": "x".repeat(33 * 1024),
        },
        [
          { path: "manual/dev.md", type: "blob" },
          { path: "manual/vi/dev.md", type: "blob" },
        ],
      ),
    );

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair skipped/);
    expect(error.message).toMatch(/existing translation is 33792 bytes, past the 32768-byte cap/);
  });

  it("retries once on a malformed answer, then records the pair as failed", async () => {
    const chatDouble = chat(["this is not json at all", "still not json"]);
    const ioDouble = /** @type {any} */ ({
      forge: forge(files()),
      chat: chatDouble,
      evidence,
    });

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/does not parse as JSON|holds no JSON object/);
    expect(chatDouble.calls()).toBe(2);
  });

  it("refuses an answer whose content is whitespace only", async () => {
    const ioDouble = io(forge(files()), [proposes("\n\n"), proposes("   \n ")]);

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/no content beyond whitespace/);
  });

  it("fails a pair whose answer lost a protected token, however fluent the prose", async () => {
    const config = `{
      sourceLanguage: "en",
      languages: { en: "manual/{document}.md", vi: "manual/vi/{document}.md" },
      glossary: ["repository"],
    }`;
    const ioDouble = io(
      forge({
        ".github/action-agents/harmonise/harmonise.json5": config,
        "manual/dev.md": "# Dev\n\nThe repository grows.\n",
      }),
      // No token in the answer: restoration refuses it.
      [proposes("# Dev\n\nLe dépôt grandit.\n"), proposes("# Dev\n\nLe dépôt grandit.\n")],
    );

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/lost protected content|appears 0 times/);
  });

  it("fails a pair whose answer corrupts Markdown structure", async () => {
    const ioDouble = io(
      forge({
        ".github/action-agents/harmonise/harmonise.json5": CONFIG,
        "manual/dev.md": "# Dev\n\n```js\nkeep()\n```\n",
      }),
      // The code fence vanished from the translation.
      [proposes("# Dev\n\nkeep()\n"), proposes("# Dev\n\nkeep()\n")],
    );

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/structural validation failed/);
  });

  it("resolves a planned target's links before the translation exists", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ioDouble = io(
      forge(
        {
          ".github/action-agents/harmonise/harmonise.json5": CONFIG,
          // api's vi twin does not exist yet, but this run plans to create it:
          // the internal link must already point at its future home while the
          // external one stays exactly as authored.
          "manual/dev.md": "See [the api](api.md) and [the site](https://example.com/).\n",
          "manual/api.md": "# API\n\nEndpoints.\n",
        },
        [
          { path: "manual/dev.md", type: "blob" },
          { path: "manual/vi/dev.md", type: "blob" },
          { path: "manual/api.md", type: "blob" },
        ],
      ),
    );

    await expect(run(readInputs(runner), context(), ioDouble)).resolves.toBeUndefined();

    expect(logged(log)).toMatch(/links=1/);
  });

  it("refuses when no source document matches the map", async () => {
    const ioDouble = io(
      forge({ ".github/action-agents/harmonise/harmonise.json5": CONFIG }, [
        { path: "README.md", type: "blob" },
      ]),
    );

    await expect(run(readInputs(runner), context(), ioDouble)).rejects.toThrow(
      /no document matches the source language 'en'/,
    );
  });

  it("refuses a documents filter that narrows everything away", async () => {
    const ioDouble = io(forge(files()));
    const inputs = { ...readInputs(runner), documents: ["nope/**/*.md"] };

    await expect(run(inputs, context(), ioDouble)).rejects.toThrow(
      /narrows 1 source documents to none/,
    );
  });

  it("goes red when every pair fails preparation, naming the defect", async () => {
    const ioDouble = io(
      forge({
        ".github/action-agents/harmonise/harmonise.json5": CONFIG,
        // An unclosed region is malformed: preparation must refuse it.
        "manual/dev.md": "<!-- harmonise:skip-start -->\nnever closed\n",
      }),
    );

    const error = await run(readInputs(runner), context(), ioDouble).catch((cause) => cause);
    expect(error.message).toMatch(/every pair failed/);
    expect(error.message).toMatch(/never closed/);
  });

  it("skips an oversized source with its reason while healthy pairs prepare", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ioDouble = io(
      forge(
        {
          ".github/action-agents/harmonise/harmonise.json5": CONFIG,
          "manual/dev.md": "# Dev\n\nFine.\n",
          // 33 KiB: past the deterministic cap.
          "manual/big.md": "x".repeat(33 * 1024),
        },
        [
          { path: "manual/dev.md", type: "blob" },
          { path: "manual/big.md", type: "blob" },
        ],
      ),
    );

    await expect(run(readInputs(runner), context(), ioDouble)).resolves.toBeUndefined();
    const out = logged(log);
    expect(out).toMatch(/skipped vi manual\/big\.md: 33792 bytes, past the 32768-byte cap/);
    expect(out).toMatch(/translated vi manual\/dev\.md/);
  });

  it("goes red when every pair skips — work existed and none was attempted", async () => {
    const ioDouble = io(
      forge(
        {
          ".github/action-agents/harmonise/harmonise.json5": CONFIG,
          "manual/dev.md": "",
        },
        [{ path: "manual/dev.md", type: "blob" }],
      ),
    );

    await expect(run(readInputs(runner), context(), ioDouble)).rejects.toThrow(
      /every pair skipped[\s\S]*the source document is empty/,
    );
  });

  it("carries on when one pair fails and another prepares", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const config = `{
      sourceLanguage: "en",
      languages: { en: "manual/{document}.md", vi: "manual/vi/{document}.md", fr: "manual/fr/{document}.md" },
    }`;
    // Two sources on the branch, but only one still readable: the second
    // pair's preparation fails and must not take the healthy pair down.
    const ioDouble = io(
      forge(
        {
          ".github/action-agents/harmonise/harmonise.json5": config,
          "manual/dev.md": "# Dev\n\nFine prose.\n",
        },
        [
          { path: "manual/dev.md", type: "blob" },
          { path: "manual/lost.md", type: "blob" },
        ],
      ),
    );

    await expect(run(readInputs(runner), context(), ioDouble)).resolves.toBeUndefined();
    expect(logged(log)).toMatch(/failed manual\/lost\.md: gone from the branch/);
    expect(logged(log)).toMatch(/translated vi manual\/dev\.md/);
  });

  it("refuses a source-language input the config does not declare", async () => {
    const ioDouble = io(forge(files()));
    const env = { ...runner, "INPUT_SOURCE-LANGUAGE": "de" };
    await expect(run(readInputs(env), context(), ioDouble)).rejects.toThrow(
      /'de' is not a language the config declares/,
    );
  });

  it("surfaces a truncated tree as the refusal it is", async () => {
    class TruncatedTreeError extends Error {}
    const forgeDouble = /** @type {any} */ ({
      ...forge(files()),
      /** @param {string} _sha */
      async listTree(_sha) {
        throw new TruncatedTreeError("truncated");
      },
    });
    const ioDouble = /** @type {any} */ ({ forge: forgeDouble, chat: chat([]), evidence });

    await expect(run(readInputs(runner), context(), ioDouble)).rejects.toThrow(TruncatedTreeError);
  });
});

describe("main", () => {
  it("turns a refusal into a failed step, not a green one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await main(runner, () => Promise.reject(new Error("the work refused")));

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/the work refused/);
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

  it("names itself", () => {
    expect(ACTION).toBe("harmonise");
  });
});
