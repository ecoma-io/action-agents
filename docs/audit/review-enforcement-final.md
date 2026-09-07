# Review-enforcement program — final audit (pr10)

Recorded 2026-09-06 on `hardening/pr10-final-audit` (base `main` @ `75d6630`, the
#402 merge). This is the closing counterpart to the Phase-0 audit
([review-enforcement-audit.md](review-enforcement-audit.md)): where that
document mapped the defects, this one reconciles every invariant the program
restored against the code, tests and live evidence that now hold it, and states
honestly what the program has not yet demonstrated. Method: every row below was
re-verified against the branch's sources and the GitHub record (issue states,
check runs, ruleset JSON) on the day of recording; nothing was carried forward
from the program's summary trail without a fresh read. Evidence is cited as
`file:line`, test file + case name, or GitHub object id. The one thing this
document refuses to do — describe a renderer proof as branch protection — is
said outright in §2.

Issue mapping: this document is DoD item 2 of #397 (the line-by-line
reconciliation and the enforcement-evidence pack). DoD item 1's remainder is
§2, §4 and §10.

## 1. Program summary

Nine hardening pull requests landed in the audit's mandatory merge order
(audit §10), each closing the findings it carried:

| PR   | What it landed                                                                                                                       | Merge commit | Closed                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ---------------------------------------- |
| #384 | PR1 contract lock — the gate law: `decideReviewGate` gains the `fail` arm; pass-law and §8 mapping repairs; the Phase-0 audit itself | `ee16f7b`    | #383                                     |
| #389 | PR2 publication ownership — `upsertComment` discriminated outcome, guard before duplicate cleanup, abandoned never claims an id      | `88c246b`    | #381's main-path half (issue stays open) |
| #390 | PR3 terminal check runs — every red terminal lands the `review gate` check (#377 inversion)                                          | `2f62345`    | #377                                     |
| #391 | PR4 provenance-bound recovery — `ownLogins` resolve before recovery; `previousRecord` ownership-tested                               | `c959290`    | #380                                     |
| #388 | PR5 SARIF identity — `primaryLocationLineHash` + `reviewFindingFingerprint/v2`, pinned `upload-sarif` consumer                       | `0d4044c`    | #385                                     |
| #394 | PR6 finding identity v2 — full-span hashing, `CANONICAL_VERSION = 2`, stored v1 verified by record version                           | `59b88aa`    | implements #393                          |
| #392 | PR7 artifact containment before mutation + publish observability (`artifact-file` output)                                            | `2dd777e`    | #378's action-side half                  |
| #387 | PR8 trust boundary — the dogfood trade decided and recorded (ADR 005)                                                                | `6238914`    | opened #386                              |
| #396 | PR9 cross-surface consistency — cases A–J, the §8 matrix executable, the deterministic race replay harness                           | `82f4ec2`    | #395                                     |

PR9 is test-only: 1136 insertions across
`review/src/e2e-cross-surface.test.mjs` (939) and
`review/src/e2e-cross-surface.fixtures.mjs` (197). Its fail-before proof is a
mutation check recorded in the PR body: flipping the gate-mode resolution at
the published check-run call site in `review/src/index.mjs` makes 11 tests
fail — all seven published T17 cases (A, B, C, D, H, I, J) and all four
published matrix walks — and reverting the mutation returns the suite to green.

