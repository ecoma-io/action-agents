import { describe, expect, it } from "vitest";
import { MAX_CONFIG_BYTES, loadConfigFile } from "./config-file.mjs";
import { PolicyResolutionError } from "./policy.mjs";

/** A full 40-hex commit sha, distinct from every other sha in this file. */
const SHA = "d".repeat(40);
/** The resolved policy source, as resolvePolicySource returns it. */
const SOURCE = /** @type {import("#core/policy.mjs").PolicySource} */ ({
  basis: "base",
  branch: "base",
  sha: SHA,
});

/**
 * A contents double: answers path lookups from a table and records every
 * path asked for, so tests can assert the lookup order and that the reader
 * is pinned to the resolved source by the caller.
 *
 * @param {Record<string, string>} files path → raw file bytes
 * @returns {import("#core/config-file.mjs").ContentsReader & { asked: string[] }}
 */
function contentsDouble(files) {
  /** @type {string[]} */
  const asked = [];
  return /** @type {any} */ ({
    asked,
    getContents: async (/** @type {string} */ path) => {
      asked.push(path);
      const content = files[path];
      return content === undefined ? null : { content };
    },
  });
}

const LOCATION_A = ".github/triage.labels.json5";
const LOCATION_B = ".github/triage.labels.json";
const LOCATIONS = [LOCATION_A, LOCATION_B];

describe("MAX_CONFIG_BYTES", () => {
  it("is the 64 KiB cap the config surfaces document", () => {
    expect(MAX_CONFIG_BYTES).toBe(64 * 2 ** 10);
  });
});

describe("loadConfigFile — explicit config-path", () => {
  it("parses the named file and returns its path", async () => {
    const forge = contentsDouble({ "policy/custom.json5": "{ labels: { sheet: [] } }" });
    const result = await loadConfigFile({
      forge,
      configPath: "policy/custom.json5",
      source: SOURCE,
      locations: LOCATIONS,
      supportedMajor: 1,
    });
    expect(result.raw).toEqual({ labels: { sheet: [] } });
    expect(result.path).toBe("policy/custom.json5");
    expect(forge.asked).toEqual(["policy/custom.json5"]);
  });

  it("refuses a named file that does not exist on the pinned source", async () => {
    const forge = contentsDouble({});
    await expect(
      loadConfigFile({
        forge,
        configPath: "policy/missing.json5",
        source: SOURCE,
        locations: LOCATIONS,
        supportedMajor: 1,
      }),
    ).rejects.toThrow(
      "config-path names 'policy/missing.json5', which does not exist on branch 'base' " +
        `at ${SHA}`,
    );
    expect(forge.asked).toEqual(["policy/missing.json5"]);
  });

  it("skips the default locations entirely when a config-path is given", async () => {
    const forge = contentsDouble({
      "policy/custom.json5": "{}",
      [LOCATION_A]: "{}",
      [LOCATION_B]: "{}",
    });
    const result = await loadConfigFile({
      forge,
      configPath: "policy/custom.json5",
      source: SOURCE,
      locations: LOCATIONS,
      supportedMajor: 1,
    });
    expect(result.path).toBe("policy/custom.json5");
    expect(forge.asked).toEqual(["policy/custom.json5"]);
  });
});

describe("loadConfigFile — default locations", () => {
  it("returns raw: null when no default location exists (the empty-policy reading)", async () => {
    const forge = contentsDouble({});
    const result = await loadConfigFile({
      forge,
      configPath: "",
      source: SOURCE,
      locations: LOCATIONS,
      supportedMajor: 1,
    });
    expect(result.raw).toBeNull();
    expect(result.path).toBe("");
    expect(forge.asked).toEqual(LOCATIONS);
  });

  it("refuses when no default location exists and the caller asked for a refusal", async () => {
    const forge = contentsDouble({});
    await expect(
      loadConfigFile({
        forge,
        configPath: "",
        source: SOURCE,
        locations: LOCATIONS,
        absent: "refuse",
        supportedMajor: 1,
      }),
    ).rejects.toThrow(`no config file exists — expected one of ${LOCATIONS.join(" or ")}`);
  });

  it("lets the caller name the refusal for an absent set", async () => {
    const forge = contentsDouble({});
    await expect(
      loadConfigFile({
        forge,
        configPath: "",
        source: SOURCE,
        locations: LOCATIONS,
        absent: "refuse",
        absentMessage: "harmonise keeps no documents in step without its map",
        supportedMajor: 1,
      }),
    ).rejects.toThrow("harmonise keeps no documents in step without its map");
  });

  it("refuses when both default locations exist — the policy is declared twice", async () => {
    const forge = contentsDouble({ [LOCATION_A]: "{}", [LOCATION_B]: "{}" });
    await expect(
      loadConfigFile({
        forge,
        configPath: "",
        source: SOURCE,
        locations: LOCATIONS,
        supportedMajor: 1,
      }),
    ).rejects.toThrow(
      `the policy is declared twice — both ${LOCATIONS[0]} and ${LOCATIONS[1]} exist; remove one`,
    );
  });

  it("prefers the first default location and never reads past a single find", async () => {
    const forge = contentsDouble({ [LOCATION_B]: "{ schemaVersion: 1 }" });
    const result = await loadConfigFile({
      forge,
      configPath: "",
      source: SOURCE,
      locations: LOCATIONS,
      supportedMajor: 1,
    });
    expect(result.raw).toEqual({ schemaVersion: 1 });
    expect(result.path).toBe(LOCATIONS[1]);
    expect(forge.asked).toEqual(LOCATIONS);
  });
});

