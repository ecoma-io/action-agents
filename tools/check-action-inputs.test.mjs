// Tests for check-action-inputs.mjs.
//
// `evaluate` takes every fact it needs as an argument — the actions and the
// shared reader's source — so these run with no repository and no filesystem.
// What is deliberately NOT tested is `readActions` and `main`: they exist to
// read real paths, and a test that stubbed them would only pin the stub.
//
// The first two cases are the ones this gate exists for, one per direction, and
// the third is the regression that nearly shipped inside the gate itself.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluate,
  optionsSemantics,
  parseDeclared,
  parseManifest,
  readNames,
} from "./check-action-inputs.mjs";

/** The real shared reader, reduced to what the scan looks at. */
const SHARED = {
  path: "core/src/inputs.mjs",
  text: `
    const apiUrl = normaliseUrl(getInput("api-url", { required: true }, env));
    return {
      githubToken: getInput("github-token", { required: true }, env),
      apiUrl,
      apiKey: getInput("api-key", {}, env),
      model: getInput("model", { required: true }, env),
    };
  `,
};

/** Every shared input, declared, so a case can add only what it is about. */
const SHARED_DECLARED = ["github-token", "api-url", "api-key", "model"];

/**
 * @param {object} spec
 * @param {string} [spec.name]
 * @param {string[]} spec.declared appended to the four shared names
 * @param {string} spec.source
 * @param {boolean} [spec.shared] whether the source calls readSharedInputs
 */
const action = ({ name = "review", declared, source, shared = true }) => ({
  name,
  manifestPath: `${name}/action.yaml`,
  declared: [...SHARED_DECLARED, ...declared],
  sources: [
    {
      path: `${name}/src/index.mjs`,
      text: shared ? `import { readSharedInputs } from "#core/inputs.mjs";\n${source}` : source,
    },
  ],
});

