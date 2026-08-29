import { defineConfig } from "vitest/config";

/**
 * One suite for the whole repository. There is no build, so there is nothing to
 * point a test at except the source the runner itself executes.
 *
 * `coverage.all` is on deliberately. Without it a file with no test file beside
 * it is simply absent from the report, so the percentage describes the code
 * somebody remembered to test rather than the code that ships — and it goes UP
 * when an untested module is added. With it, a new uncovered file pushes the
 * number down, which is the only direction that makes a threshold mean
 * anything.
 *
 * The thresholds are a floor, not a target. They are enforced from the first
 * commit rather than retrofitted, because a threshold added later is set to
 * whatever the number already happens to be.
 */
const PROJECT_SOURCES = [
  "core/src/**/*.mjs",
  "core/transport/**/*.mjs",
  "triage/src/**/*.mjs",
  "review/src/**/*.mjs",
  "harmonise/src/**/*.mjs",
];

export default defineConfig({
  test: {
    include: PROJECT_SOURCES.map((glob) => glob.replace("*.mjs", "*.test.mjs")),
    // A glob that stops matching anything is a suite nobody ran. Without this,
    // vitest reports green for zero tests.
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: PROJECT_SOURCES,
      exclude: ["**/*.test.mjs", "**/*.integration.test.mjs"],
      all: true,
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
