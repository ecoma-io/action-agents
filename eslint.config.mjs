// Flat ESLint config. Prettier owns formatting — `eslint-config-prettier` is
// last so it switches off every stylistic rule the two would otherwise fight
// over, leaving ESLint to judge correctness only.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      // Agent worktrees. Each is a full checkout with its own node_modules, and
      // flat config does not read .gitignore — so without this line `pnpm lint`
      // walks several gigabytes of other checkouts and never returns. Measured:
      // ten worktrees at ~228 MB each.
      ".claude/worktrees/**",
    ],
  },

  js.configs.recommended,

  // TypeScript, linted with type information. `projectService` hands the parser
  // the same program `tsc` builds, which is what makes the rules below possible
  // at all: a floating promise or an unawaited thenable is invisible to a
  // parser that only sees syntax. This action is almost entirely async I/O
  // against a model provider and the GitHub API, so that is the class of bug it
  // is most exposed to.
  {
    files: ["**/*.ts", "**/*.mts", "**/*.cts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // `verbatimModuleSyntax` erases nothing it was not told to erase, so a
      // type imported without the `type` keyword becomes a real runtime import.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // Every value crossing into this process is untrusted or unvalidated: an
      // action input, a provider's JSON, a thread body. Parsing it into a real
      // type is this codebase's central job, so the rules that report an
      // unchecked `any` flowing onward are the ones worth keeping loudest.
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
    },
  },

  // Plain ESM JavaScript — this config and the build script. No tsconfig covers
  // them, so the type-aware rules have no program to consult and are switched
  // off explicitly rather than left to fail at parse time.
  {
    files: ["**/*.mjs", "**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },

  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      // Everything here runs on Node, on the Actions runner. There is no
      // browser context anywhere in this repository.
      globals: { ...globals.node, ...globals.es2024 },
    },
    rules: {
      // An action communicates through `@actions/core`, which writes the
      // workflow commands that produce log grouping, annotations and secret
      // masking. A bare `console.log` bypasses all three — including the
      // masking, which is the one that matters when an api key is in scope.
      "no-console": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "error",
    },
  },

  // Tests. These rules catch the two ways a suite reports green for something
  // nobody ran — a focused test that silences its siblings, and a skipped one
  // that silences itself — plus assertions that can never fail.
  {
    files: ["src/**/*.test.ts", "src/**/*.integration.test.ts"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
      "vitest/expect-expect": "error",
      "vitest/valid-expect": "error",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },

  // The build script is invoked from a terminal, where what it writes to stdout
  // is its entire output.
  {
    files: ["tools/**/*.mjs", "security/**/*.mjs", "*.config.{ts,mts,mjs}", "eslint.config.mjs"],
    rules: { "no-console": "off" },
  },

  // Repository gate scripts (the editor-time format/lint/docs-link hooks and
  // the docs-link gate itself). They are invoked from a terminal, where
  // `console.log`/`console.error` on stdout/stderr is the interface the hooks
  // and CI read back — the same terminal-is-the-UI argument as `tools/**`.
  {
    files: ["scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },

  prettier,
);
