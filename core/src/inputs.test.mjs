// Tests for the inputs every action shares.
//
// The keyless case is the one to protect. Running against an endpoint with no
// key is a supported configuration, not a degraded one, and a validator that
// "helpfully" requires `api-key` would refuse a setup that works — silently
// narrowing who can use these actions.

import { describe, expect, it } from "vitest";

import { normaliseUrl, readSharedInputs } from "./inputs.mjs";

/** @type {import("./runtime.mjs").Env} */
const complete = {
  "INPUT_GITHUB-TOKEN": "ghs_x",
  "INPUT_API-URL": "https://api.example/v1",
  "INPUT_API-KEY": "sk-x",
  INPUT_MODEL: "gpt-x",
};

describe("readSharedInputs", () => {
  it("reads all five", () => {
    expect(readSharedInputs(complete)).toEqual({
      githubToken: "ghs_x",
      apiUrl: "https://api.example/v1",
      apiKey: "sk-x",
      model: "gpt-x",
      requestTimeoutMs: 120_000,
    });
  });

  it("honours a caller's request timeout", () => {
    /** @type {import("./runtime.mjs").Env} */
    const withTimeout = { ...complete, "INPUT_REQUEST-TIMEOUT-MS": "45000" };
    expect(readSharedInputs(withTimeout).requestTimeoutMs).toBe(45_000);
  });

  it("refuses a request timeout below the floor", () => {
    /** @type {import("./runtime.mjs").Env} */
    const belowFloor = { ...complete, "INPUT_REQUEST-TIMEOUT-MS": "500" };
    expect(() => readSharedInputs(belowFloor)).toThrow(/request-timeout-ms/);
  });

  it("accepts a keyless endpoint", () => {
    const { "INPUT_API-KEY": _omitted, ...keyless } = complete;
    expect(readSharedInputs(keyless).apiKey).toBe("");
  });

  it("requires the token, the endpoint and the model, each by name", () => {
    /** @type {[string, string][]} */
    const required = [
      ["INPUT_GITHUB-TOKEN", "github-token"],
      ["INPUT_API-URL", "api-url"],
      ["INPUT_MODEL", "model"],
    ];
    for (const [variable, name] of required) {
      const missing = { ...complete };
      delete missing[variable];
      expect(() => readSharedInputs(missing)).toThrow(new RegExp(`'${name}'`));
    }
  });
});

describe("normaliseUrl", () => {
  it("strips trailing slashes so a path is joined once, not twice", () => {
    expect(normaliseUrl("https://api.example/v1///")).toBe("https://api.example/v1");
  });

  it("refuses something that is not a URL at all", () => {
    expect(() => normaliseUrl("api.example/v1")).toThrow(/is not a URL/);
  });

  it("refuses a scheme that is not http or https", () => {
    expect(() => normaliseUrl("file:///etc/passwd")).toThrow(/must be http or https/);
  });
});
