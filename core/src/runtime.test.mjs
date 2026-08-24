// Tests for the Actions runtime primitives.
//
// The escaping cases are the ones that matter most. A workflow command whose
// message carries a raw newline terminates early and the remainder is swallowed
// as ordinary log output — so the failure looks like a message that trailed off,
// not like an error, and nothing goes red. Those cases are pinned first.

import { describe, expect, it } from "vitest";

import {
  encodeData,
  encodeProperty,
  formatCommand,
  getBooleanInput,
  getInput,
  getListInput,
  getNumberInput,
  inputVariable,
  readContext,
} from "./runtime.mjs";

describe("workflow command encoding", () => {
  it("escapes the characters that would end a command line early", () => {
    expect(encodeData("a\nb\rc%d")).toBe("a%0Ab%0Dc%25d");
  });

  it("escapes the two extra characters that separate properties", () => {
    expect(encodeProperty("a:b,c")).toBe("a%3Ab%2Cc");
  });

  it("omits the property section entirely when there is nothing to say", () => {
    expect(formatCommand("debug", {}, "hello")).toBe("::debug::hello");
  });

  it("drops undefined and empty properties rather than emitting them", () => {
    expect(formatCommand("warning", { file: "a.mjs", line: undefined, title: "" }, "x")).toBe(
      "::warning file=a.mjs::x",
    );
  });

  it("escapes the message and the properties by their own rules", () => {
    expect(formatCommand("error", { title: "a,b" }, "one\ntwo")).toBe(
      "::error title=a%2Cb::one%0Atwo",
    );
  });
});

describe("input variable naming", () => {
  it("matches the name the runner actually sets", () => {
    expect(inputVariable("api-url")).toBe("INPUT_API-URL");
    expect(inputVariable("dry run")).toBe("INPUT_DRY_RUN");
  });
});

describe("getInput", () => {
  it("reads the value the runner set", () => {
    expect(getInput("model", {}, { INPUT_MODEL: "gpt-x" })).toBe("gpt-x");
  });

  it("trims, because a workflow's YAML block scalar carries the newline", () => {
    expect(getInput("model", {}, { INPUT_MODEL: "  gpt-x\n" })).toBe("gpt-x");
  });

  it("treats an empty value as absent, so the default still applies", () => {
    expect(getInput("model", { default: "fallback" }, { INPUT_MODEL: "   " })).toBe("fallback");
  });

  it("returns the empty string when it is neither required nor defaulted", () => {
    expect(getInput("model", {}, {})).toBe("");
  });

  it("names the input when a required one is missing", () => {
    expect(() => getInput("api-key", { required: true }, {})).toThrow(/'api-key' is required/);
  });
});

describe("getBooleanInput", () => {
  it("accepts the two values a workflow can write", () => {
    expect(getBooleanInput("dry-run", {}, { "INPUT_DRY-RUN": "true" })).toBe(true);
    expect(getBooleanInput("dry-run", {}, { "INPUT_DRY-RUN": "FALSE" })).toBe(false);
  });

  it("falls back to the default when unset", () => {
    expect(getBooleanInput("dry-run", { default: true }, {})).toBe(true);
    expect(getBooleanInput("dry-run", {}, {})).toBe(false);
  });

  it("refuses anything else rather than guessing", () => {
    // `yes` and `1` are the two a contributor reaches for, and silently reading
    // either as false is a dry run that quietly became a real write.
    expect(() => getBooleanInput("dry-run", {}, { "INPUT_DRY-RUN": "yes" })).toThrow(
      /must be 'true' or 'false'/,
    );
  });
});

describe("getNumberInput", () => {
  it("parses a number and honours a minimum", () => {
    expect(getNumberInput("max-turns", { min: 1 }, { "INPUT_MAX-TURNS": "12" })).toBe(12);
  });

  it("refuses a value below the minimum", () => {
    expect(() => getNumberInput("max-turns", { min: 1 }, { "INPUT_MAX-TURNS": "0" })).toThrow(
      /at least 1/,
    );
  });

  it("refuses a value that is not a number", () => {
    expect(() => getNumberInput("max-turns", {}, { "INPUT_MAX-TURNS": "lots" })).toThrow(
      /must be a number/,
    );
  });

  it("uses the default when unset, and refuses when there is none", () => {
    expect(getNumberInput("max-turns", { default: 30 }, {})).toBe(30);
    expect(() => getNumberInput("max-turns", {}, {})).toThrow(/is required/);
  });
});

describe("getListInput", () => {
  it("splits on commas and drops the whitespace a workflow leaves behind", () => {
    expect(getListInput("languages", {}, { INPUT_LANGUAGES: " vi , en ,, ja " })).toEqual([
      "vi",
      "en",
      "ja",
    ]);
  });

  it("returns the default, then the empty list, when unset", () => {
    expect(getListInput("languages", { default: ["en"] }, {})).toEqual(["en"]);
    expect(getListInput("languages", {}, {})).toEqual([]);
  });
});

describe("readContext", () => {
  const runner = {
    GITHUB_REPOSITORY: "ecoma-io/action-agents",
    GITHUB_WORKSPACE: "/work",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: "/work/event.json",
  };

  it("splits the repository into its two halves", () => {
    expect(readContext(runner)).toMatchObject({
      owner: "ecoma-io",
      repo: "action-agents",
      workspace: "/work",
      apiUrl: "https://api.github.com",
    });
  });

  it("honours GITHUB_API_URL, which is what makes GitHub Enterprise work", () => {
    expect(readContext({ ...runner, GITHUB_API_URL: "https://ghe.example/api/v3" }).apiUrl).toBe(
      "https://ghe.example/api/v3",
    );
  });

  it("refuses a repository that is not owner/repo", () => {
    expect(() => readContext({ ...runner, GITHUB_REPOSITORY: "action-agents" })).toThrow(
      /not 'owner\/repo'/,
    );
  });

  it("names the variable when the run is not inside Actions at all", () => {
    expect(() => readContext({})).toThrow(/GITHUB_REPOSITORY is not set/);
  });
});
