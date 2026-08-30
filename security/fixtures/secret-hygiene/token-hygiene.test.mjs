// Secret hygiene — the two credentials a run holds, and the one channel each
// may travel.
//
// Attack: every surface a run touches is treated as a possible leak — the
// console, and each fetched request's URL, headers and body. The GitHub write
// token and the provider API key must appear nowhere but their sanctioned
// `Authorization: Bearer …` header, on the exact origin each authenticates:
// never in a URL, never in a request body, never in any other header, never
// on the other origin, and never in anything printed after the runner has
// been told to mask them.
//   -> capability must remain bounded: `main` registers both secrets with
//      the runner (`maskSecret`, one `::add-mask::` line each, before
//      anything else can print) and the transport constructors set
//      `Authorization` for one credential on one origin — keyless means no
//      header at all, never a blank one.
//
// The whole real pipeline is driven: the real `main` and `run` from
// `triage/src/index.mjs`, the real `createForge` and `createChat` clients
// built inside `run`, over one recording `fetch` that scripts both the
// GitHub API and the OpenAI-compatible endpoint. The forge's http client
// reads `config.fetchImpl ?? globalThis.fetch`, so the fixture installs the
// recorder as `globalThis.fetch` for the run and restores it in `finally` —
// the real transport code is what puts each credential in its one header.
// Deterministic and offline.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { main, run } from "../../../triage/src/index.mjs";

const GITHUB_TOKEN = "ghs_0123456789abcdef0123456789abcdef";
const API_KEY = "sk-ant-0123456789abcdef0123456789abcdef";
const GITHUB_HOST = "api.github.example";
const CHAT_HOST = "api.model.example";
const SHA = "0".repeat(40);
const CONFIG_PATH = ".github/action-agents/triage/triage.json5";
const LABEL_ANSWER = '{"labels":["bug report"],"rationale":"The import fails on load — a defect."}';
const COMMENT_ANSWER =
  '{"classification":"Fails on import at startup.","rationale":"Reproduces on Node 24."}';

/** A minimal sheet the model can answer inside: universal + issues labels. */
const CONFIG_TEXT = `{
  schemaVersion: 1,
  labels: {
    universal: { "bug report": "Incorrect behaviour." },
    issues: { "needs docs": "Documentation only." },
  },
}`;

/**
 * The runner environment for one triage run: every input and context fact the
 * real `main` reads, with the API key and token values a workflow would hand
 * a real run.
 *
 * @param {Record<string, string | undefined>} [overrides]
 * @returns {Record<string, string | undefined>}
 */
function env(overrides = {}) {
  return {
    "INPUT_GITHUB-TOKEN": GITHUB_TOKEN,
    "INPUT_API-URL": `https://${CHAT_HOST}/v1`,
    "INPUT_API-KEY": API_KEY,
    INPUT_MODEL: "gpt-x",
    "INPUT_DRY-RUN": "false",
    GITHUB_REPOSITORY: "ecoma-io/action-agents",
    GITHUB_API_URL: `https://${GITHUB_HOST}`,
    GITHUB_WORKSPACE: "/work",
    GITHUB_EVENT_NAME: "issues",
    GITHUB_EVENT_PATH: "/work/event.json",
    ...overrides,
  };
}

/**
 * The `issues` event payload the run reads.
 *
 * @returns {Record<string, unknown>}
 */
function issueEvent() {
  return {
    issue: {
      number: 7,
      title: "Import fails on Node 24",
      body: "Steps to reproduce.",
      labels: [],
    },
    repository: { name: "action-agents", description: "AI GitHub Actions" },
  };
}

/**
 * Replaces the console methods a run can print through, collecting every line
 * until `restore` is called. `main` is driven inside the capture, so the
 * `::add-mask::` registrations land in `lines` exactly as a runner would see
 * them.
 *
 * @returns {{ lines: string[], restore: () => void }}
 */
