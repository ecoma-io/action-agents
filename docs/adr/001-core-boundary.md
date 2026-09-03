---
id: 001-core-boundary
status: accepted
created: 2026-09-03
---

# 001 — Core is protocol and ceiling, and archkeep judges the tree against the law

## Context

The boundary law has two halves that answer different questions, and keeping
them straight is the whole point of this record.

[Doctrine](../doctrine.md) is the law's home. It states the direction rule
(`core/` may not import an action; no action may import another), the content
rule (`core/` holds protocol code and ceiling code, and no third kind), and the
reasoning for each. When two contributors disagree about a boundary, the
disagreement is settled there, not in a tool's output.

`@ecoma-io/archkeep@0.21.0` is the tool that judges this tree against that law.
`pnpm arch` reads two declarations the repository maintains —
`module-boundaries.config.mjs`, the boundary law as one row per rule, and
`architecture-intent.json`, the architecture's existence facts — and fails a
tree that departs from them. Until this decision, the rows enforced the two
direction edges and nothing recorded which decision gave the rows their
authority, so a row could be edited, weakened or deleted with nothing pointing
back at the law it was supposed to run.

## Decision

1. **The content rule is law, and stays a reviewer's judgement.** `core/` holds
   protocol code — something with a specification outside this repository — and
   ceiling code — a limit every action's safety rests on — and no third kind.
   Archkeep sees import graphs and tags; it cannot see what kind a module is,
   so no fitness function or custom rule is pretended over it. The doctrine's
   runnable-rules table says this row plainly: nothing runs it but a reviewer.
2. **The direction rule is stated twice, mechanically.** The `depConstraints`
   rows in `module-boundaries.config.mjs` judge it at the import site, and
   `architecture-intent.json` repeats it as forbidden dependencies judged over
   the transitive closure — no action ever reaches another, and no project
   carrying `layer:core` reaches one carrying `layer:action` — so a path
   through two imports violates exactly as a direct one does.
3. **The required projects are declared.** `core`, `triage`, `review` and
   `harmonise` must exist and carry their `layer:`/`scope:` tags. Deleting or
   retagging one fails the gate instead of quietly shrinking the architecture.
4. **Governance keys cite this record.** The boundary rows and the intent rows
   carry `decisionRef: adr:001-core-boundary`. `archkeep.json` stays a
   generated project map and carries no governance keys. There is no
   `layer-dependency` fitness row, and the intent file states no
   `layer:action → scope:transport` ban, on purpose: the depConstraints rows
   already keep `scope:transport` out of every action's allowed list — an
   action never _opens_ the transport client — and the transport-seam canary
   keeps that loud. Reachability is not the test here: an action reaches
   `core/transport` through `core` by design, and a reachability ban would
   forbid the architecture it means to describe.
5. **The authority split is stated, not implied.** Archkeep at this pinned
   version judges static facts only — project graph, import sites, declared
   policy. It cannot observe a running action, a model call, or dataflow. The
   security ceilings in `AGENTS.md` and `SECURITY.md` stay enforced by
   application code, tests and the adversarial corpus; this record claims no
   archkeep verdict over them.

## Consequences

- `pnpm arch` is the one command that proves the architecture, and CI runs it
  fail-closed. A citation that does not resolve — an ADR a row names but the
  registry cannot find — is a run without a verdict, never a pass.
- The doctrine's runnable-rules row and this record assert the same enforcement
  surface. Amending one without the other is a docs defect.
- The ADR registry reads tracked `docs/adr/` files named `NNN-slug.md` and
  throws on a file it cannot parse, so everything in that directory is a
  decision or nothing is.