test("an input the code reads and the manifest does not declare is a failure", () => {
  // Exactly the shape of the defect: review/src/index.mjs read `dry-run` while
  // review/action.yaml offered no such input, and lint, typecheck, arch and
  // test were all green over it.
  const result = evaluate({
    actions: [
      action({
        declared: ["max-turns"],
        source: `
          maxTurns: getNumberInput("max-turns", { default: 30 }, env),
          dryRun: getBooleanInput("dry-run", { default: false }, env),
        `,
      }),
    ],
    sharedInputs: SHARED,
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /reads 'dry-run', which review\/action\.yaml does not declare/);
});

test("an input the manifest declares and no code reads is a failure too", () => {
  const result = evaluate({
    actions: [
      action({
        declared: ["max-turns", "context-window"],
        source: `maxTurns: getNumberInput("max-turns", { default: 30 }, env),`,
      }),
    ],
    sharedInputs: SHARED,
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /declares 'context-window', which no code reads/);
});

test("a call split across lines is a literal, not a name the gate cannot see", () => {
  // The regression: written as `\\(\\s*(?!["'])` the engine backtracks the
  // whitespace to zero and asserts against the newline, so every call Prettier
  // wrapped is reported as dynamic. Prettier wraps these constantly.
  const result = evaluate({
    actions: [
      action({
        declared: ["instructions-path"],
        source: `
          instructionsPath: getInput(
            "instructions-path",
            { default: ".github/review-instructions.md" },
            env,
          ),
        `,
      }),
    ],
    sharedInputs: SHARED,
  });

  assert.deepEqual(result.failures, []);
});

test("an input read under a name the scan cannot see is reported with its line", () => {
  const result = evaluate({
    actions: [
      action({
        declared: [],
        source: `const one = "x";\nconst two = getInput(name, {}, env);`,
      }),
    ],
    sharedInputs: SHARED,
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /review\/src\/index\.mjs:3: an input is read with a name/);
});

test("an action calling the shared reader is credited with the shared inputs", () => {
  const result = evaluate({
    actions: [action({ declared: [], source: `const inputs = readSharedInputs(env);` })],
    sharedInputs: SHARED,
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.inputs, 4);
});

test("an action NOT calling the shared reader is credited with nothing from it", () => {
  // Pins the one coupling this gate makes across a directory boundary. Without
  // it the rule would credit every action with core's inputs whether it read
  // them or not, and a manifest could declare four inputs nothing reads.
  const result = evaluate({
    actions: [
      action({
        declared: ["labels"],
        shared: false,
        source: `labels: getListInput("labels", {}, env),`,
      }),
    ],
    sharedInputs: SHARED,
  });

  assert.equal(result.failures.length, SHARED_DECLARED.length);
  for (const failure of result.failures) assert.match(failure, /which no code reads/);
});

test("finding no action at all is a failure, not a pass", () => {
  const result = evaluate({ actions: [], sharedInputs: SHARED });

  assert.equal(result.actions, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /no action directory was found/);
});

test("an action that reads no input at all is a failure", () => {
  const result = evaluate({
    actions: [action({ declared: [], shared: false, source: `export const ACTION = "review";` })],
    sharedInputs: SHARED,
  });

  assert.match(result.failures[0], /reads no input at all/);
});

test("a shared reader that reads nothing is a failure", () => {
  const result = evaluate({
    actions: [action({ declared: [], source: `const inputs = readSharedInputs(env);` })],
    sharedInputs: { path: "core/src/inputs.mjs", text: "export function readSharedInputs() {}" },
  });

  assert.match(result.failures[0], /no input read found/);
});

test("parseDeclared reads the inputs block and stops at the next top-level key", () => {
  const manifest = [
    "name: Review",
    "description: Review a pull request.",
    "",
    "branding:",
    "  icon: search",
    "  color: purple",
    "",
    "inputs:",
    "  github-token:",
    "    description: Token the action writes with.",
    "    required: true",
    "",
    "  max-turns:",
    "    description: Ceiling on agent turns.",
    "    required: false",
    '    default: "30"',
    "",
    "runs:",
    "  using: node24",
    "  main: src/index.mjs",
    "",
  ].join("\n");

  // `icon` and `color` precede the block; `using` and `main` follow it, and are
  // indented exactly like an input key. Neither may be read as one.
  assert.deepEqual(parseDeclared(manifest), ["github-token", "max-turns"]);
});

test("readNames takes both quote styles and ignores everything else", () => {
  const text = `getInput("a"), getBooleanInput('b'), getNumberInput("c"), getListInput("d"), getThing("e")`;

  assert.deepEqual(readNames(text), ["a", "b", "c", "d"]);
});

/**
 * An action with a manifest, so the required/default comparison has facts on
 * both sides. Fields default to the same values parseManifest produces for a
 * manifest that says nothing: required=false, default="".
 *
 * @param {object} spec
 * @param {string} [spec.name]
 * @param {string[]} [spec.declared]
 * @param {Array<{ name: string, required?: boolean, default?: string }>} spec.manifest
 * @param {string} spec.source
 * @param {boolean} [spec.shared]
 */
const actionWithManifest = ({ name = "review", declared, manifest, source, shared = true }) => {
  const base = action({ name, declared, source, shared });
  return {
    ...base,
    manifest: manifest.map((entry) => ({
      name: entry.name,
      required: entry.required ?? false,
      default: entry.default ?? "",
    })),
  };
};
test("the code requiring an input the manifest leaves optional is a failure", () => {
  // A `getNumberInput` with no default throws on absence: that input is
  // required from the code's side even though the helper takes no required
  // flag. A manifest that does not say so sends a consumer into a crash.

  const result = evaluate({
    actions: [
      actionWithManifest({
        declared: ["max-turns"],
        manifest: [{ name: "max-turns", required: false }],
        source: `maxTurns: getNumberInput("max-turns", { min: 1 }, env),`,
      }),
    ],
    sharedInputs: SHARED,
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /'max-turns' is required by the code/);
});

test("the manifest requiring an input the code reads optionally is a failure", () => {
  const result = evaluate({
    actions: [
      actionWithManifest({
        declared: ["config-path"],
        manifest: [{ name: "config-path", required: true }],
        source: `configPath: getInput("config-path", {}, env),`,
      }),
    ],
    sharedInputs: SHARED,
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /'config-path' is marked required in review\/action\.yaml/);
});

test("a manifest default that differs from the code's default is a failure", () => {
  const result = evaluate({
    actions: [
      actionWithManifest({
        declared: ["max-turns"],
        manifest: [{ name: "max-turns", required: false, default: "60" }],
        source: `maxTurns: getNumberInput("max-turns", { default: 30 }, env),`,
      }),
    ],
    sharedInputs: SHARED,
  });

  assert.equal(result.failures.length, 1);
  assert.match(
    result.failures[0],
    /'max-turns' default differs: review\/action\.yaml declares '60' but the code applies '30'/,
  );
});

test("a manifest default the code does not apply is a failure", () => {
  // The manifest promises 30 turns when omitted; the code's bare getNumberInput
  // throws instead. A consumer who read the manifest gets a crash, not 30.
  // That is two breaches at once: the default never lands, and the input is
  // required on the code's side while the manifest leaves it optional.
  const result = evaluate({
    actions: [
      actionWithManifest({
        declared: ["max-turns"],
        manifest: [{ name: "max-turns", required: false, default: "30" }],
        source: `maxTurns: getNumberInput("max-turns", { min: 1 }, env),`,
      }),
    ],
    sharedInputs: SHARED,
  });

  assert.equal(result.failures.length, 2);
  assert.ok(
    result.failures.some((failure) =>
      /declared in review\/action\.yaml with default '30' but the code applies no default/.test(
        failure,
      ),
    ),
  );
  assert.ok(result.failures.some((failure) => /'max-turns' is required by the code/.test(failure)));
});

test("a code default the manifest does not declare is a failure", () => {
  const result = evaluate({
    actions: [
      actionWithManifest({
        declared: ["dry-run"],
        manifest: [{ name: "dry-run", required: false }],
        source: `dryRun: getBooleanInput("dry-run", { default: false }, env),`,
      }),
    ],
    sharedInputs: SHARED,
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /'dry-run' applies a default the manifest does not declare/);
});

test("an empty manifest default equals no code default", () => {
  // `config-path` with `default: ""` in the manifest and a bare getInput are
  // the same behaviour; this is what keeps the real manifests green.
  const result = evaluate({
    actions: [
      actionWithManifest({
        declared: ["config-path"],
        manifest: [{ name: "config-path", required: false, default: "" }],
        source: `configPath: getInput("config-path", {}, env),`,
      }),
    ],
    sharedInputs: SHARED,
  });

  assert.deepEqual(result.failures, []);
});

test("an options object spread across lines is one fact, not several", () => {
  const result = evaluate({
    actions: [
      actionWithManifest({
        declared: ["context-window"],
        manifest: [{ name: "context-window", required: false, default: "128000" }],
        source: [
          `contextWindow: getNumberInput(`,
          `  "context-window",`,
          `  { default: 128_000, min: 1_000 },`,
          `  env,`,
          `),`,
        ].join("\n"),
      }),
    ],
    sharedInputs: SHARED,
  });

  assert.deepEqual(result.failures, []);
});

test("parseManifest reads required and default and stops at the next top-level key", () => {
  const manifest = [
    "inputs:",
    "  github-token:",
    "    description: Token the action writes with.",
    "    required: true",
    "",
    "  max-turns:",
    "    description: Some text with a default: nobody reads this as one.",
    "    required: false",
    '    default: "30"',
    "",
    "  dry-run:",
    '    default: "true"',
    "",
    "runs:",
    "  using: node24",
    "  main: src/index.mjs",
    "",
  ].join("\n");

  assert.deepEqual(parseManifest(manifest), [
    { name: "github-token", required: true, default: "" },
    { name: "max-turns", required: false, default: "30" },
    { name: "dry-run", required: false, default: "true" },
  ]);

  // The description's prose "default:" must not leak into the fact.
  assert.deepEqual(optionsSemantics(`{ required: true }`), { required: true, default: "" });
});