Then Phase 13 (#397 → #398/#399/#400) flipped the dogfooded gate to
`gate-mode: "required"` (`fa42a1d`, `eaa6a6c`, `c3647a5`), and the program's
own live runs became the evidence — and the gap — recorded in §4. Two defect
PRs followed: #402 (`75d6630`, the #401 reconciliation-alignment fix, merged)
and #403/#404 (the #378 delivery fix and its docs sweep — both open, §8). This
document is the program's last deliverable.

## 2. DoD verdict

- **DoD 1 — protected-branch enforcement demonstrated: PARTIAL — the BLOCK
  path is demonstrated; the bypass and PASS paths are not.** What exists
  today: required-mode _renderer_ evidence (§4.1: #398 BLOCK, #399 BLOCK,
  #400 PASS — three rounds whose check-run verdicts tracked the diff) plus
  the enforcement half for one path — the `main` ruleset now requires
  `review gate` (§10, applied 2026-09-07) and a live red `review gate` on an
  up-to-date PR head produced `mergeStateStatus: BLOCKED` with
  `mergeQueueEntry: null` (§4.3, captured verbatim in §10). What remains
  undemonstrated: the bypass actors stay `always` (owner decision, §4.4), so
  a maintainer's merge-through-red is unmeasured, and no PASS-path
  enrollment capture (a green `review gate` entering the merge queue) was
  taken on this branch. The program records both as open gaps, not as
  evidence.
- **DoD 2 — line-by-line reconciliation of every invariant against code,
  tests and E2E, plus the enforcement-evidence pack: MET by this document**
  (§3 and §4). Every row was verified by reading the test, not by trusting
  the program record.

## 3. Invariant reconciliation

Two tables: the Phase-0 audit's task theorems (I1–I12, audit §4), then the
run contract's seventeen ([../run-contract.md](../run-contract.md), I1–I17).
"Tests that fail if broken" names the suite and case that regresses if the
invariant's code is broken; every case named was read on this branch.

### 3.1 The audit's theorems (I1–I12)

| #   | Invariant                                              | Code location                                                                                                                                | Tests that fail if broken                                                                                                                                                                                                                                                                                         | Live/E2E evidence                         | Verdict  |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------- |
| I1  | incomplete/invalid never PASS                          | `decideReviewGate` `review/src/merge-gate.mjs:54` (state arms, verdict arms, coverage, findings)                                             | `merge-gate.test.mjs` "blocks on a failing run verdict", "blocks on an unknown run verdict", "blocks on every non-published run state", "blocks when coverage is present and files remain unread", "blocks on a confirmed finding whose kind is in blockKinds"; `e2e-cross-surface.test.mjs` case D               | §4.1 rounds                               | **held** |
| I2  | `published` = this run owns its publication            | `upsertComment` `core/src/comment.mjs:151` (discriminated outcome; abandoned names no own id)                                                | `core/src/comment.test.mjs` "the publication outcome" describe (abandoned carries the standing winner, thread untouched); `e2e-adversarial.test.mjs` "a forged thread the run cannot date stops the write — abandoned, owning nothing"                                                                            | `e2e-cross-surface.test.mjs` case G       | **held** |
| I3  | a stale run never claims another run's publication     | same discriminated outcome; consumers judge `outcome` before touching `id`                                                                   | `core/src/comment.test.mjs` "the publication outcome" (leaves the thread exactly as it found it; no owned id on abandon)                                                                                                                                                                                          | case G (comment stands, record blocks)    | **held** |
| I4  | untrusted content never becomes trusted history        | `previousRecord(comments, action, ownLogins)` `review/src/record.mjs:133` — ownership test before recovery                                   | `record.test.mjs` "previousRecord ownership — provenance before recovery (#380)" (six T11 refusals + T12 control); `e2e-adversarial.test.mjs` "adversarial: provenance of the recovered record (#380)" suite                                                                                                      | case H (forged thread adopts nothing)     | **held** |
| I5  | every terminal run has an explicit enforcement outcome | `renderTerminalCheckRun` `review/src/index.mjs:473`; call sites `index.mjs:268` (red boundary) and `index.mjs:375` (non-published terminals) | `e2e-merge-bypass.test.mjs` "terminal rows — the red terminals land the check (T8, #377 inversion)", "the terminal §8 matrix — every non-published terminal renders its row (T9)", "published-without-artifact still lands the gate surfaces (T10)"; `index.test.mjs` renderer pins ("renderTerminalCheckRun: …") | §4.1 rounds                               | **held** |
| I6  | required check never silently pending                  | the only absence is the contract's named carve-out                                                                                           | `e2e-cross-surface.test.mjs` "row 'death before event facts' stays unsurfaced … — the named carve-out"; `e2e-merge-bypass.test.mjs` required-mode suites                                                                                                                                                          | §4.1 rounds (absence never hid a verdict) | **held** |
| I7  | projections of one canonical interpretation            | ADR 004; `createCanonicalResult` built once (`review/src/run.mjs:640` `canonicalFindings`, canonical assembled before the gate)              | `e2e-surface.test.mjs` "the comment, SARIF and the gate read one canonical record", "gate reasons cite only findings the canonical record carries"; `e2e-cross-surface.test.mjs` "the §8 projection matrix, executable"                                                                                           | —                                         | **held** |
| I8  | Ecoma identity independent of GitHub identity          | `review/src/sarif.mjs:72` `PRIMARY_LOCATION_LINE_HASH` + `sarif.mjs:75` `reviewFindingFingerprint/v2`; tuple at `review/src/identity.mjs:88` | `sarif.test.mjs` "carries the Ecoma fingerprint under primaryLocationLineHash — the key GitHub deduplicates on" (both keys, fixed order, byte-deterministic); `identity.test.mjs` "distinguishes two spans that share their first 200 characters"                                                                 | —                                         | **held** |
| I9  | blocking never bypassed by reconciliation/projection   | `reconcile` `review/src/reconcile.mjs:71` (pure; prose-only labels); identity join at `review/src/run.mjs:705-727`                           | `reconcile.test.mjs` "never retires a previous finding when the current run is incomplete"; `e2e-cross-surface.test.mjs` case I (stale finding persists everywhere at once) and #401's collapse regression (labels join by identity, §5)                                                                          | —                                         | **held** |
| I10 | historical state never leaks across HEADs              | `record.head === marker.head` binding + constructor fingerprint revalidation (verify-by-record-version)                                      | `record.test.mjs` "refuses a record whose head its own comment's marker does not carry"; `canonical.test.mjs` "verifies a stored v1 fingerprint under the retired scheme the input's version spells", "refuses a record version the pipeline never spelled"                                                       | case J (malformed record = first run)     | **held** |
| I11 | artifact publication path-safe                         | `writeRunArtifact` `review/src/index.mjs:541` — containment (lstat every existing segment) before any mutation                               | `index.test.mjs` "writeRunArtifact" refusals (`../elsewhere`, absolute path, `.git`, `.Git`) + "writeRunArtifact — containment before mutation (T15)" — zero mutation inside and outside on every symlink case                                                                                                    | —                                         | **held** |
| I12 | deterministic tests for terminal/race/provenance       | the replay harness                                                                                                                           | `e2e-cross-surface.test.mjs` "the deterministic race replay harness (T18)" — "the same schedule replays to the same terminal result" (twice) and "lands the terminal the audit names"                                                                                                                             | —                                         | **held** |

### 3.2 The run contract's seventeen (I1–I17)

Authority per [../run-contract.md](../run-contract.md): **A** architectural
(archkeep-enforced), **D** deterministic tooling (repo-local CI scripts),
**R** runtime safety (app code + tests), **E** epistemic. Note the suite
boundary the Phase-0 audit recorded: `pnpm test` discovers only `*/src/**`;
the security corpus and the tool guards run as separate `node --test` trees in
the battery, so a green `pnpm test` alone proves nothing about the D rows.

| #   | Invariant                                                                  | Auth | Enforcement (verified on this branch)                                                                                                                                                                                                                     | Verdict  |
| --- | -------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| I1  | no action imports another; `core/` imports no action                       | A    | `pnpm arch` (archkeep boundary rows + intent), transitively closed — battery on every PR                                                                                                                                                                  | **held** |
| I2  | raw HTTP only in `core/transport/*`                                        | D    | `tools/check-http-monopoly.mjs` (`pnpm arch:http-monopoly`)                                                                                                                                                                                               | **held** |
| I3  | GitHub writes issued by the forge alone                                    | D    | `tools/check-forge-monopoly.mjs` + the frozen op-list manifest (`security/forge-ops.json` — the single completed-check-run creation among them)                                                                                                           | **held** |
| I4  | model output never composes an API call                                    | R    | closed sheets + typed op arguments; corpus `security/run-adversarial.mjs`; `core/src/chat.test.mjs` request shape                                                                                                                                         | **held** |
| I5  | off-sheet model value refused, never coerced                               | R    | `answer.test.mjs` "rejects a finding whose kind is outside the closed vocabulary", "refuses structural defects with named reasons"; `e2e-adversarial.test.mjs` "an answer inventing a kind outside the vocabulary publishes an honest no-findings review" | **held** |
| I6  | policy SHA-pinned; payload SHAs never drive reads                          | R    | `core/src/policy.test.mjs` "policyReader pins every read to the resolved source's sha", "resolves the base branch's live tip, never the payload's base.sha"                                                                                               | **held** |
| I7  | file access confined to `GITHUB_WORKSPACE`                                 | R    | `core/src/workspace.test.mjs` "refusals at the boundary"; `capture.test.mjs` "refuses an anchor outside the workspace confinement"; `index.test.mjs` `writeRunArtifact` refusals + T15 containment suite (I11 above)                                      | **held** |
| I8  | no runtime deps, no build, no `dist/`                                      | D    | `tools/check-action-shape.mjs` + `tools/check-release-invariants.mjs`                                                                                                                                                                                     | **held** |
| I9  | run artifact byte-deterministic and fail-closed                            | R    | `artifact.test.mjs` "buildArtifact" (frozen, refusals suite); `e2e-surface.test.mjs` "two identical replays differ only in the run-scoped marker id", "the SARIF bytes and the check-run rendering are byte-stable across replays"                        | **held** |
| I10 | frozen verdict vocabulary; `unknown`/`fail` never pass                     | R    | `canonical.test.mjs` "rejects a run record outside the contract vocabulary"; the gate's unknown and fail arms (I1 above)                                                                                                                                  | **held** |
| I11 | declared gate tables yield recorded verdicts; missing fact never passes    | R    | `gates.test.mjs` "declares the five gates frozen, in the run's precedence order" + fail-closed suites per gate; `merge-gate.test.mjs` "structures reasons in order: state, verdict, coverage, findings"                                                   | **held** |
| I12 | architecture under architecture-intent                                     | A    | `pnpm arch` (archkeep intent)                                                                                                                                                                                                                             | **held** |
| I13 | the boundary canary proves why it refused                                  | D    | `tools/check-arch-canary.mjs` — asserts the refusal names the constraint row                                                                                                                                                                              | **held** |
| I14 | no record field beyond its retention class and cap                         | R    | `core/src/sanitise.test.mjs` rule suites; `capture.test.mjs` "caps the excerpt at the declared retention bound and sanitises it"                                                                                                                          | **held** |
| I15 | records byte-deterministic given the run's inputs                          | R    | `record.test.mjs` "embeds one deterministic line — the same record renders the same bytes", "round-trips byte-stably"                                                                                                                                     | **held** |
| I16 | thread/diff/repo text only through untrusted framing or sanitiser          | R    | `core/src/untrusted.test.mjs` (frame, delimiter collisions, cap); `record.test.mjs` "keeps the payload inside the sanitiser's rules — byte-identical, zero notes"                                                                                         | **held** |
| I17 | translatable prose carries the target script; violation is a typed refusal | R    | `harmonise/src/script-gate.mjs` (the module names I17); `harmonise/src/plan.mjs:290` `judgeAnswer`; `script-gate.test.mjs` per-script refusals; `plan.test.mjs` all-refusal record; `harmonise/src/index.test.mjs` script-gate → `refused` record         | **held** |

## 4. Enforcement evidence pack (the renderer half of DoD 1)

### 4.1 Live required-mode renderer proof

Phase 13 ran the dogfood's own gate at `gate-mode: "required"`
(`.github/workflows/review.yml:109`) against three successive diffs. The
check-run verdicts tracked the diff exactly:

| PR                       | Head      | `review gate` check run | Conclusion  | Completed (UTC) | Merge (UTC)                    |
| ------------------------ | --------- | ----------------------- | ----------- | --------------- | ------------------------------ |
| #398 (the flip)          | `a7cabef` | 101479847781            | **failure** | 11:38:09        | 11:39:07 — queue-merged anyway |
| #399 (comment alignment) | `1b05afd` | 101480955712            | **failure** | 11:46:52        | 11:50:08 — queue-merged anyway |
| #400 (style nits)        | `3197ab0` | 101481733940            | **success** | 11:53:00        | 11:56:07                       |
| #402 (labels fix)        | `fb5d549` | 101484962377            | **failure** | 12:17:16        | 12:18:20 — queue-merged anyway |

#398's BLOCK is the renderer working end-to-end: the run's published review
names a confirmed documentation finding — "`.github/workflows/review.yml:107`
— The comment above `gate-mode` still describes 'Observe' behavior, but the
value is set to 'required'" — and the gate renders it as a `failure` check run
on the PR head. (The check-runs API returns no summary/title payload for these
runs; the verdict, timestamps and the finding text above are quoted from the
API objects and the runs' published review comments.) #399's round likewise
ended BLOCK with only style-level comments on its diff ("Only minor style
nits in updated comments; no functional or security concerns", two nits
listed); #400 — the nits resolved — rendered the program's first live
required-mode `success` and merged green. #402's round blocked again, this
time with 1 of 2 changed files examined (coverage) per its own review comment
— and merged 64 seconds later anyway. §4.2 is why "anyway" was possible.

### 4.2 The gap — a required check the ruleset did not require

The `main` ruleset (id 21322094, enforcement `active`) at the time of Phase 13
— and still, at this document's recording — requires only:

- `required_status_checks`: `ci-gate`, `analysis-gate` (GitHub Actions
  integration);
- bypass actors: OrganizationAdmin → `always`, RepositoryRole (role 5) →
  `always`.

Consequence, observed live: all three Phase-13 PRs — and #402 — queue-merged
through a ruleset-gated `main` while their `review gate` check runs were red
(#398 merged 58 seconds after its BLOCK completed; #402 64 seconds after).
The renderer proof of §4.1 demonstrates everything up to the branch boundary;
the ruleset is the half that was not yet listening. This is a gap in the
program's outcome, stated as such — it is not enforcement evidence.

### 4.3 The negative proof, observed

After the ruleset edit (§10, applied 2026-09-07), PR #403's branch was
updated onto `main` and re-reviewed. Observed facts, each from the API:

- `review` (the action) run 34110709937 on head `7b4f2e8…` → `success`;
  the run published its review comment, whose embedded record carries
  `coverage.uncovered: ["tools/workflow-record-delivery.test.mjs"]` —
  4/5 changed files examined — and `"run": {"state": "published",
"verdict": "pass"}` (the #405 defect, live; §6a).
- `review gate` (the check) run **101706331100** on the same head →
  **`failure`**, output title `review gate: BLOCK`, completed
  2026-09-07T10:18:57Z. The gate check failing while the run's recorded
  verdict reads `pass` is consistent with the gate law (canonical coverage
  read independently of the verdict — the separation #405's fix makes
  explicit); this capture does not independently establish that
  separation, it observes it.
- `mergeStateStatus` → **`BLOCKED`**, `mergeQueueEntry` → `null`
  (GraphQL, queried 2026-09-07T10:19Z, verbatim in §10).

Inference, labelled as such: the BLOCK's proximate cause is the coverage
reason (the check-run summary names the unread file; the same run's record
carries it), not a verified finding — no confirmed finding exists in the
record. The causal chain from that coverage to the ruleset's BLOCKED state
is the documented gate law (`decideReviewGate` fails on uncovered files)
plus the ruleset's required check; neither link was independently re-tested
under a bypass actor, so the capture demonstrates the observed path only.

The fix's live counterpart, on PR #410's own head the same day: three
review attempts (10:28Z head `eea3513…`, 10:35Z head `b2daaa1…`) read 1/4,
1/4 and 2/4 changed files, and each record — under the fixed verdict law —
published `"verdict": "fail"` with the unread files named in
`coverage.uncovered`, where the pre-fix law published `pass` (as §4.3's
#403 capture shows on the same defect shape). Each gate check
(101708864033, 101710503910) rendered `review gate: BLOCK` and the PR
stayed `BLOCKED`. Read together, the two captures are the before/after of
#405 on the same defect class, plus the enforcement cost made visible: a
stochastic reviewer's partial reads hold merges, fail-closed, until a
full-coverage read lands. The review's own nit on the fix's
`coverageComplete` annotation was addressed by commit `8cadacb`.

### 4.4 Remediation status

Applied 2026-09-07: `review gate` (GitHub Actions integration 15368) joins
`ci-gate` and `analysis-gate` in the `main` ruleset's
`required_status_checks`. The bypass actors — OrganizationAdmin and
RepositoryRole (role 5) — remain `bypass_mode: "always"` by owner decision:
the owner chose not to narrow them in the same pass. Consequence, stated
plainly: a maintainer bypassing the ruleset can still merge through a red
`review gate`, exactly as Phase 13's PRs did under the old ruleset, and no
capture was taken of a bypass actor's merge-through-red under the new
ruleset. The §4.3 evidence is the observed path; bypass applicability is
untested and recorded as an open gap (§9), not as a pass.

## 5. Defect findings handled in scope

- **#378 — a declared artifact write silently lost in delivery.** The
  evidence chain, re-verified: runs 34030716749, 34031182306 and 34031480075
  each show the `Upload the run artifact` step green while the artifacts API
  lists `total_count: 0` (all three queried at recording). Root cause,
  reproduced locally against the pinned action: the workflow uploads the
  hidden directory glob `.review-artifact/review-artifact-*.json`
  (`.github/workflows/review.yml:142`) and `actions/upload-artifact` v7.0.1
  (`043fb46…`, pinned at `review.yml:139`) defaults
  `include-hidden-files: false` — the glob engine prunes the hidden directory
  before matching, the pattern matches zero files, and
  `if-no-files-found: ignore` (`review.yml:143`) suppresses even the warning.
  The issue was reopened with that live capture (issue comment 5559066948);
  the action-side half (containment-before-mutation, `artifact-file` output —
  `index.mjs:244`, `index.mjs:299`, the no-false-alarm log at
  `index.mjs:318`, pinned by `index.test.mjs` T16 tests) landed in #392. The
  delivery half is the workflow change in **#403 — open**, currently blocked
  by the flaky partial-coverage reviewer runs tracked in #405 (§6, §9).
- **#401 — reconciliation labels misassign across the fingerprint collapse.**
  The red evidence is the repro in the issue body: two published findings
  collapsing into one canonical finding shifted every later label onto the
  wrong row — the collapsed duplicate rendered wearing the third finding's
  label while the third rendered unlabeled, and the compared-count line
  miscounted — because `labelledFindings` joined the post-collapse
  `reconciled.current` to the pre-collapse `published` array by index. #402
  (`75d6630`) replaced the index join with the identity join
  (`review/src/run.mjs:705-727`): a `labelOfFingerprint` map over
  `canonical.findings`, keyed by the same `findingFingerprint` the canonical
  constructor collapses on; a collapsed duplicate now carries its survivor's
  label, never a neighbour's. Issue auto-closed; regression pinned by the
  cross-surface label cases in `e2e-cross-surface.test.mjs` and the
  reconciliation suite (`reconcile.test.mjs`).

## 6. Adversarial review outcome: accepted, with follow-ups

The program's final adversarial verification ACCEPTED the hardened pipeline
with two follow-ups, both kept open by scope decision:

- **(a) Outcome taxonomy — unparseable/unusable model output can still end in
  a published passing record.** The refusal/failed terminal class should own
  the cases where the model response records no (or partial) reads, instead of
  a `published`/`pass` record over an unreviewed diff. This is no longer a
  paper concern: **#405 tracks it live** with five-run evidence on PR #403's
  heads — zero-coverage runs publishing `published`/`pass` with empty findings
  (runs 34033745868, 34033980826, 34034383099 and the 13:08 run) while the
  gate independently fail-closes the merge with BLOCK check runs naming the
  unread files. The mitigation is real but indirect: the coverage invariant
  blocks the merge; the published record's truthfulness is the defect. OPEN.
- **(b) The replay harness has no `commentsQueue` seam.** `listComments` is
  static in the harness, so same-head recovery/upsert skew — the audit's race
  window 3 — cannot be replayed deterministically today. OPEN by scope
  decision; the existing schedules cover the other race shapes
  (`e2e-cross-surface.test.mjs` T18).

## 7. Review-comment triage

Eight review comments across the program's PRs, all authored by the review
bot. Four remained outstanding when this PR opened; three of them are fixed
by this PR, one needs no action:

1. `docs/run-contract.md:30` — the `fail` bullet's "never passes either"
   repeated line 27's "never passes" — **fixed by this PR** (ceiling semantics
   kept, redundant phrasing dropped).
2. `review/src/index.mjs:477` (the `renderTerminalCheckRun` JSDoc) — the
   `@returns` union claimed `"success"`, which only `renderGateCheckRun`
   produces — **fixed by this PR** (union corrected to the implementation's
   `"failure" | "neutral"`).
3. `review/src/run.mjs:700` — the label-join comment sat above
   `labelOfFingerprint` while explaining the index-alignment trap that bites
   at `labelledFindings` (the #402 bot nit: "consider moving the comment … or
   adjusting wording") — **fixed by this PR** (comment moved to directly
   precede the statement it describes; wording unchanged).
4. #402's withheld nit — the finder withheld it before publication, so no
   anchor was ever published; **no action**, recorded here so the tally
   closes.

## 8. Issue and PR state

States fetched live from the GitHub API on 2026-09-07 (refreshed with the
§10 capture).

| #         | Kind  | State               | Closing reason / remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ----- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #377      | issue | closed              | red terminals land the `review gate` check — #390                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| #378      | issue | **open** (reopened) | action-side fixed by #392; delivery half broken on `main` (§5) — fix in #403, open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| #380      | issue | closed              | provenance-bound recovery — #391                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| #381      | issue | **open**            | main path fixed by #382 + #389; the clearing path remains the open remainder, kept open by decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| #383      | issue | closed              | gate law — #384                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| #385      | issue | closed              | SARIF identity + upload — #388                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| #386      | issue | **open**            | ADR 005's re-open conditions + migration sketch — stays open by decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| #393      | issue | **open**            | implemented by #394 (full-span v2 identity, v1 verify-by-version); no close recorded — live state reported as-is                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| #395      | issue | closed              | cross-surface cases + replay — #396                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| #397      | issue | **open**            | the hardening tracker; stays open until the post-change enforcement capture (§10) lands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| #401      | issue | closed              | label misassign across collapse — #402, auto-closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| #405      | issue | **open**            | zero-read model response publishes a passing record (§6a). Duplicate check: not a duplicate of #381 — #381 is an abandoned marker-comment write that still reports `published` and attributes a foreign/`commentId` (publication-ownership seam); #405 is a zero-read model response that publishes a passing record over an unreviewed diff (record-truthfulness seam). Different seams, no duplicate among open issues.                                                                                                                                                        |
| #407      | issue | **open**            | failed-terminal step crash on an empty finding subject — the failed-terminal sibling of #405; with it, the live form of §6's taxonomy follow-up (a)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| #384–#396 | PRs   | closed (merged)     | the nine hardening PRs, §1's table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| #398–#400 | PRs   | closed (merged)     | Phase 13 required-mode flip; renderer evidence §4.1, gap §4.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| #402      | PR    | closed (merged)     | #401 fix; `75d6630` is this branch's base                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| #403      | PR    | **open**            | the #378 delivery fix; red `review gate` (101706331100), `mergeStateStatus: BLOCKED`, not enqueued — the live blocked case, §10. Same head also carries the §4.3 record whose `"verdict":"pass"` over an uncovered file is #405 live                                                                                                                                                                                                                                                                                                                                             |
| #404      | PR    | **open**            | the run-record delivery posture docs sweep, paired with #403; head stale against `main` (`BEHIND`). Its one review run (34036826590) ended FAILED — the failed artifact was written and the run's decisions were sound (quarantine of the unanchored finding, refutation of the review.md:1138 finding) — and the terminal step then crashed on `findings[0].subject must be a non-empty string` (gate check `review gate: BLOCK (failed)`, summary = the validation error; → #407). Open by design: its hunks only become true once #403 merges — the base mismatch is expected |

## 9. Open items

1. **Ruleset: required check applied; bypass untouched.** `review gate`
   joined `required_status_checks` on 2026-09-07 (§4.4, §10). Both bypass
   actors remain `always` by owner decision — an open gap, not in flight.
2. **#403 blocked, not enqueued** — its `review gate` is red from the flaky
   partial-coverage reviewer runs #405 records (§6a); it becomes §10's natural
   blocked-merge capture once the ruleset requires the check.
3. **#404** — the docs-sweep PR, open, its head stale against `main`
   (`BEHIND`): its delivery-posture hunks only become true once #403
   merges. Queue order constraint: #403 → #404.
4. **#397 stays open** until the PASS-path and bypass-path captures land
   and DoD 1's PARTIAL flips (§2).
5. **#386 stays open** by decision — ADR 005's re-open conditions live
   there.
6. **#405 + the `commentsQueue` seam stay open** by scope decision (§6).
   The fix in #410 (draft, unmerged at recording) is the program's
   response; it closes the issue only when merged and dogfooded.
7. **#407 stays open** by scope decision — with #405, the live form of
   the taxonomy follow-up (§6a).
8. **Bypass actors `always`** — a maintainer can merge through a red
   `review gate`. No capture of that path exists; recorded as an open gap
   (§4.4), not as evidence or as a pass.

## 10. Appendix: post-change enforcement capture

Before-state, verified via the rulesets API on 2026-09-06 (ruleset `main`,
id 21322094):

```json
{
  "id": 21322094,
  "name": "main",
  "enforcement": "active",
  "required_status_checks": ["ci-gate", "analysis-gate"],
  "bypass_actors": [
    { "actor_type": "OrganizationAdmin", "bypass_mode": "always" },
    { "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ]
}
```

After-state, verified via the same API on 2026-09-07:

```json
{
  "id": 21322094,
  "name": "main",
  "enforcement": "active",
  "required_status_checks": ["ci-gate", "analysis-gate", "review gate"],
  "bypass_actors": [
    { "actor_type": "OrganizationAdmin", "bypass_mode": "always" },
    { "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ]
}
```

Diff: `review gate` (GitHub Actions integration 15368) added to the
required set; bypass actors unchanged — `always`, by owner decision (§4.4).

Live capture, PR #403 on head `7b4f2e8cda42e62be74ee8f129108c6926972e26`,
2026-09-07 ~10:19Z:

```
$ gh pr view 403 --json mergeStateStatus,mergeQueueEntry
{"mergeStateStatus":"BLOCKED","mergeQueueEntry":null}
```

The gate check run (101706331100) and its output title are recorded in
§4.3. No PASS-path enrollment capture and no bypass-actor merge capture
were taken; both are open gaps (§9).
