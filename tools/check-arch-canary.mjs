// The check that keeps the boundary gate honest.
//
// `pnpm arch` proves the boundary law holds on the real tree. It cannot prove
// the law still BITES: the root `module-boundaries.config.mjs` header records
// how this gate once reported "no boundary violations" over a graph with zero
// edges — an unresolved import is reported `allowed`, so the gate fails open,
// silently, in the one direction nothing else would catch. This script runs
// the same `archkeep check` against `tools/fixtures/boundary-canary/`, a
// miniature workspace whose `archkeep.json` deliberately omits `tsConfig` and
// whose `canary-triage` imports across into `canary-review` — an illegal edge
// that stays resolvable precisely because its specifier is relative. The gate
// must refuse that tree on every run; refusing to accept a quiet gate is the
// whole job of this file.
//
// It runs archkeep from the fixture's own directory, so the fixture's
// `archkeep.json` is the project graph the run judges — the fixture is a
// workspace, and this is the only way to point archkeep at a workspace other
// than the repository root (the `--config` flag names a boundary LAW, not a
// project graph).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures", "boundary-canary");

const run = spawnSync("pnpm", ["exec", "archkeep", "check"], {
  cwd: fixtureDir,
  encoding: "utf8",
});

const report = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const named = ["canary-triage", "canary-review"].every((project) => report.includes(project));

if (run.error !== undefined) {
  console.error(`boundary-gate canary could not run archkeep: ${run.error.message}`);
  process.exitCode = 1;
} else if (run.status === 0) {
  console.error(
    "boundary gate is quiet: `archkeep check` PASSED tools/fixtures/boundary-canary, a tree " +
      "that carries an illegal canary-triage -> canary-review import by design. The gate has " +
      "gone fail-open — it is reporting an illegal tree as clean, which is the failure the " +
      "boundary law exists to make impossible. Fix the gate, never the canary. See " +
      "tools/fixtures/boundary-canary/module-boundaries.config.mjs and the fail-open record " +
      "in the repository's own module-boundaries.config.mjs. Archkeep said:",
  );
  console.error(report.trim());
  process.exitCode = 1;
} else if (typeof run.status !== "number" || !named) {
  console.error(
    `boundary-gate canary: archkeep exited ${String(run.status)} on the illegal fixture, but ` +
      "its report names neither canary-triage nor canary-review — a verdict this check cannot " +
      "trust, since the expected refusal must name the projects it refuses. Archkeep said:",
  );
  console.error(report.trim());
  process.exitCode = 1;
} else {
  console.log(
    "boundary-gate canary: the gate refused the illegal canary-triage -> canary-review import, " +
      "as it must. The law is loud.",
  );
}