function captureConsole() {
  /** @type {string[]} */
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  console.warn = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  console.error = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore() {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
}

/**
 * The scripted provider side of one run: a recording `fetch` that answers
 * every GitHub API and chat-completions call the real clients make, and logs
 * each request's url, headers and body for the leak assertions. Any request
 * outside the scripted surface is a refused surprise, never a silent pass.
 * Installed as `globalThis.fetch` for the run: `realIo` builds the forge
 * without a fetch seam, and the forge's http client captures the global.
 *
 * @param {{ withConfig: boolean, chatAnswer: string }} options
 * @returns {{
 *   requests: { url: string, method: string, headers: Record<string, string>, body: string | undefined }[],
 *   fetchImpl: typeof globalThis.fetch,
 *   io: {
 *     readEvent: () => Promise<Record<string, unknown>>,
 *     now: () => number,
 *   },
 * }}
 */
function scriptedWorld({ withConfig, chatAnswer }) {
  /** @type {{ url: string, method: string, headers: Record<string, string>, body: string | undefined }[]} */
  const requests = [];
  /**
   * @param {unknown} payload
   * @param {number} [status]
   */
  const json = (payload, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl = /** @type {typeof globalThis.fetch} */ (
    async (url, init = {}) => {
      const target = new URL(String(url));
      /** @type {Record<string, string>} */
      const headers = {};
      for (const [name, value] of Object.entries(init.headers ?? {})) {
        headers[name.toLowerCase()] = String(value);
      }
      requests.push({
        url: String(url),
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : String(init.body),
      });

      const path = decodeURIComponent(target.pathname);
      if (target.host === CHAT_HOST) {
        if (path.endsWith("/chat/completions")) {
          return json({
            choices: [
              { message: { role: "assistant", content: chatAnswer }, finish_reason: "stop" },
            ],
          });
        }
      }
      if (target.host === GITHUB_HOST) {
        if (path === "/repos/ecoma-io/action-agents") {
          return json({ default_branch: "main", name: "action-agents", description: "" });
        }
        if (path === "/repos/ecoma-io/action-agents/git/ref/heads/main") {
          return json({ ref: "refs/heads/main", object: { type: "commit", sha: SHA, url: "" } });
        }
        if (path.startsWith("/repos/ecoma-io/action-agents/git/trees/")) {
          // The issue-form read: an empty tree means no issue forms exist.
          return json({ tree: [] });
        }
        if (path === "/search/issues") {
          // The bounded duplicate/relationship read: no open issues match.
          return json({ total_count: 0, items: [] });
        }
        if (path.startsWith("/repos/ecoma-io/action-agents/contents/")) {
          const file = path.slice("/repos/ecoma-io/action-agents/contents/".length);
          if (withConfig && file === CONFIG_PATH) {
            return json({
              type: "file",
              encoding: "base64",
              content: Buffer.from(CONFIG_TEXT, "utf8").toString("base64"),
              name: "triage.json5",
              path: CONFIG_PATH,
              sha: "a".repeat(40),
            });
          }
          return new Response("not found", { status: 404 });
        }
        if (path === "/repos/ecoma-io/action-agents/labels") {
          return json([{ name: "bug report" }, { name: "needs docs" }]);
        }
        if (path === "/repos/ecoma-io/action-agents/issues/7/labels") {
          return json([{ name: "bug report" }]);
        }
        if (path === "/repos/ecoma-io/action-agents/issues/7/comments") {
          if ((init.method ?? "GET") === "POST") return json({ id: 100 });
          return json([]);
        }
        if (path === "/user") {
          return json({ login: "github-actions[bot]" });
        }
      }
      throw new Error(`scripted world: unexpected request ${init.method ?? "GET"} ${String(url)}`);
    }
  );

  return {
    requests,
    fetchImpl,
    io: {
      readEvent: async () => issueEvent(),
      now: () => Date.parse("2026-07-01T11:00:00Z"),
    },
  };
}

/**
 * Drives the real `main` with the scripted world, capturing every console
 * line the run prints and every request it makes. `execute` is the real
 * `run`, so the whole action performs its normal work through the recording
 * fetch, installed as `globalThis.fetch` for the run and restored after —
 * both the forge and the chat clients live behind the real `realIo`.
 *
 * @param {Record<string, string | undefined>} [envOverrides]
 * @param {ReturnType<typeof scriptedWorld>} [world]
 * @returns {Promise<{
 *   result: { ok: boolean, message?: string },
 *   lines: string[],
 *   requests: ReturnType<typeof scriptedWorld>["requests"],
 *   inputs: Record<string, unknown>,
 * }>}
 */
async function runMain(
  envOverrides = {},
  world = scriptedWorld({ withConfig: true, chatAnswer: LABEL_ANSWER }),
) {
  const capture = captureConsole();
  const originalFetch = globalThis.fetch;
  /** @type {{ ok: boolean, message?: string }} */
  let result;
  /** @type {Record<string, unknown>} */
  let inputs = {};
  globalThis.fetch = world.fetchImpl;
  try {
    result = await main(env(envOverrides), async (inputs_, _context) => {
      inputs = /** @type {Record<string, unknown>} */ (inputs_);
      await run(inputs_, _context, world.io);
      return { ok: true };
    });
  } finally {
    globalThis.fetch = originalFetch;
    capture.restore();
  }
  return { result, lines: capture.lines, requests: world.requests, inputs };
}

/** The exact line `maskSecret(value)` emits — the registration a runner reads. */
const maskLine = (secret) => `::add-mask::${secret}`;

/**
 * The console ceiling: apart from the two sanctioned `::add-mask::` lines,
 * neither secret may appear in any captured output — and the two registrations
 * are the first lines, so the runner can redact everything that follows.
 *
 * @param {string[]} lines
 * @param {string} apiKey
 * @param {string} githubToken
 */
function assertConsoleCeiling(lines, apiKey, githubToken) {
  assert.deepEqual(
    lines.filter((line) => line.startsWith("::add-mask::")),
    [maskLine(apiKey), maskLine(githubToken)],
    "each secret is masked exactly once, first, in registration order",
  );
  for (const [index, line] of lines.entries()) {
    if (line === maskLine(apiKey) || line === maskLine(githubToken)) continue;
    assert.ok(!line.includes(apiKey), `console line ${index} leaks the api key`);
    assert.ok(!line.includes(githubToken), `console line ${index} leaks the github token`);
  }
}

/**
 * The wire ceiling: the api key may appear only in the `Authorization` header
 * of requests to the model origin, the github token only in the
 * `Authorization` header of requests to the forge origin. Neither may appear
 * in a URL, a body or any other header — and both origins are contacted.
 *
 * @param {{ url: string, method: string, headers: Record<string, string>, body: string | undefined }[]} requests
 * @param {string} apiKey
 * @param {string} githubToken
 */
function assertRequestCeiling(requests, apiKey, githubToken) {
  assert.ok(requests.length > 0, "the run made requests");
  for (const request of requests) {
    assert.ok(!request.url.includes(apiKey), `a request url leaks the api key: ${request.url}`);
    assert.ok(
      !request.url.includes(githubToken),
      `a request url leaks the github token: ${request.url}`,
    );
    if (request.body !== undefined) {
      assert.ok(!request.body.includes(apiKey), `a request body leaks the api key: ${request.url}`);
      assert.ok(
        !request.body.includes(githubToken),
        `a request body leaks the github token: ${request.url}`,
      );
    }
    for (const [name, value] of Object.entries(request.headers)) {
      if (value.includes(apiKey)) {
        assert.equal(
          name,
          "authorization",
          `the api key leaks through header '${name}' on ${request.url}`,
        );
        assert.equal(
          value,
          `Bearer ${apiKey}`,
          `the api key sits in the Authorization header as a plain bearer token on ${request.url}`,
        );
        assert.ok(
          request.url.includes(`https://${CHAT_HOST}/`),
          `the api key's Authorization header is on the wrong origin: ${request.url}`,
        );
      }
      if (value.includes(githubToken)) {
        assert.equal(
          name,
          "authorization",
          `the github token leaks through header '${name}' on ${request.url}`,
        );
        assert.equal(
          value,
          `Bearer ${githubToken}`,
          `the github token sits in the Authorization header as a plain bearer token on ${request.url}`,
        );
        assert.ok(
          request.url.includes(`https://${GITHUB_HOST}/`),
          `the github token's Authorization header is on the wrong origin: ${request.url}`,
        );
      }
    }
  }
  assert.ok(
    requests.some((request) => request.url.includes(`https://${CHAT_HOST}/`)),
    "the run reached the model endpoint",
  );
  assert.ok(
    requests.some((request) => request.url.includes(`https://${GITHUB_HOST}/`)),
    "the run reached the forge",
  );
}

describe("secret hygiene — a full labelled triage run (real main, real forge, real chat)", () => {
  it("applies the sheet label with each secret confined to its one Authorization header", async () => {
    const world = scriptedWorld({ withConfig: true, chatAnswer: LABEL_ANSWER });
    const { result, lines, requests, inputs } = await runMain({}, world);

    assert.equal(result.ok, true, result.message);
    assert.equal(
      inputs["apiKey"],
      API_KEY,
      "the api key read from the environment is the value being masked",
    );
    assert.equal(
      inputs["githubToken"],
      GITHUB_TOKEN,
      "the github token read from the environment is the value being masked",
    );
    assert.equal(inputs["dryRun"], false, "the run writes for real, not as a dry run");
    assert.equal(lines[0], maskLine(API_KEY), "the api key is registered for masking first");
    assert.equal(
      lines[1],
      maskLine(GITHUB_TOKEN),
      "the github token is registered for masking second — both before the run banner",
    );
    assertConsoleCeiling(lines, API_KEY, GITHUB_TOKEN);
    assertRequestCeiling(requests, API_KEY, GITHUB_TOKEN);

    const labelWrite = requests.find(
      (request) => request.method === "POST" && request.url.includes("/issues/7/labels"),
    );
    assert.ok(labelWrite, "the run applied a label");
    assert.ok(labelWrite.body?.includes("bug report"), "the label write names the on-sheet label");
    const modelCall = requests.find((request) => request.url.includes(`https://${CHAT_HOST}/`));
    assert.equal(
      modelCall?.headers["authorization"],
      `Bearer ${API_KEY}`,
      "the model call authenticates with the api key",
    );
    assert.equal(
      modelCall?.headers["authorization"]?.includes(GITHUB_TOKEN),
      false,
      "the model call never sees the github token",
    );
  });
});

describe("secret hygiene — a full comment triage run (no sheet, real main, real forge, real chat)", () => {
  it("writes the triage report comment with neither secret on the wire or in the log", async () => {
    const world = scriptedWorld({ withConfig: false, chatAnswer: COMMENT_ANSWER });
    const { result, lines, requests, inputs } = await runMain({}, world);

    assert.equal(result.ok, true, result.message);
    assert.equal(inputs["dryRun"], false, "the run writes for real, not as a dry run");
    assertConsoleCeiling(lines, API_KEY, GITHUB_TOKEN);
    assertRequestCeiling(requests, API_KEY, GITHUB_TOKEN);

    const commentWrite = requests.find(
      (request) => request.method === "POST" && request.url.includes("/issues/7/comments"),
    );
    assert.ok(commentWrite, "the run wrote the triage report comment");
    assert.ok(
      commentWrite.body?.includes("Fails on import"),
      "the comment carries the classification",
    );
    assert.ok(
      requests.some((request) => request.url.endsWith("/user")),
      "the run read the write identity behind the write",
    );
  });
});

describe("secret hygiene — the keyless path", () => {
  it("sends no Authorization header and masks nothing for an empty api key", async () => {
    const world = scriptedWorld({ withConfig: false, chatAnswer: COMMENT_ANSWER });
    const { result, lines, requests } = await runMain({ "INPUT_API-KEY": "" }, world);

    assert.equal(result.ok, true, result.message);
    const masks = lines.filter((line) => line.startsWith("::add-mask::"));
    assert.deepEqual(
      masks,
      [maskLine(GITHUB_TOKEN)],
      "an empty api key is not masked — maskSecret skips it",
    );
    assert.ok(
      !lines.some((line) => line === "::add-mask::"),
      "the empty key does not produce a blank mask registration",
    );
    for (const [index, line] of lines.entries()) {
      if (line === maskLine(GITHUB_TOKEN)) continue;
      assert.ok(!line.includes(GITHUB_TOKEN), `console line ${index} leaks the github token`);
    }

    const modelCall = requests.find((request) => request.url.includes(`https://${CHAT_HOST}/`));
    assert.ok(modelCall, "the keyless run still reached the model endpoint");
    assert.equal(
      modelCall.headers["authorization"],
      undefined,
      "an empty api key never becomes an Authorization header",
    );
    assert.ok(
      Object.values(modelCall.headers).every((value) => value !== ""),
      "the empty key does not leak in as a blank header value",
    );
    assert.ok(
      requests.some(
        (request) => request.method === "POST" && request.url.includes("/issues/7/comments"),
      ),
      "the keyless path is a supported configuration: the comment is still written",
    );
  });
});