describe("loadConfigFile — parse, cap and schema refusals", () => {
  it("refuses a file past the byte cap instead of truncating the policy", async () => {
    const content = `// ${"x".repeat(MAX_CONFIG_BYTES)}\n{}`;
    const forge = contentsDouble({ [LOCATION_A]: content });
    await expect(
      loadConfigFile({
        forge,
        configPath: "",
        source: SOURCE,
        locations: LOCATIONS,
        supportedMajor: 1,
      }),
    ).rejects.toThrow(
      `'${LOCATIONS[0]}' is ${String(content.length)} bytes, past the ${String(MAX_CONFIG_BYTES)}-byte cap`,
    );
  });

  it("accepts a file exactly at the byte cap", async () => {
    // Compose a document whose UTF-8 byte length is exactly MAX_CONFIG_BYTES:
    // JSON5 whitespace padding inside an object, so the parse still succeeds.
    const head = "{";
    const tail = "}";
    const pad = " ".repeat(MAX_CONFIG_BYTES - head.length - tail.length);
    const content = head + pad + tail;
    const forge = contentsDouble({ [LOCATION_A]: content });
    const result = await loadConfigFile({
      forge,
      configPath: "",
      source: SOURCE,
      locations: LOCATIONS,
      supportedMajor: 1,
    });
    expect(result.raw).toEqual({});
  });

  it("refuses a file that does not parse, naming the location and keeping the cause", async () => {
    const forge = contentsDouble({ [LOCATION_A]: "{ labels: [" });
    await expect(
      loadConfigFile({
        forge,
        configPath: "",
        source: SOURCE,
        locations: LOCATIONS,
        supportedMajor: 1,
      }),
    ).rejects.toThrow(`'${LOCATIONS[0]}' does not parse:`);
  });

  it("refuses a file that parses to a non-object", async () => {
    for (const content of ["[1, 2]", '"a string"', "42", "null"]) {
      const forge = contentsDouble({ [LOCATION_A]: content });
      await expect(
        loadConfigFile({
          forge,
          configPath: "",
          source: SOURCE,
          locations: LOCATIONS,
          supportedMajor: 1,
        }),
      ).rejects.toThrow(`'${LOCATIONS[0]}' must hold an object`);
    }
  });

  it("refuses a schema major the action does not understand, naming the pinned source", async () => {
    const forge = contentsDouble({ [LOCATION_A]: "{ schemaVersion: 99 }" });
    await expect(
      loadConfigFile({
        forge,
        configPath: "",
        source: SOURCE,
        locations: LOCATIONS,
        supportedMajor: 1,
      }),
    ).rejects.toThrow(PolicyResolutionError);
    await expect(
      loadConfigFile({
        forge,
        configPath: "",
        source: SOURCE,
        locations: LOCATIONS,
        supportedMajor: 1,
      }),
    ).rejects.toThrow(`declares schemaVersion 99, but this action understands schema major 1 only`);
  });

  it("accepts a schema major inside the migration window", async () => {
    const forge = contentsDouble({ [LOCATION_A]: "{ schemaVersion: 2 }" });
    const result = await loadConfigFile({
      forge,
      configPath: "",
      source: SOURCE,
      locations: LOCATIONS,
      supportedMajor: [1, 2],
    });
    expect(result.raw).toEqual({ schemaVersion: 2 });
  });

  it("treats an absent schemaVersion as the current major", async () => {
    const forge = contentsDouble({ [LOCATION_A]: "{}" });
    const result = await loadConfigFile({
      forge,
      configPath: "",
      source: SOURCE,
      locations: LOCATIONS,
      supportedMajor: 1,
    });
    expect(result.raw).toEqual({});
  });
});
