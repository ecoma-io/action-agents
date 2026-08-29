// The check that keeps the transport seam closed.
//
// `pnpm arch` proves the seam rule holds on the real tree — no action may
// import the transport project. It cannot prove the rule still BITES: this
// script runs the same `archkeep check` against
// `tools/fixtures/transport-seam/`, a miniature workspace whose
// `seam-action` imports the transport client by its public subpath — the
// exact violation shape the rule exists to refuse (`#seam-transport/http.mjs`
// here, `#core-transport/http.mjs` in the real tree). Unlike the boundary
// canary, whose relative specifier archkeep judges through its
// noRelativeOrAbsoluteImportsAcrossLibraries check before the depConstraints
// table is read, this fixture's refusal must come from the depConstraints
// row itself: `scope:transport` is absent from the action's
// `onlyDependOnLibsWithTags` list, and nothing else rejects the tree.
//
// It runs archkeep from the fixture's own directory, so the fixture's
// `archkeep.json` is the project graph the run judges — the same trick
// tools/check-arch-canary.mjs uses. The proof that the row is the rejector,
// not the resolver: copy the fixture somewhere scratch, add `scope:shared`
// to `seam-transport`'s tags, run `pnpm exec archkeep check` there, and it
// passes the identical tree.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures", "transport-seam");

const run = spawnSync("pnpm", ["exec", "archkeep", "check"], {
  cwd: fixtureDir,
  encoding: "utf8",
});

const report = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const named = ["seam-action", "seam-transport"].every((project) => report.includes(project));
// A tree-mismatch load error ("root 'seam-action' has no tracked file under
// it") also names both projects — so the names alone cannot distinguish a
// verdict from a failed run. Only the depConstraints check's own verdict line
// can: the fixture's refusal must come from `onlyTagsConstraintViolation`, or
// this check has not seen the thing it exists to see.
const judged = report.includes("onlyTagsConstraintViolation");

if (run.error !== undefined) {
  console.error(
    "transport seam is open: `archkeep check` PASSED tools/fixtures/transport-seam, a tree " +
      "that carries an illegal seam-action -> seam-transport import by design. The gate has " +
      "gone fail-open — it is reporting an illegal tree as clean, which is the failure the " +
      "boundary law exists to make impossible. Fix the gate, never the canary. See " +
      "tools/fixtures/transport-seam/module-boundaries.config.mjs. Archkeep said:",
  );
  console.error(report.trim());
  process.exitCode = 1;
} else if (typeof run.status !== "number" || !named || !judged) {
  console.error(
    `transport-seam canary: archkeep exited ${String(run.status)} on the illegal fixture, but ` +
      "its report does not carry a depConstraints verdict — it must name seam-action and " +
      "seam-transport AND refuse through `onlyTagsConstraintViolation` (a tree-mismatch load " +
      "error names the projects too, and an unresolved import is reported `allowed`) — a " +
      "verdict this check cannot trust. Archkeep said:",
  );
  console.error(report.trim());
  process.exitCode = 1;
} else {
  const verdict = report.split("\n").find((line) => line.includes("seam-action → seam-transport"));
  console.log(
    "transport-seam canary: the gate refused the illegal seam-action -> seam-transport import, " +
      "as it must, through the depConstraints row itself. The seam stays closed." +
      (verdict ? `\n  ${verdict.trim()}` : ""),
  );
}
