# Archkeep integration

What the boundary gate is in this repository, and — more importantly — what it
is not. `pnpm arch` green is necessary for every change here and sufficient for
none: this page states, mechanism by mechanism, which of this repository's
invariants the pinned archkeep version actually proves, which sit on the
deterministic gates beside it, which only runtime code and its tests can
carry, and which no machine can hold at all. A reader who takes a green arch
run for "the guarantees hold" has committed the hollow-verdict shape the
[run contract](run-contract.md) forbids, and this page exists so nobody makes
that mistake by accident.

Recorded 2026-09-04 at pin `@ecoma-io/archkeep` **0.22.1**, re-measured
claim-by-claim at pin **0.25.0** on 2026-09-05 (exact, no range; first
recorded at 0.22.0, re-measured at the 0.22.1 bump — issue #280, the
release closing ten organization-filed upstream issues; unchanged at the
0.24.0 bump — issue #314 — and at this 0.25.0 bump — issue #348);
owned by the repository maintainers. Every behavioral claim below was measured
by running the pinned binary against real trees — the fixtures under
`tools/fixtures/` and purpose-built variants of them — not cited from
documentation. When the pin moves, the bump PR re-measures every claim here;
that is what the 0.21.0 → 0.22.0 bump (PR #267) did for the refusal lane.

## The three authorities

The [run contract](run-contract.md) stamps each of its seventeen invariants with
one of four authority letters. The letters group into three authorities, and
keeping the groups apart is the point of this page:

| Authority      | Letters | What it judges                            | A green run means                                                                       | Where it lives                                                                      |
| -------------- | ------- | ----------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Architectural  | A       | static facts about the source graph       | the tree is shaped as the law says                                                      | archkeep, via `pnpm arch` and its canaries                                          |
| Runtime safety | D + R   | mechanical artifact facts, then execution | the artifact obeys the structural monopolies; the code cannot do what it does not allow | repo-local gate scripts in CI, then the actions' code, tests and adversarial corpus |
| Epistemic      | E       | whether a judgment was right              | there is reason to believe the verdict                                                  | evidence records, verification, evaluation, human review                            |

The boundary line, stated once and never negotiated per change: **archkeep
owns the A rows and none of the others.** A static gate over source text
cannot witness a runtime property — no amount of import-law analysis observes
an LLM call composing a GitHub write, an untrusted string steering control
flow, or a record that lied about its own determinism. When a change proposes
moving an R or E concern into an archkeep rule (or, more often, proposes
reading a green arch run as proof of an R or E property), that is the design
error this page exists to catch.

## Who holds each invariant

The invariants are defined, with their full statements, in
[the run contract](run-contract.md); this table only maps enforcement, and
references rather than restates. Where archkeep's column says "proves", a
violating tree cannot pass `pnpm arch`; where it says "blind", archkeep has no
opinion — the property is invisible to a static import graph by nature, not by
omission.

| Invariant (short name)                                            | Authority | Enforced by                                                                                                                   | archkeep's part                        |
| ----------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| I1 — no action imports another; core imports no action            | A         | `pnpm arch` — the boundary rows in `module-boundaries.config.mjs` over the `archkeep.json` project graph, transitively closed | proves it                              |
| I2 — raw HTTP only in `core/transport`                            | D         | the HTTP-monopoly gate (a lexical scan) plus its canary fixture                                                               | blind                                  |
| I3 — GitHub writes issued by the forge alone                      | D         | the forge-monopoly gate plus the frozen op manifest in `security/forge-ops.json`, diffed in both directions                   | blind                                  |
| I4 — model output never composes an API call                      | R         | closed sheets and typed arguments by construction; the adversarial corpus                                                     | blind                                  |
| I5 — an off-sheet value is refused, never coerced                 | R         | `pnpm test`                                                                                                                   | blind                                  |
| I6 — policy SHA-pinned; payload SHAs never drive reads            | R         | `pnpm test`                                                                                                                   | blind                                  |
| I7 — file access confined to the workspace                        | R         | `pnpm test`                                                                                                                   | blind                                  |
| I8 — no runtime dependencies, no build, `node24` entry            | D         | the action-shape gate plus the release-invariants gate                                                                        | blind                                  |
| I9 — the run artifact is byte-deterministic and fail-closed       | R         | `pnpm test`                                                                                                                   | blind                                  |
| I10 — frozen verdict vocabulary; `unknown` never passes           | R         | `pnpm test`                                                                                                                   | blind                                  |
| I11 — declared gates yield recorded verdicts, in declared order   | R         | `pnpm test`                                                                                                                   | blind                                  |
| I12 — required projects exist; forbidden transitive deps absent   | A         | `pnpm arch` — `architecture-intent.json` folded into the check                                                                | proves it                              |
| I13 — the boundary canary proves why it refused                   | D         | `tools/check-arch-canary.mjs`, run at the pin                                                                                 | the canary's subject, not its enforcer |
| I14 — records keep only their declared retention class and cap    | R         | `pnpm test`, over [ADR 003](adr/003-evidence-retention.md)                                                                    | blind                                  |
| I15 — records are byte-deterministic given the run's inputs       | R         | `pnpm test`                                                                                                                   | blind                                  |
| I16 — untrusted text enters only through the framing or sanitiser | R         | `pnpm test` and the adversarial corpus                                                                                        | blind                                  |
| I17 — arriving candidates carry the target language's script      | R         | `pnpm test`                                                                                                                   | blind                                  |

The tally is the message: archkeep proves exactly two of the seventeen (I1, I12)
and is structurally incapable of the rest. That is not a gap in the tool; it
is what "static facts about the source graph" means. The other fifteen are
not weaker — they are held by authorities that can actually witness them.

## The gate contract at the pin

What a run of `archkeep check` at 0.25.0 does, measured. Three exits, and the
vocabulary mirrors the run contract's on purpose:

| Exit | Run status   | Verdict   | What it means                                                                  |
| ---- | ------------ | --------- | ------------------------------------------------------------------------------ |
| 0    | `ok`         | `pass`    | every import resolved and every edge complied                                  |
| 1    | `findings`   | `fail`    | the tree was fully judged and violates the law — red you go fix                |
| 3    | `no-verdict` | `unknown` | coverage was incomplete and the gate refuses to judge — red you go investigate |

Exits 1 and 3 both fail a build. They differ in what a human does next, and
conflating them manufactures exactly the red herrings the run contract's
`refused`-is-not-`failed` rule exists to prevent.

**Envelope field placement.** `status` and `exitCode` sit at the top level of
the JSON envelope (`schemaVersion: 2`); `decision` carries only
`{ verdict, reason }`. A consumer gating on JSON reads the run status at the
envelope level — reading it inside `decision` is the mistake this repository's
own canary made once and the reason the placement is written down.

**The refusal lane.** The run goes `no-verdict` when coverage is incomplete:
an import site the resolver could not resolve (still named, per file and
reason, in `coverage.blindSpots`), a tree where nothing was analyzed, an
intent row whose decision reference does not resolve, an unknown fitness or
custom-rule result. Each withholds the verdict instead of folding the gap
into green — the gate-level implementation of "unknown never passes", and the
behavior the 0.22.0 pin added (the fix for upstream issue #595; at 0.21.0 the
same tree passed silently, which is why the canary existed in the visibility
form it kept until this pin).

**`coverage.complete`.** True only when nothing went unanalyzed, no blind
spots remain, and something was analyzed. A green run with
`complete: false` is impossible at this pin — incompleteness refuses the
verdict rather than decorating the green.

**The declared limit.** The refusal lane covers imports the resolver can see
as literals. A dynamic specifier — `import(someVariable)` — that fails to
resolve stays exit-neutral: it is named in `coverage.blindSpots` and does not
withhold the verdict. This is an upstream narrowing decision (their own gate
would refuse their own workspace otherwise), not this repository's choice; it
is recorded here as a known limit, and the canary deliberately does not pin
that class, so an upstream widening will be re-measured, not absorbed.

**The decisionRef asymmetry.** `architecture-intent.json` wires every required
project to `adr:001-core-boundary`, and the boundary rows may cite decisions
too. The two citations are not symmetric when they fail to resolve: an
unresolved decisionRef on a `depConstraints` row is reported
(`result.unresolvedDecisionRefs`) and leaves the exit alone; the same miss on
an intent row refuses the run (exit 3). The rationale is load-bearing: the
intent is the law's citation of authority, and a law whose authority cannot be
resolved cannot authorize a judgment — where a constraint row's citation is
explanatory, and report-only is enough.

**Provenance.** The envelope carries `workspace.provenance`
(`commit`, `dirty`, `remote`). Here `remote` is null — this repository wires
no remote into the gate — and the field's presence, not its value, is the
contract: a record of a judgment carries what tree it judged.

## Waivers and suppressions: what acceptance costs

All rows measured at this pin against purpose-built fixtures. The config
surface is one exported array, `boundarySuppressions`, in the boundary law;
every row carries a non-empty `reason` (a rejection at load, not a warning —
an acceptance no one wrote down is indistinguishable from a boundary that
quietly stopped being enforced), and a row with `expiresAt` is a **waiver**
while a row without one is a **permanent suppression**.

| Row on the table                           | Run outcome                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| live waiver (`expiresAt` in future)        | exit **1** — the violation stays a violation, annotated `waivedBy` and counted in `result.waived`; `archkeep waivers` names the term |
| expired waiver                             | re-asserted as a plain violation, annotation gone                                                                                    |
| permanent suppression                      | the finding disappears from the run entirely                                                                                         |
| every rule that catches an edge suppressed | exit **0**, verdict `pass` — the edge is visible nowhere in the run, only through `archkeep waivers`                                 |
| stale row (matches no violation)           | exit **3** — refusal: "describes a workspace that does not match the tree"                                                           |

Three readings of that table, in rising order of importance.

First, **a waiver never buys a green build.** Exit stays 1 while the term
runs; the waiver's entire effect is visibility — who accepted what, until
when. This repository runs `pnpm arch` plainly in CI, so an active waiver
keeps CI red. Whoever reaches for a waiver is really requesting either a fix
or a decision, and the tool makes them say which and until when.

Second, **a permanent suppression can green a build, which makes it a law
change wearing an exemption's clothes.** Two measured facts sharpen this:
suppressing one rule's finding does not necessarily green an illegal edge —
the same edge resurfaced through the depConstraints table
(`onlyTagsConstraintViolation`) when only the relative-import rule was
suppressed — but suppressing every rule that catches an edge does exit 0, with
the edge visible only in `archkeep waivers`' "currently hiding" list. Green
except for suppressions is the one documented way green can lie by omission,
and `archkeep waivers` is the only surface that distinguishes it.

Third, **a stale row is a refusal, not a warning.** A suppression describing
an edge nobody judged means the law and the tree disagree about which exists
— exactly the state where continuing to judge would mean guessing. The gate
withholds the verdict instead. `expiresAt` itself is validated just as
strictly: a full ISO-8601 instant with an explicit offset or `Z`, because a
date-only term would mean different instants under different machines' time
zones, and a term that means two things is not a term.

This repository ships **zero rows** today. The law is short enough not to need
exceptions, and the house rule if one is ever proposed: it lands in its own PR
that names the term and the exit-code consequence — with the honesty that only
a permanent suppression changes the build outcome, so one is reviewed as the
law change it is.

## What the gate does not do

Said positively, as non-goals, so nobody asks the gate for them later:

- **No runtime witnessing.** No LLM-call inspection, no forge-call
  interception, no untrusted-text path. The R rows' machinery — closed sheets,
  sanitiser, marker comment, workspace seam ([the ceilings](development/ceilings.md))
  — lives in code and tests, where the only execution that matters can
  actually be observed.
- **No judgment of epistemics.** Whether a verdict was _right_ is the E
  authority's question — evidence records, verification, evaluation, and a
  human. archkeep says the tree has a shape, never that the shape's behavior
  is correct.
- **No optional machinery.** This workspace uses none of archkeep's fitness
  functions, custom rules, or profiles; the contract above is the built-in
  ruleset plus the folded intent. Adopting any of them would be a design
  decision recorded in its own PR, not a convenience.
- **Coverage exemptions are named, and there are two.** `archkeep.json`'s
  `coverage.exempt` lists exactly the boundary law and the lint config — the
  two files no project owns. A third entry is a reviewed decision for the same
  reason a suppression is.

One environment fact measured on the way: archkeep enumerates a workspace
through git, and refuses (`git ls-files` failing) outside a repository. A gate
that cannot see the tree's history-free file list refuses to guess — the same
instinct as the refusal lane.

## The canaries: why the gate is trusted

`pnpm arch` proves the law holds on the real tree; it cannot prove the gate
still bites — a gate that reports every tree clean looks identical to a green
one, and this repository's boundary gate failed exactly that way once, before
the canaries existed. Two fixtures, judged on every change:

- `tools/fixtures/boundary-canary/` — a resolvable illegal edge must be
  **judged and named**: exit 1, verdict `fail`, and exactly one violation with
  its project, file, line and messageId.
- `tools/fixtures/boundary-canary-unresolved/` — an unresolvable illegal edge
  must be **refused with its site still named**: exit 3, run status
  `no-verdict`, verdict `unknown`, `coverage.complete: false`, the site in
  `coverage.blindSpots`. This is the contract the 0.22.0 pin made load-bearing
  and the canary re-pinned (it asserted mere visibility at 0.21.0, when the
  same tree passed).

That pair is I13's two halves at the current pin: the judged refusal names its
constraint; the unresolvable one names its coverage reason. A third fixture
keeps the transport seam loud the same way. The rule the canaries encode is
the one this whole page runs on: an assertion the tool does not honor is a
new fail-open — fix the gate, never the canary, and re-measure before
re-pinning.

## Cost, and the U-2 trigger

Measured at pin 0.25.0 (2026-09-05, local wall clock): the six arch-gate steps
total ~6 seconds — boundary 1s, canary 2s, transport seam 1s, HTTP monopoly
0.5s, forge monopoly 0.5s, action shape 0.5s (a 2026-09-04 `Verify`-run
measurement at 0.22.1 recorded ~7s). The single `verify` job stands; there
is nothing to parallelize at this cost. **Revisit trigger: any single arch
gate exceeding 30 seconds** — measured per step, recorded here, re-checked
whenever the pin moves or the job grows a step.

## Keeping this page true

- **Pin moves:** the bump PR re-measures every behavioral claim on this page
  and lands bump, canary re-pin and page update together — dependency
  validation and nothing else, per the no-mixing rule.
- **Invariant edits:** [the run contract](run-contract.md) stays the sole
  owner of the invariants' statements; this page moves in the same PR and
  never restates them.
- **Authority:** where upstream documentation and a run of the pinned binary
  disagree, the run wins and this page is fixed the same day. Nothing on this
  page cites documentation as authority for behavior — every claim above came
  from a run, and future claims arrive the same way.

The boundary law this page sits on: [Doctrine](doctrine.md) and
[ADR 001](adr/001-core-boundary.md). What a run may keep of what it saw:
[ADR 003](adr/003-evidence-retention.md).
