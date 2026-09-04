# Run contract

What a run of any action here is: one subject, one policy pin, a bounded model
call, a decision the code owns, and a terminal state from a closed vocabulary.
This page is the durable home of that vocabulary, the failure taxonomy, the
concurrency discipline, the state-separation rule, and the sixteen invariants
the architecture is judged on.

Recorded 2026-09-03; owned by the repository maintainers; revisit when an
action's outcome vocabulary, gate set, or write surface changes.

## Terminal states and verdicts

Every run ends in exactly one terminal state:

| State       | What it means                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `published` | the run did what it set out to do and its writes landed                                                                                                              |
| `partial`   | some of the run's operations applied before the run stopped — recorded, never replayed                                                                               |
| `refused`   | the action's own ceilings declined to act — off-sheet answer, config absent, unsupported event                                                                       |
| `abandoned` | a fresher state superseded this one — a newer run, or the thread changed while this run was in flight; abandonment can follow a write, so state alone proves nothing |
| `skip`      | the run had nothing to do — event out of scope, dry-run, nothing to review                                                                                           |
| `failed`    | a defect or an environment break; the class below names which                                                                                                        |

And every run carries a verdict: `pass`, `fail`, or `unknown`.

- `unknown` never passes. A run that could not fully read the world it judged
  has no verdict, and a hollow verdict — a pass over facts nobody checked — is
  a defect, not a degraded pass.
- `refused` is not `failed`. A refusal is the ceilings working; `failed` is a
  defect or an environment break. Conflating them is how red herrings enter
  dashboards.
- Terminal state alone is never write evidence: `abandoned` and `skip` can
  still have written, so a record carries what applied, not just how it ended.

## What today's outcomes map to

| Action      | Today's outcome                                                     | Contract state                                        |
| ----------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| `triage`    | green run with writes                                               | `published`                                           |
| `triage`    | dry-run, event-gate exit                                            | `skip`                                                |
| `triage`    | red run                                                             | `failed` or `refused` per the class                   |
| `triage`    | the write withheld — the thread changed while the run was in flight | `abandoned`                                           |
| `review`    | `nothing-to-review`                                                 | `published` (the marker-clearing write still happens) |
| `review`    | `published`                                                         | `published`                                           |
| `review`    | `published-without-artifact`                                        | `published` with verdict `unknown` on the archive     |
| `review`    | `dry-run`                                                           | `skip`                                                |
| `review`    | `abandoned`                                                         | `abandoned`                                           |
| `harmonise` | commit + pull request                                               | `published`                                           |
| `harmonise` | some pairs applied, run stopped                                     | `partial`                                             |
| `harmonise` | config-absent or protection refusal                                 | `refused`                                             |
| `harmonise` | a throw the run did not declare                                     | `failed`                                              |

## Failure taxonomy

Fifteen classes; the class names the outcome, so the mapping is a function:

| #    | Class                     | Outcome                         | The rule it pins                                                             |
| ---- | ------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| F-01 | event-unsupported         | `skip`                          | an event outside the gate is out of scope, not a failure                     |
| F-02 | config-invalid/absent     | `refused`                       | no config, no run                                                            |
| F-03 | policy-source-unavailable | `failed`                        | the pin must resolve before anything reads it                                |
| F-04 | transport-5xx/429         | `failed` after retries          | retry with backoff, then stop                                                |
| F-05 | transport-timeout         | `failed`                        | reads may retry; writes are pinned to one attempt                            |
| F-06 | auth (401/403)            | `failed`, zero writes           | a bad token is an environment break                                          |
| F-07 | not-found-mid-write       | treated as applied              | a 404 on delete means already gone; the thread-existence inference is named  |
| F-08 | rate-limit-exhausted      | `failed`                        | backoff, then stop                                                           |
| F-09 | provider-invalid-answer   | `refused` or `failed`           | off-sheet (deterministic) refuses; junk fails — the mapping stays a function |
| F-10 | provider-refusal          | —                               | reserved, unused: no action can distinguish a refusal from junk yet          |
| F-11 | ceiling-exceeded          | typed refusal, else `failed`    | budgets exist to be enforced, not reported                                   |
| F-12 | subject-moved             | abort, no writes                | head/base moved between read and write                                       |
| F-13 | partial-mutation          | `failed` + `partial`            | record what applied; a re-run re-derives from live state, never replays      |
| F-14 | artifact-write-failure    | `published` + verdict `unknown` | the comment stands; the archive failed                                       |
| F-15 | internal-unknown          | `failed`                        | an unhandled throw is a bug, and the record says so                          |

## Run records

Every run leaves one machine-readable record behind — a local file inside the
runner's workspace, delivered by the workflow's upload step — so a run's
account outlives the runner log. The contract's rules for every record:

- **One record per run, at every terminal point.** A landed mutation, a dry
  run, a gate skip, a failure: each ends in a record. A run that died before
  anything could be recorded may write no file, and the upload's
  `if-no-files-found: ignore` keeps those runs green.
- **Byte-deterministic (I15).** No wall-clock fields; the same run facts
  build the same bytes. Keys sorted, compact JSON, no trailing newline.
- **Fail-closed.** The module that owns a record family validates it before
  serialising; a shape it did not specify is refused, not coerced, and a
  validation failure is a code bug that fails at build.
