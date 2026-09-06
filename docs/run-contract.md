# Run contract

What a run of any action here is: one subject, one policy pin, a bounded model
call, a decision the code owns, and a terminal state from a closed vocabulary.
This page is the durable home of that vocabulary, the failure taxonomy, the
concurrency discipline, the state-separation rule, and the seventeen invariants
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
| `skip`      | the run had nothing to do — event out of scope, dry-run, nothing to review, an eligibility rule matched with `run: false`                                            |
| `failed`    | a defect or an environment break; the class below names which                                                                                                        |

And every run carries a verdict: `pass`, `fail`, or `unknown`.

- `unknown` never passes. A run that could not fully read the world it judged
  has no verdict, and a hollow verdict — a pass over facts nobody checked — is
  a defect, not a degraded pass.
- `fail` never passes either. A review that could not complete within its
  ceilings — a partial review — publishes what it concluded and stops there;
  its verdict records the incompleteness, and the merge gate reads it as no
  pass.
- `refused` is not `failed`. A refusal is the ceilings working; `failed` is a
  defect or an environment break. Conflating them is how red herrings enter
  dashboards.
- Terminal state alone is never write evidence: `abandoned` and `skip` can
  still have written, so a record carries what applied, not just how it ended.

## What today's outcomes map to

| Action      | Today's outcome                                                                       | Contract state                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triage`    | green run with writes                                                                 | `published`                                                                                                                                                                                        |
| `triage`    | dry-run, event-gate exit                                                              | `skip`                                                                                                                                                                                             |
| `triage`    | red run                                                                               | `failed` or `refused` per the class                                                                                                                                                                |
| `triage`    | the write withheld — the thread changed while the run was in flight                   | `abandoned`                                                                                                                                                                                        |
| `review`    | `nothing-to-review`                                                                   | `published` (the marker-clearing write still happens; when that write loses the newer-head guard, the run ends `abandoned` and no skip record is written)                                          |
| `review`    | `published`                                                                           | `published` — a Partial review publishes here too: its incompleteness rides the verdict (`fail`), never the state                                                                                  |
| `review`    | `published-without-artifact`                                                          | `published` (the verdict stands; the archive's absence is a logged delivery loss, never a verdict)                                                                                                 |
| `review`    | `dry-run`                                                                             | `skip`                                                                                                                                                                                             |
| `review`    | an applicability rule matched with `run: false` (bot attestation, size guard)         | `skip`                                                                                                                                                                                             |
| `review`    | `abandoned`                                                                           | `abandoned`                                                                                                                                                                                        |
| `review`    | a typed deterministic refusal — its own ceilings declining to act (#355)              | a `refused` record, then the red error — the boundary writer reads the class                                                                                                                       |
| `review`    | any other throw the run did not declare                                               | a `failed` record for the throws the boundary sees, then the red error — the boundary writer pins F-15; the entrypoint's input and context reads stay unrecorded                                   |
| `harmonise` | commit + pull request                                                                 | `published`                                                                                                                                                                                        |
| `harmonise` | some pairs applied, run stopped                                                       | `partial`                                                                                                                                                                                          |
| `harmonise` | dry run, or every pair already in step                                                | `skip`                                                                                                                                                                                             |
| `harmonise` | a pair the run refuses — preparation or protection (#356, #358)                       | `partial` when other pairs published; otherwise a `refused` record when every skipped line is a refusal, a `failed` record when a defect line joins the skipped lines — the red error follows each |
| `harmonise` | every pair refused by the script gate — arriving candidates in the wrong script (I17) | `partial` when other pairs published; otherwise a `refused` record when every line is the typed refusal, a `failed` record when a defect line joins — the red error follows each                   |
| `harmonise` | a typed deterministic refusal — its own ceilings declining to act (#347)              | a `refused` record, then the red error — the boundary writer reads the class                                                                                                                       |
| `harmonise` | any other throw the run did not declare                                               | a `failed` record, then the red error — the boundary writer pins F-15                                                                                                                              |

## Failure taxonomy

Fifteen classes; the class names the outcome, so the mapping is a function:

| #     | Class                     | Outcome                                                                                                                                                                                                                                                                                                                                                                                             | The rule it pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01  | event-name-unsupported    | `failed`                                                                                                                                                                                                                                                                                                                                                                                            | an unsupported event name is a defect or misconfiguration — review/triage throw                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| F-01a | event-action-unsupported  | review `failed`; triage re-triages                                                                                                                                                                                                                                                                                                                                                                  | review's event gate throws — a red refusal, no artifact; triage decides an unlisted action from live state and never silently skips it                                                                                                                                                                                                                                                                                                                                                                                                                   |
| F-02  | config-invalid/absent     | `refused` (triage); harmonise: `refused` via the typed refusal's boundary record (#347); review: `refused` for the validator arm — an invalid file, retyped at the boundary (#355) — and `failed` for the reader arm: a configured path absent, a policy declared twice, a foreign schema major, F-15's tier, because the reading call interleaves transport breaks a blanket retype would mislabel | no config, no run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| F-03  | policy-source-unavailable | `failed`                                                                                                                                                                                                                                                                                                                                                                                            | the pin must resolve before anything reads it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| F-04  | transport-5xx/429         | `failed` after retries                                                                                                                                                                                                                                                                                                                                                                              | retry with backoff, then stop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| F-05  | transport-timeout         | `failed`                                                                                                                                                                                                                                                                                                                                                                                            | reads may retry; non-idempotent writes are pinned to one attempt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| F-06  | auth (401/403)            | `failed`, zero writes                                                                                                                                                                                                                                                                                                                                                                               | a bad token is an environment break                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F-07  | not-found-mid-write       | treated as applied                                                                                                                                                                                                                                                                                                                                                                                  | a 404 on delete means already gone; the thread-existence inference is named                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| F-08  | rate-limit-exhausted      | `failed`                                                                                                                                                                                                                                                                                                                                                                                            | backoff, then stop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| F-09  | provider-invalid-answer   | `refused` or `failed`                                                                                                                                                                                                                                                                                                                                                                               | off-sheet (deterministic) refuses; junk fails — the mapping stays a function; review's twice-failed output contract is the off-sheet arm and records `refused` (#355); in harmonise a junk answer is a defect line: it fails the run's record; of the protection layer's verdicts only the order one is not junk: a candidate that does not preserve its placeholders' order records the typed refusal (#351, #358), while the unknown-token and count-mismatch verdicts stay plain errors — the junk arm; a wrong-script candidate records it too (I17) |
| F-10  | provider-refusal          | —                                                                                                                                                                                                                                                                                                                                                                                                   | reserved, unused: no action can distinguish a refusal from junk yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F-11  | ceiling-exceeded          | typed refusal, else `failed`                                                                                                                                                                                                                                                                                                                                                                        | budgets exist to be enforced, not reported; harmonise's byte caps raise the typed refusal (#347); review's diff-line budget and prompt-headroom ceilings raise it too (#355)                                                                                                                                                                                                                                                                                                                                                                             |
| F-12  | subject-moved             | `abandoned` (triage, review); harmonise: `failed` — the boundary records the throw                                                                                                                                                                                                                                                                                                                  | head/base moved between read and write — the write is refused loudly, never hidden; triage and review record `abandoned` and stay green, harmonise's optimistic lock throws undeclared and the boundary writes the `failed` record — still red, now recorded                                                                                                                                                                                                                                                                                             |
| F-13  | partial-mutation          | `failed` (triage); `partial` (harmonise)                                                                                                                                                                                                                                                                                                                                                            | records as `failed` with per-op accounting in the reason; harmonise's partial exit writes `partial` — some pairs published, the run stopped; a re-run re-derives from live state, never replays                                                                                                                                                                                                                                                                                                                                                          |
| F-14  | artifact-write-failure    | the run's own terminal verdict stands                                                                                                                                                                                                                                                                                                                                                               | the write is the logged loss: review's comment stands with verdict `unknown` on the archive; harmonise's declared points keep their verdict and stash the built record for a red boundary (#347); where the record write is the run's only outcome — a triage dry run — the loss is the red run                                                                                                                                                                                                                                                          |
| F-15  | internal-unknown          | `failed`                                                                                                                                                                                                                                                                                                                                                                                            | an unhandled throw is a bug, and the record says so                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Run records

Every run leaves one machine-readable record behind — a local file inside the
runner's workspace, delivered by the workflow's upload step — so a run's
account outlives the runner log. The contract's rules for every record:

- **One record per run, at every terminal point the action declares.** A
  landed mutation, a dry run, a gate skip: each ends in a record. A
  failure's posture is per action — triage records at its own terminal
  points, failures included; harmonise's red terminals are declared too:
  any throw its run did not declare — a config refusal, a transport break,
  a mid-run defect — reaches the boundary writer, which records the class
  the throw carries and lets the original error fail the step, so the
  record never masks the throw it records: a typed deterministic refusal —
  the action's own ceilings declining to act (F-02, F-11, a protection
  verdict) — records `refused` (#347); every other undeclared throw records
  `failed` (F-15). An every-pair red set is judged by its worst line, so
  the mapping stays a function: every line a deterministic refusal records
  `refused`, and one defect line — a transport break, a junk model answer —
  records `failed`. Only a run that dies before it holds the facts a record
  is built from — the entrypoint's input and context reads — and a run whose
  record write itself fails — red at the boundary, or green at a declared
  point under the logged-loss tier below — stay unrecorded; the upload's
  `if-no-files-found: ignore` keeps the green ones green. Review has no
  declared failure record yet; its failure-record path is its own change.
- **Byte-deterministic (I15).** No wall-clock fields; the same run facts
  build the same bytes. Keys sorted, compact JSON, no trailing newline.
- **Fail-closed.** The module that owns a record family validates it before
  serialising; a shape it did not specify is refused, not coerced, and a
  validation failure is a code bug that fails at build.
- **Sanitised at the build sites (I14, I16).** Model or repository text a
  record carries passes the comment sanitiser and honours its retention class
  and cap — [ADR 003](adr/003-evidence-retention.md) states the classes.
- **The `outcome` speaks the terminal-state vocabulary above, whole.** A word
  outside it is a word the contract has not defined — triage and harmonise
  write their records' `outcome` from it, and review's artifact speaks the
  classification vocabulary its own shapes declare, which the mapping table
  above maps onto it.

Three families exist today:

| Family             | Module                         | `schemaVersion`             | Delivery glob             | Written at                                                                                                                                                                                                      |
| ------------------ | ------------------------------ | --------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| review's artifact  | `review/src/artifact.mjs`      | 4; 5 (applicability family) | `review-artifact-*.json`  | a published comment writes the full artifact; abandonment and a dry run write their reduced artifacts; a draft run writes its skip                                                                              |
| triage's record    | `triage/src/run-record.mjs`    | 1                           | `triage-record-*.json`    | every terminal point                                                                                                                                                                                            |
| harmonise's record | `harmonise/src/run-record.mjs` | 3                           | `harmonise-record-*.json` | every terminal point: publication, partial exit, all-in-step skip, dry run — and the red terminals, where the boundary writer records `refused` for a typed deterministic refusal and `failed` otherwise (#347) |

Triage's record fields, version 1: `schemaVersion`, `repository`, `event`
(`eventName`, `action`), `thread` (`type`, `number`, or `null` for a run that
died before the payload parsed), `dryRun`, `model`, `policy` (`basis`,
`branch`, `sha`, or `null` before the source resolved), `decision` (present
iff the run reached one: `kind`, `add`, `remove` with their code-owned
reasons, `refusals`, sanitised capped `rationale`, `signal` with its
sanitised related title and its capped, sanitised missing-required names),
`outcome`, `reason`, `verification` (the block
issue #274 froze — present, typed, validated; filled by the opt-in
verification pass when it ran, the empty block otherwise).

Harmonise's record fields, version 3: `schemaVersion`, `repository`,
`eventName`, `sourceLanguage`, `dryRun`, `outcome`, a sanitised and capped
`reason`, `pairs`
(`selected`, `proposed`, `unchanged`, `skipped`, `failed` — the five total
the selected schedule; `null` when the run died before its accounting was
finalised), `pullRequest` (`number`, `created`, or `null` when the run wrote
none), `headSha` (the base commit every read pinned to; `null` before the
run resolved one).

Review's artifact shapes, version 4 (the applicability family's shapes are
version 5): the full published shape carries the twelve-fact body the
builder validates; the reduced abandonment shape carries the run identity,
the outcome sentence, and — when a comment was published before the subject
moved — the comment id under `provenance`; the reduced dry-run shape carries
the run identity and the outcome sentence only. The reduced red shape the
boundary writer builds (#355) carries the run identity, the outcome sentence
— sanitised and capped, the one review reason that interpolates a thrown
message — and the classification the throw's class decides: `refused` for a
typed deterministic refusal, `failed` otherwise; its `headRef` is the honest
`null` of a run that died before the snapshot read, its `provenance` names
the comment when one stands — on a `failed` record only; a `refused` record never
names one — and a run with no head to name writes `no-head` in the file name's
place. The reduced shapes name the
execution context under `applicability` when the policy was active, and
neither carries a policy section — nothing was read beyond the
classification. Every shape's file name names its outcome:
`review-artifact-`, `review-artifact-abandoned-`, `review-artifact-dry-run-`,
`review-artifact-skip-`.

The two-tier posture a record write is judged by. Where the run's own outcome
has landed — review's comment published, triage's mutation applied,
harmonise's pull request opened, and, since #347, harmonise's declared skip
points (a dry run, nothing to propose) too — a failed record write is a
logged loss, and the run keeps its verdict: review's
`published-without-artifact` maps to `published` with verdict `unknown` on
the archive (F-14). Where the record write is the run's only outcome — a
triage dry run, whose skip record is the whole of what the run did — the
loss is the red run. A harmonise record a failed write could not land is
stashed: a red exit re-attempts that record at the boundary writer, exactly
as it was built, so the write's failure never relabels the terminal it was
written for — and a failure's record never masks the original error it
records.

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

Records carry the subject head so a stale record is detectable instead of
authoritative, and every shape that carries a policy section — review's full
and skip shapes, triage's record — pins its SHA beside it.

## State separation

A field carries exactly one of three state models: **epistemic** (what the
run judged), **policy** (what the configuration allows), **human-workflow**
(what a person is doing with the thread). Two rules keep them apart:

- Never add a fourth meaning to a field that already carries one.
- Markers stay code-only, lifecycles stay publication-scoped, the sheet stays
  policy-only; new epistemic state gets its own fields.

## The canonical review result

A review's verified publication set is canonical: one shape, built once by
`createCanonicalResult`, that the comment, the SARIF upload and the merge gate
all project from ([ADR 004](adr/004-canonical-review-result.md)). Five rules
give the shape its authority:

- **Finding identity is content, not position.** A finding's fingerprint is a
  versioned digest over its normalized path, its claim kind — a closed,
  code-validated vocabulary the verification pass binds from evidence, as
  epistemic as the verdicts themselves — and the code span the reviewed bytes
  carry at its anchor, captured by the integration boundary that reads the
  snapshot (the canonical constructor verifies a stored fingerprint against
  the recomputed tuple; it never reads files). Line moves, message rewrites
  and severity re-grades
  keep the identity; a rewritten span, a new file or a reclassified claim is
  a new finding — churn reconciliation records, never enforcement drift,
  since the gate reads the current set. Claims sharing the full key in one
  run collapse to the first, recorded on the result.
- **Reconciliation is code, and incomplete runs resolve nothing.** The
  `new | persisting | moved | resolved | unresolved` vocabulary is computed
  from artifacts; a run that could not complete its coverage never declares a
  previous finding `resolved`. The published comment embeds the record the
  next run reconciles against — the comment, not the artifact file, is what
  survives between runs.
  Recovery reads only a comment this action's own token authored — the same
  ownership test the write applies, with the token's logins resolved before
  the thread is read — never the newest comment carrying the marker syntax.
- **The gate is a pure function of the canonical result and the policy.**
  `unknown` and `fail` never pass — an unanswered or incomplete review is no
  pass; an abandoned or refused run does not pass; a confirmed finding the
  policy blocks on blocks the gate. The model
  names no consequence, and no projection — comment or SARIF — is ever read
  back as input. The one carve-out runs the other way: the published comment
  embeds the record it projected, the next run recovers it to render the
  cross-run labels as comment prose, and a missing or unreadable record
  reconciles as a first run — never a consequence.
- **Evidence is captured, never claimed.** Before publication, code reads the
  reviewed bytes at each finding's (file, line) anchor and stores the digest
  and capped excerpt the fingerprint is recomputable from — the capture
  boundary the constructor's no-I/O rule leaves outside it. A capture the
  tree cannot honour — file unreadable or outside the workspace, line out of
  range, an empty file — refuses the finding's evidence and with it the run:
  a `refused` record and the red error, naming file and line, never a
  skip-and-continue that publishes a finding whose digest confirms nothing.
- **The gate's verdict lands as surfaces, and none of them is the job's
  exit.** The verdict is `PASS` or `BLOCK`. `gate-mode` chooses only whether
  it enforces: `observe` (the default — a rollout must never start on the
  enforcing mode) records `OBSERVE-<verdict>` on the `gate-verdict` output and
  a `neutral` check run; `required` names the verdict bare and renders
  `success` on PASS, `failure` on BLOCK — the check run a ruleset makes
  required. Every terminal a run can end in lands this surface — a `refused`,
  `failed` or `abandoned` run renders the check run too, `failure` under
  `required`; a `skip`, `nothing-to-review` or `dry-run` terminal renders
  `neutral` in both modes, recorded and enforcing nothing; and the check
  output names the terminal state either way — except a run that dies before
  it holds the event facts needed to name a head; that carve-out is the
  contract's, never an accident. And
  because GitHub counts a `neutral` check as reported, a repository that
  makes the check required MUST pin `gate-mode: required` — `observe`
  satisfies the ruleset while enforcing nothing. A BLOCK never fails the
  action's exit: the run stays green with
  its outputs standing. The SARIF projection is written under `runner.temp`
  — never the workspace — byte-identical for the same record, surfaced
  through `sarif-path`; the upload is the consumer's step. Each surface is a
  logged loss on its own failure (F-14's posture): a SARIF write or check-run
  call that does not land is reported, never a red run, and never a disguise.
  A gate policy that names a kind outside the closed vocabulary is a defect,
  not a preference: it throws, and the run ends `failed` — fail closed, fail
  loud, never a silent narrowing.

## The seventeen invariants

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
- **I10 — Run verdicts use the frozen vocabulary; `unknown` and `fail` never pass.** R.
- **I11 — Review's declared gate table (conclusion, bound, coverage, provenance, verification) yields a recorded verdict for each, in declared order; a missing fact is a typed refusal, never a pass. Triage and harmonise satisfy the same law without a declared gate table — typed refusals enforced sequentially, a missing fact never passes.** R.
- **I12 — The architecture is under architecture-intent: required projects
  exist and forbidden transitive dependencies stay absent.** A — `pnpm arch`.
- **I13 — The boundary canary proves why it refused.** D — the canary
  asserts the refusal names the constraint row.
- **I14 — No record field carries content beyond its declared retention class
  and cap.** R — the classes are ADR 003's to state.
- **I15 — Records are byte-deterministic given the run's inputs.** R.
- **I16 — Thread, diff and repository text enters only through the untrusted
  framing or the sanitiser — never as instruction.** R.
- **I17 — A published pair's translatable prose carries the configured target
  language's script; a violation is a deterministic refusal of the pair.** R —
  the script gate in `judgeAnswer`; `pnpm test`.

The boundary law this sits on: [Doctrine](doctrine.md) and
[ADR 001](adr/001-core-boundary.md). What a record may keep of what a run
saw: [ADR 003](adr/003-evidence-retention.md).
