---
id: 007-archkeep-runtime-evidence
status: accepted
created: 2026-09-13
---

# 007 — Runtime architecture evidence: consumer-run Archkeep, a protocol reader, records never enforces

## Context

Archkeep gates this repository as a dev dependency: `pnpm arch` proves the
boundary invariants (I1, I12) in CI, and at runtime `review` stands in path
heuristics where architecture evidence belongs. The runtime-integration
design record (#518,
[the design record](../development/archkeep-integration-analysis.md))
worked out what it takes for the actions — review first — to consume
Archkeep's delta verdicts as first-class runtime evidence without blurring
the separation that keeps both tools honest: Archkeep owns deterministic
architecture truth (the law, the graph, verdicts, waivers, provenance);
the actions own probabilistic reasoning over that truth. Four prohibitions
follow from that split — no thin wrapper, no duplicated architecture
engine, the model never infers structural facts Archkeep determines
deterministically, and no agent-generated conclusion masquerades as
architecture authority. The design went through an adversarial panel
before landing; this record freezes its three load-bearing decisions
before any code exists to embody them — P0 of the plan: docs name every
new word before code spells it (#529).

## Decision

1. **Consumer-run Archkeep.** The consumer's workflow runs pinned archkeep
   steps before the action and leaves the report and manifest files in the
   workspace; the action never spawns, installs or imports Archkeep. The
   zero-runtime-dependency law is untouched — this is deterministic
   evidence arriving as bytes, not an intelligence layer, so
   [ADR 002](002-no-intelligence-layer.md) is untouched too — and no new
   retry surface enters the run contract: the evidence steps are workflow
   steps, and an outage rerun repays only the model loop.
2. **A protocol-and-ceiling reader in `core`, nothing more.** One module
   is the only place Archkeep's frozen envelope contract is spoken — the
   way `config-file.mjs` and `answer-json.mjs` already speak foreign
   formats — and it enforces a ceiling: incompleteness can never read as
   pass, I10/I11 made mechanical for one input class. It holds no domain
   logic — mapping waiver states to severity, classifying rule rows by
   criticality, shaping prompt content are review's domain, and the moment
   the reader does any of them it is domain logic wearing core's tag. It
   duplicates no engine and is a constructor-injected seam so the corpus
   evaluator can double it. It lands with review as consumer #1; whether
   it is ever promoted on doctrinal grounds is decided on dogfood
   evidence, per ADR 002's own standard.
3. **Records, never enforces.** Architecture violations do not become
   review findings, do not enter SARIF, and do not flip review's verdict
   semantics — making review a second enforcement surface would
   double-judge the same law with two vocabularies. The artifact records
   the verdict and its basis; the consumer's own gate enforces, exactly as
   [ADR 006](006-code-scanning-merge-enforcement.md) settled for review's
   own findings: the action records, GitHub disposes. The `architecture`
   gate is evidence-established — verdict ∈ {pass, fail} ∧ head pinned ∧
   not stale — never `verdict === pass`, so an architecture-aware review
   can never publish `pass` over unestablished facts
   ([the run contract](../run-contract.md)).

## Consequences

- The run contract's #529 amendment carries the vocabulary this decision
  needs: the five recipe laws as normative text over the consumer's
  workflow, the architecture family and gate, the gate predicate, the
  reason taxonomy (`stale` / `incomplete` / `absent-though-configured`,
  architecture-blind the byte-identical fourth state), the F-02 extension,
  and the cross-run waiver-time sentence.
- [ADR 003](003-evidence-retention.md) gains the architecture-section
  retention row: persist the decision basis, fingerprint the detail lists,
  never raw model text — there is none.
- Architecture-blind consumers are unaffected: no input is read, no
  artifact byte moves, no model prompt changes.
- The design record's eleven architecture states stay distinct in records
  and comment — none silently merged into pass/fail; the action records,
  the consumer's gate enforces.
- The architecture family's schemaVersion stamps are frozen at 7 bare, 8
  with an applicability fact (#533); architecture-blind runs keep today's
  5 and 6 byte-identically. Grounds: the lockstep law of
  `review/src/artifact.mjs` — the bare and applicability constants stamp
  the same artifact in two conditions, one numbering space, so no number
  may mean two shapes — with the design record corrected to the same
  numbers.

## Landing

This record is the contracts-first phase (P0) of the #518 plan: it lands
with the run-contract amendment and the ADR 003 retention row, ahead of
any code — the reader module, the input wiring and the artifact family are
P1 and P3, each with its own issue and pull request.