- **Sanitised at the build sites (I14, I16).** Model or repository text a
  record carries passes the comment sanitiser and honours its retention class
  and cap — [ADR 003](adr/003-evidence-retention.md) states the classes.
- **The `outcome` speaks the terminal-state vocabulary above, whole.** A word
  outside it is a word the contract has not defined.

Two families exist today:

| Family            | Module                      | `schemaVersion` | Delivery glob            | Written at                                             |
| ----------------- | --------------------------- | --------------- | ------------------------ | ------------------------------------------------------ |
| review's artifact | `review/src/artifact.mjs`   | 3 (4 for skips) | `review-artifact-*.json` | after a published comment; a draft run writes its skip |
| triage's record   | `triage/src/run-record.mjs` | 1               | `triage-record-*.json`   | every terminal point                                   |

Triage's record fields, version 1: `schemaVersion`, `repository`, `event`
(`eventName`, `action`), `thread` (`type`, `number`, or `null` for a run that
died before the payload parsed), `dryRun`, `model`, `policy` (`basis`,
`branch`, `sha`, or `null` before the source resolved), `decision` (present
iff the run reached one: `kind`, `add`, `remove` with their code-owned
reasons, `refusals`, sanitised capped `rationale`, `signal` with its
sanitised related title), `outcome`, `reason`, `verification` (the block
issue #274 froze — present, typed, validated; filled by the opt-in
verification pass when it ran, the empty block otherwise).

The two-tier posture a record write is judged by: after the run's own outcome
has landed (review's comment published; triage's mutation applied) a failed
record write is a logged loss, and the run stays green — review's
`published-without-artifact` maps to `published` with verdict `unknown` on
the archive (F-14). Everywhere else a record-write failure is the red run:
a skip's record is the skip's whole outcome, and a failure's record must not
mask the original error it records.

## Concurrency: read-then-write, never compare-and-swap

GitHub offers no compare-and-swap for labels or comments, so the discipline is
read-then-write with windows narrowed to what the API allows — and the four
windows that remain are named, not implied away:

1. **Comment upsert** — the newer-head guard judges a snapshot taken at upsert
   start; two runs that both list before either writes both pass the guard.
   Same-head concurrent runs are exempt by design.
2. **Labels** — the write diffs against a live read; the residual window is
   that one round trip.
3. **Harmonise publication** — own-branch writes carry a pre-write re-read and
   a post-write verification, so a lost write is refused loudly; the base tip
   is the remaining full-run window.
4. **Cancellation** — `cancel-in-progress` kills a run at an arbitrary
   operation boundary; the re-run re-derives from live state, never replays
   the plan (the F-13 rule).

Records carry the subject head and the policy SHA so a stale record is
detectable instead of authoritative.

## State separation

A field carries exactly one of three state models: **epistemic** (what the
run judged), **policy** (what the configuration allows), **human-workflow**
(what a person is doing with the thread). Two rules keep them apart:

- Never add a fourth meaning to a field that already carries one.
- Markers stay code-only, lifecycles stay publication-scoped, the sheet stays
  policy-only; new epistemic state gets its own fields.

## The sixteen invariants

Each names one authority: **A** architectural (archkeep-enforced), **D**
deterministic tooling (repo-local scripts in CI), **R** runtime safety
(app code + tests), **E** epistemic (bounded machinery + human). archkeep
judges static facts only — it owns the A rows and none of the others.

- **I1 — No action imports another; `core/` imports no action.** A —
  `pnpm arch` (boundary rows + intent), transitively closed.
- **I2 — Raw HTTP appears only in `core/transport/*`.** D — the HTTP-monopoly
  script in CI.
- **I3 — GitHub writes are issued by the forge alone.** D — the forge-monopoly
  script plus the frozen op-list manifest, in CI.
- **I4 — Model output never composes an API call.** R — closed sheets and
  typed op arguments by construction; sanitiser-bounded bodies; corpus-proven.
- **I5 — A model-picked value outside the effective sheet is refused, never
  coerced.** R — `pnpm test`.
- **I6 — Policy is SHA-pinned; payload SHAs never drive reads.** R.
- **I7 — File access is confined to `GITHUB_WORKSPACE`.** R.
- **I8 — No runtime dependencies, no build, no `dist/`; the entry points at
  `src/index.mjs`.** D — the action-shape script plus the release-invariants
  gate, in CI.
- **I9 — The run artifact is byte-deterministic and fail-closed.** R.
- **I10 — Run verdicts use the frozen vocabulary; `unknown` never passes.** R.
- **I11 — Every declared gate yields a recorded verdict, in declared order;
  a missing fact is a typed refusal, never a pass.** R.
- **I12 — The architecture is under architecture-intent: required projects
  exist and forbidden transitive dependencies stay absent.** A — `pnpm arch`.
- **I13 — The boundary canary proves why it refused.** D — the canary
  asserts the refusal names the constraint row.
- **I14 — No record field carries content beyond its declared retention class
  and cap.** R — the classes are ADR 003's to state.
- **I15 — Records are byte-deterministic given the run's inputs.** R.
- **I16 — Thread, diff and repository text enters only through the untrusted
  framing or the sanitiser — never as instruction.** R.

The boundary law this sits on: [Doctrine](doctrine.md) and
[ADR 001](adr/001-core-boundary.md). What a record may keep of what a run
saw: [ADR 003](adr/003-evidence-retention.md).
