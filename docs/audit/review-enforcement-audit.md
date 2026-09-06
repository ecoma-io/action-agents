# Review-enforcement pipeline audit (PHASE 0)

Recorded 2026-09-06 on `hardening/pr1-contract-lock` (base `main` @ `ad76345`).
Scope: the `review` action's canonical-result pipeline — comment publication,
record recovery, merge gate, check run, SARIF projection, run artifact — and
the workflow surfaces that deliver them. Method: seven parallel read-only
audits (contract/state machine, concurrency/publication, provenance,
enforcement/check-run, SARIF, artifact security, test coverage) plus primary
verification of every load-bearing claim; security claims were confirmed with
offline sandbox repros, and third-party behavior with the pinned action's own
source. Evidence is cited as `file:symbol` or `file:line`. Nothing in this
document is implementation; each contradiction names the PR that closes it.

Issue mapping: #377 → K2; #378 → A4; #380 → K7; #381 → K4 (open remainder).

## 1. The current state machine

### 1.1 Vocabulary in play

Four outcome vocabularies coexist:

| Vocabulary                            | Where                            | Values                                                                                                                                              |
| ------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run contract terminal state           | `docs/run-contract.md`           | `published`, `partial`, `refused`, `abandoned`, `skip`, `failed`                                                                                    |
| `RunResult.outcome`                   | `review/src/run.mjs`             | `published`, `abandoned`, `skip`, `nothing-to-review`, `dry-run`, `published-without-artifact`, `refused`, `failed` (red boundary, `index.mjs:216`) |
| Artifact classification               | `review/src/artifact.mjs`        | `published`, `abandoned`, `dry-run`, `skip`, `refused`, `failed` (+ kinds on skip records)                                                          |
| Canonical `run.state` / `run.verdict` | `review/src/canonical.mjs:22-32` | states: the contract vocabulary; verdicts: `pass`, `fail`, `unknown`                                                                                |

The canonical result is built exactly once, on the published return path
(`review/src/run.mjs:664`, verdict chosen by the run-gate table `mayPublish`;
`state` hardcoded `"published"` — review never constructs `partial`).
`decideReviewGate(canonicalResult, policy)` (`review/src/merge-gate.mjs:53-89`)
is the pure gate decision. Only the published return carries `canonical` and
`gate` (`run.mjs:872-879`); every other terminal returns `RunResult` alone.

### 1.2 Terminal points and what each produces

| Terminal                                         | Production site                                             | Canonical?          | Check run?                                  | Artifact                                                 |
| ------------------------------------------------ | ----------------------------------------------------------- | ------------------- | ------------------------------------------- | -------------------------------------------------------- |
| `published`                                      | `run.mjs:872-879`                                           | yes                 | yes (`index.mjs:272-295`)                   | full artifact                                            |
| Partial review (gates failed, comment published) | `run.mjs:664` (`mayPublish=false`)                          | yes, verdict `fail` | yes — but the gate currently PASSes it (K1) | full artifact, `published` classification (K5)           |
| `nothing-to-review`                              | `run.mjs:1214-1226`                                         | no                  | no                                          | skip record (`review-artifact-skip-*.json`)              |
| `skip` (event gate, applicability `run:false`)   | `run.mjs:226-268`, `352-377`                                | no                  | no                                          | skip record                                              |
| `dry-run`                                        | `run.mjs:356-366`, `640-655`, `844-860`, `1198-1210`        | no                  | no                                          | reduced dry-run artifact (except green suppressions)     |
| `abandoned` (pre-publication, upsert guard)      | `run.mjs:820-838`                                           | no                  | no                                          | abandoned artifact, no commentId (post-#382)             |
| `abandoned` (post-write freshness)               | `run.mjs:852-871`                                           | no                  | no                                          | abandoned artifact with own `commentId` under provenance |
| `abandoned` (stale at read)                      | `run.mjs:713-723`, `793-809`, `nothingToReview` `1163-1176` | no                  | no                                          | abandoned artifact                                       |
| `refused` / `failed`                             | red boundary `index.mjs:203-240`                            | no                  | **no** (the #377 hole)                      | red artifact                                             |
| Death before event/forge facts                   | `index.mjs:112-170` (outside the try)                       | no                  | **no — impossible today**                   | none (documented carve-out)                              |

### 1.3 Check-run lifecycle

One creation site: `index.mjs:290-295` inside the `canonical && gate` guard
(`index.mjs:272`). The forge op `createCheckRun`
(`core/src/forge.mjs:1280-1304`) posts a single **completed** check run
(`status: "completed"`, one attempt, no retry to avoid duplication), frozen in
`security/forge-ops.json:30` (invariant I3). Conclusion mapping
(`renderGateCheckRun`, `index.mjs:342-364`): `required` → PASS=`success`,
BLOCK=`failure`; `observe` → always `neutral`. There is no in-progress state
and no update path; a check run is born terminal or not at all.

### 1.4 Comment publication lifecycle

`upsertComment` (`core/src/comment.mjs:119-198`): list comments → select own
marker comments (marker action **and** author ∈ ownLogins, `comment.mjs:127-137`)
→ sort by id, delete duplicate losers (`comment.mjs:163-169`) → newer-head
guard (`comment.mjs:172-191`, fail-closed on unreadable timestamps) → update
winner or create. Returns `{ outcome: "created" | "updated" | "abandoned", id }`
— the abandoned branch returns the **standing (foreign-owned) winner id**
(`comment.mjs:189`). Consumers: review main path (`run.mjs:811-838`, outcome
checked post-#382), review clearing path (`run.mjs:1205-1213`, outcome
**discarded**), triage comment and signal ops (`triage/src/mutate.mjs:267-278`,
`294-305`, outcome reduced to a log line — an abandoned write counts as an
applied op).

### 1.5 Record recovery lifecycle

The published comment embeds the canonical record
(`review/src/record.mjs:embedRecordBlock`, base64 HTML comment). The next run
recovers it via `previousRecord` (`record.mjs:122-131`): newest comment whose
marker names this action, embedded record must parse through
`createCanonicalResult` (full shape + fingerprint revalidation) **and** carry
`record.head === marker.head`. No author check. The recovered record feeds
`reconcile` (`run.mjs:684-689`) → rendered prose labels only.

### 1.6 Artifact delivery lifecycle

`writeRunArtifact` (`index.mjs:407-469`) writes inside the workspace under
`artifact-path` (default `.review-artifact`); the workflow uploads
`.review-artifact/review-artifact-*.json` with `actions/upload-artifact` v7.0.1
(pinned), `if-no-files-found: ignore` (`.github/workflows/review.yml:102-108`).
The artifact does not survive between runs; the comment is the carrier.

## 2. The desired state machine

1. **One canonical interpretation.** `createCanonicalResult` stays the single
   builder; the comment, check run, SARIF and artifact remain projections
   computed from it (ADR 004). No projection is read back as input.
2. **Publication ownership is explicit.** `upsertComment` returns a
   discriminated outcome: `{ outcome: "created"|"updated", id, deletedDuplicates }`
   or `{ outcome: "abandoned", foreignId, deletedDuplicates }` — an abandoned
   write carries **no** `id`, because it wrote no comment of its own. A run
   declares `published` only on `created`/`updated` of its own write.
   Post-publication abandonment keeps the run's own `commentId` under
   provenance (the comment this run wrote stands — write evidence), while
   pre-publication abandonment names no comment id at all.
3. **The gate law is a pure, total function.** PASS ⇔ `state === "published"`
   ∧ `verdict === "pass"` ∧ coverage closed ∧ no policy-blocked
   confirmed/unresolved finding. `fail` and `unknown` never pass. Every other
   terminal state BLOCKs with a named reason.
4. **Every terminal lands an enforcement surface.** Every run that can name the
   repository and head renders a terminal `review gate` check run — `success`
   only for the gate law's PASS under `required`; `failure` for BLOCK;
   `neutral` under `observe`. Absence of the check is never the closed state
   (C6). The one residual carve-out (death before the run holds the event
   facts) is named in the contract, not silently absorbed.
5. **Provenance parity.** The mechanism that selects the upsert target and the
   mechanism that recovers the previous record apply the same ownership test:
   author ∈ ownLogins, resolved from the run's own token identity.
6. **Two identity systems, two adapters.** The Ecoma fingerprint
   (`review/src/identity.mjs`) drives reconciliation and persistence. GitHub
   Code Scanning alert identity is a separate projection concern
   (`partialFingerprints["primaryLocationLineHash"]`, see §3/S1).
7. **Artifact delivery is verified or loud.** A declared artifact write must be
   retrievable, or its absence is surfaced by the workflow — never a
   false-success (C6 applied to delivery).

## 3. Semantic contradictions

Each item: what the code/docs do today, evidence, and the severity for the
invariants. K-prefix items are contract/semantics; A-prefix are artifact
filesystem/delivery; S-prefix is SARIF; T-prefix are tests that pin defective
behavior.

- **K1 — `published` + verdict `fail` passes the merge gate (violates I1, C5;
  task Task 1.2).** `decideReviewGate` blocks on `state !== "published"`
  (`merge-gate.mjs:64-68`) and `verdict === "unknown"` (`:69-71`); there is no
  `fail` arm. Empirically probed: `{state:"published", verdict:"fail",
findings:[], coverage closed}` → `{verdict:"PASS", reasons:[]}`. The state is
  production-reachable: a Partial review (a declared run-gate failed — bound,
  provenance, coverage or verification) publishes with verdict `fail`
  (`run.mjs:664`, `gates.mjs:724`). A max-turns-bound Partial review with clean
  findings and closed coverage passes a `required` gate today.
- **K2 — non-published terminals render no enforcement surface (#377, violates
  C6, I5/I6).** The gate-surfaces block is gated on `canonical && gate`
  (`index.mjs:272`), which only the published path provides. Red-boundary
  throws write the red artifact and rethrow (`index.mjs:203-240`); the outer
  catch just `setFailed`s (`index.mjs:489-491`). Every skip, dry-run,
  abandonment and refusal leaves the `review gate` check absent; a ruleset
  making it `required` pends forever (observed: run 33995911404, PR #374).
  `nothing-to-review` — contract-mapped to `published` — also renders none.
- **K3 — the `published-without-artifact` mapping is unmaterializable.** The
  contract maps it to "`published` with verdict `unknown` on the archive", but
  no site ever produces verdict `unknown`: `index.mjs:258` mutates only the
  outcome string, the canonical keeps its verdict, and the artifact family has
  no run-verdict field (and is the thing that failed to write). F-14's "the
  run's own terminal verdict stands" and the mapping row are in direct tension.
- **K4 — `nothing-to-review` asserts a publication its write may not have made
  (#381 open remainder, violates C7/I2).** The clearing write
  (`run.mjs:1205-1213`) discards the upsert outcome; when the newer-head guard
  abandons it, the run still ends `nothing-to-review` with the durable reason
  "universe empty — marker cleared" and a skip record. The main path was fixed
  by #382 (`run.mjs:820-838`, pinned at
  `review/src/e2e-adversarial.test.mjs:470-479`); this path was not.
- **K5 — publication success is conflated with review verdict across four
  vocabularies.** `RunResult.outcome` never carries `fail` (a Partial review's
  outcome is `published`, `run.mjs:872-879`); the artifact classification is
  `published` for both pass and fail runs (the Partial banner rides only inside
  the reason string); canonical `run.verdict` carries pass/fail; the comment
  posture label carries Complete/Partial. The only enforcement consumer of the
  verdict — the gate — under-reads it (K1); artifacts cannot convey it at all.
- **K6 — `partial` is dead canonical vocabulary in review.** `canonical.mjs`
  admits it, review never constructs it (`run.mjs:664` hardcodes `published`),
  record recovery rejects non-published records (`record.mjs:99`), and the
  contract's mapping table has no row for review's Partial posture. Review's
  de facto spelling of incomplete is `published + fail`.
- **K7 — record recovery trusts content shape, not authorship (#380, violates
  C8/I4).** `previousRecord` (`record.mjs:122-131`) accepts the first
  newest-first comment whose body carries the marker syntax, with no ownership
  test — unlike the write layer, which filters by ownLogins
  (`comment.mjs:127-137`). Any account that can comment can post a forged
  marker + structurally valid record block (all inputs to a valid record are
  public: head, paths, digests) with `record.head === marker.head`, and become
  the "previous" canonical record steering reconciliation prose. Blast radius
  today is prose-only (gate/SARIF/exit read the current run's record alone),
  but the trust boundary is crossed. Secondary asymmetries: recovery reads the
  thread before ownLogins are resolved (`run.mjs:684` vs `:750`/`:1179`), and
  carries no staleness guard.
- **K8 — `observe` mode satisfies a required ruleset while enforcing nothing.**
  A `neutral` conclusion counts as reported for ruleset gating; the default
  mode's BLOCK never blocks a ruleset-gated merge
  (`e2e-merge-bypass.test.mjs:127-146` pins "satisfying a ruleset, enforcing
  nothing"). Rollout safety requires the observe default; the contract must
  state explicitly that a ruleset-gated deployment MUST pin `gate-mode:
required`, and the docs currently frame this only as advice.
- **A1 — the artifact write mutates the filesystem before containment
  validation (violates the I7 ceiling's spirit; confirmed by sandbox repro).**
  Order in `writeRunArtifact` (`index.mjs:407-469`): realpath root → lexical
  resolve → lexical containment + `.git` checks → `mkdirSync` (`:420`) →
  readdir + `rmSync` cleanup (`:428-431`) → **then** `realpathSync` and the
  real containment checks (`:436-444`). A PR-author-planted symlink
  (git mode 120000, materialized by checkout under `pull_request`) at
  `.review-artifact` therefore: (a) deletes `review-artifact-*.json`-named
  files **outside the workspace** through the link before the refusal
  (repro: `deletedBeforeValidation = ["review-artifact-stale.json"]`), and
  (b) creates attacker-owned empty directories outside the workspace via
  recursive mkdir through a symlinked parent. The final `writeFileSync` cannot
  escape (post-validation, planted same-name symlinks are pre-unlinked).
  Constrained blast radius; still a ceiling violation.
- **A2 — tests assert only the throw, never the outside tree.**
  `review/src/index.test.mjs:729-748` covers symlink-into-`.git` and
  symlink-out refusals without asserting the outside fixture is unmutated, so
  A1's deletion is invisible to the suite.
- **A3 — `upsertComment` deletes duplicates before the newer-head guard**
  (`comment.mjs:163-169` precedes `:172-191`): an abandoning run can still
  mutate the thread (deleting its own older duplicates) while the run layer
  reports "nothing written" (`run.mjs:825-829`) — contradicting the module's
  own "abandoning over-writes nothing" posture and the contract's
  "a record carries what applied".
- **A4 — a declared artifact write can be silently lost in delivery (#378).**
  Mechanism confirmed from the pinned action's source:
  `actions/upload-artifact` v7.0.1 defaults `include-hidden-files: "false"`
  (pinned `action.yml`), which sets `excludeHiddenFiles: true` in
  `@actions/glob` (`src/shared/search.ts:getDefaultGlobOptions`), and the glob
  engine prunes **any traversed item whose basename starts with `.`** before
  matching or descending (toolkit `packages/glob/src/internal-globber.ts`
  traversal loop: `if (options.excludeHiddenFiles && path.basename(item.path)
.match(/^\./)) continue`). The literal `.review-artifact` segment in the
  upload pattern does not exempt it: the directory is pruned at the first
  traversal level, so the pattern matches zero files even when the red
  artifact exists; `if-no-files-found: ignore` then suppresses even the
  warning, the step goes green, and the artifacts API lists nothing
  (`total_count: 0`) — exactly the #378 signature (log "written" + upload
  success + API empty). Contributing design gap: the workflow cannot tell
  "run declared no record" from "record declared but never delivered" (C6),
  because the action does not output what it wrote and nothing verifies
  delivery.
- **S1 — the SARIF projection's fingerprint slot is not GitHub's alert
  identity (violates I8's separation in effect).** The projection sets
  `partialFingerprints["reviewFindingFingerprint/v1"]`
  (`review/src/sarif.mjs:66`), but GitHub Code Scanning consults exactly one
  partial-fingerprint key for cross-upload alert matching —
  `primaryLocationLineHash` ("Code scanning only uses the
  primaryLocationLineHash", SARIF support docs); any custom-named key is
  stored, never consulted. Uploading via `github/codeql-action/upload-sarif`
  without `primaryLocationLineHash` makes the action compute a line-derived
  hash from the runner's checkout bytes (line-sensitive: a moved line mints a
  different alert), and a raw-API upload without it duplicates alerts. Today
  the pipeline has no stable GitHub alert identity at all, and no upload
  consumer exists in the repo's workflows.
- **T1 — the suite pins the defective absences.** `e2e-merge-bypass.test.mjs`
  header and `:194-259` pin "a refused, failed or abandoned run renders no
  check run at all … fail-closed by absence" as intended; `:249-255` and
  `e2e-adversarial.test.mjs:242-255`, `290-307` assert `checkRuns` `[]` on red
  paths. These assertions encode K2 and must be inverted with the contract
  change, not preserved.
- **T2 — `merge-gate.test.mjs` never feeds `verdict: "fail"`.** Only
  `unknown` (`:68-70`) and non-published states (`:59-65`) are covered; K1 is
  invisible to the suite.

## 4. Invariants (task I1–I12 mapped to repo law)

| Task invariant                                            | Status today                                                                                  | Evidence                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| I1 incomplete/invalid never PASS                          | **violated** (K1)                                                                             | `merge-gate.mjs:64-71`, probe PASS on `published+fail`                        |
| I2 `published` = this run owns its publication            | violated on clearing + triage paths; main path fixed by #382                                  | `run.mjs:1205-1213`; `mutate.mjs:277,304`                                     |
| I3 stale run never claims another run's publication       | partially held                                                                                | `comment.mjs:189` still returns foreign `id`; `mutate.mjs` logs it as applied |
| I4 untrusted content never becomes trusted history        | **violated** (K7)                                                                             | `record.mjs:122-131`                                                          |
| I5 every terminal run has an explicit enforcement outcome | **violated** (K2)                                                                             | `index.mjs:272`                                                               |
| I6 required check never silently pending                  | **violated** (#377)                                                                           | run 33995911404 evidence; `e2e-merge-bypass.test.mjs:194-259`                 |
| I7 projections of one canonical interpretation            | held structurally, under-pinned                                                               | ADR 004; `sarif.mjs`/`renderGateCheckRun` consume canonical only              |
| I8 Ecoma identity independent of GitHub identity          | **violated in effect** (S1)                                                                   | `sarif.mjs:66` slot never consulted by GitHub                                 |
| I9 blocking never bypassed by reconciliation/projection   | held (prose-only recovery), untested for the matching-head forgery                            | `run.mjs:683-689`; missing TestGap case                                       |
| I10 historical state never leaks across HEADs             | held by `record.head === marker.head` + fingerprint revalidation; forged head defeats it (K7) | `record.mjs:126-127`                                                          |
| I11 artifact publication path-safe                        | **violated** (A1)                                                                             | `index.mjs:420-431` precede `:436-444`                                        |
| I12 deterministic tests for terminal/race/provenance      | gaps listed in §9                                                                             | TestGap audit                                                                 |

Repo-level invariants untouched by this program hold: `pnpm arch` clean (568
imports, 170 files, boundary fingerprint `c45fe82a…`), I1–I17 per
`docs/run-contract.md` except as re-derivable from the rows above.

## 5. Producer / consumer matrix

| Fact             | Producer                                                                                | Consumers                                                                                            | Notes                                 |
| ---------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Canonical result | `createCanonicalResult` (built at `run.mjs:664-696`, revalidated in `parseRecordBlock`) | `decideReviewGate`; `toSarif`; comment render + `reconcile`; artifact builder; embedded record block | the only source of truth (C3)         |
| Gate decision    | `decideReviewGate(canonical, policy)`                                                   | `renderGateCheckRun` → check run; `gate-verdict` output; artifact gate section                       | pure function; policy from config     |
| Upsert outcome   | `upsertComment`                                                                         | review main path, review clearing path, triage ×2, red stash (`red.commentId`), artifact provenance  | to become discriminated union (§2.2)  |
| Embedded record  | `embedRecordBlock` via upsert body                                                      | next run's `previousRecord` → `reconcile` → render prose                                             | never read back into gate/SARIF/exit  |
| Check run        | `index.mjs` gate-surfaces block                                                         | repository rulesets; `review gate` on PR checks list                                                 | one completed-run creation, frozen op |
| SARIF file       | `writeSarifFile` under `runner.temp`, `sarif-path` output                               | consumer's upload step (none in-repo today)                                                          | byte-deterministic projection         |
| Run artifact     | `writeRunArtifact`                                                                      | workflow upload step → artifacts API                                                                 | does not survive across runs          |
| Comment          | upsert → forge                                                                          | humans; next run's marker scan + record recovery                                                     | the cross-run carrier                 |

## 6. Race conditions

1. **Comment upsert window** (contract window 1): two runs both list before
   either writes; same-head concurrency exempt by design. Guard: newest-head +
   fail-closed timestamps (`comment.mjs:172-191`).
2. **Duplicate deletion precedes the guard** (A3): the deleting run mutates
   the thread even when it then abandons.
3. **Recovery/upsert snapshot skew**: `previousRecord` reads the thread once at
   `run.mjs:684`; the upsert re-reads inside `upsertComment`
   (`comment.mjs:122`). A comment posted between the reads is
   recovered-as-previous but not upsertable, or vice versa.
4. **Write-time freshness re-read** (`run.mjs:852-871`): narrow window between
   comment landing and artifact freshness check; abandonment after the write
   keeps the comment standing (correct per contract).
5. **Labels / publication windows** (contract windows 2–3): triage diffs
   against a live read; harmonise re-reads pre-write — outside this audit's
   review scope, unchanged.
6. **Cancellation** (contract window 4): `cancel-in-progress` on
   `review-${pr.number}` (`review.yml:57-59`) kills a run at an arbitrary
   boundary; re-runs re-derive. Interacts with K2: a cancelled run also leaves
   no check run.
7. **Recovery has no staleness guard**: a forgery posted while the model loop
   is running is recovered (Provenance audit); owner-bound selection plus the
   existing head binding closes the practical vector.

## 7. Trust boundaries

1. **Comment content is untrusted** (SECURITY.md third ceiling). Marker +
   record blocks are attacker-writable by anyone who can comment; only the
   author identity is GitHub-authenticated (`user.login` cannot be forged to a
   `[bot]` principal). Today the write layer uses this and the read layer does
   not (K7). Available on the already-fetched wire response and currently
   discarded at the mapping seam (`core/src/forge.mjs:986-1005`): `user.id`,
   `user.type` (`"Bot"`), `author_association`, `performed_via_github_app`.
2. **The reviewed workspace is untrusted data** (I7). The artifact write site
   is the one place the action creates/deletes under a PR-author-writable path;
   A1 is its law violation. The read ceiling is enforced in
   `core/src/workspace.mjs` (links never followed, `:177-183`) with fixture
   proof under `security/fixtures/path-traversal/`; the write site has only
   throw-level tests (A2).
3. **The review runtime executes PR-carried code in the dogfood**
   (`review.yml:33-38`, `./review` from the merge preview under
   `pull_request`) with `pull-requests: write`, `checks: write`, and the LLM
   gateway key in reach for same-repo branches; forks carry neither secrets nor
   a write token. This is the trade the workflow states rather than hides; §10
   PR8 audits it and records an architectural decision (ADR) — fix now or an
   explicit accepted risk with a follow-up issue. It must not silently persist
   as dogfood folklore (audited: ADR 005).
4. **Model output never composes calls or enforcement** (I4/I5, C4) — holds by
   construction and corpus; the gate reads structured canonical state only.
5. **SARIF delivery trust**: the upload consumer will need
   `security-events: write` and `actions: read` (artifact verification); the
   action itself never needs either.

## 8. Terminal × projection matrix (authoritative baseline, Phase 10 input)

Derived from the contract + audit; this is what PR1 pins in tests and PR3
implements. `conclusion` = the `review gate` check run's conclusion in
`required` mode; `observe` renders `neutral` for every row except `skip`
(also `neutral`) — recorded, enforcing nothing.

| Terminal state                                 | Verdict   | Gate                                         | Check (`required`)           | Comment                                                             | SARIF                                 | Artifact                                       |
| ---------------------------------------------- | --------- | -------------------------------------------- | ---------------------------- | ------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------- |
| `published` (complete)                         | `pass`    | PASS iff coverage closed ∧ no policy finding | `success`                    | published (+record block)                                           | confirmed findings only               | full artifact                                  |
| `published` (partial review)                   | `fail`    | **BLOCK** (K1 fix)                           | `failure`                    | published with Partial posture                                      | per contract: confirmed findings only | full artifact, classification `published`      |
| `published` + `unknown`                        | `unknown` | BLOCK                                        | `failure`                    | n/a (no producer today; K3 row rewritten in contract)               | none                                  | n/a                                            |
| `refused`                                      | —         | BLOCK                                        | `failure`                    | none (a refusal never names a comment)                              | none                                  | red artifact                                   |
| `failed`                                       | —         | BLOCK                                        | `failure`                    | provenance names comment only if one landed                         | none                                  | red artifact                                   |
| `abandoned` (pre-write)                        | —         | BLOCK                                        | `failure`                    | no new publish; duplicates stay (A3 fix)                            | none                                  | abandoned artifact, no commentId               |
| `abandoned` (post-write)                       | —         | BLOCK                                        | `failure`                    | this run's comment stands (provenance)                              | none                                  | abandoned artifact with own commentId          |
| `skip` / `nothing-to-review` (clearing landed) | —         | non-block                                    | `neutral`                    | clearing write lands (or `abandoned` when the guard fires — K4 fix) | none                                  | skip record                                    |
| `dry-run`                                      | —         | non-block                                    | `neutral`                    | nothing written                                                     | none                                  | reduced dry-run artifact (or suppressed green) |
| death before event facts                       | —         | BLOCK (unsurfaced)                           | **absent — named carve-out** | none                                                                | none                                  | none                                           |

Every row becomes a deterministic replay assertion (§9); no terminal may map
to absence except the named carve-out.

## 9. Missing tests (the deterministic matrix this program must add)

Canonical level:

- T1 regression: `decideReviewGate({published, fail, clean, closed})` → BLOCK
  with a verdict reason (fails pre-fix — K1).
- T2 verdict coverage beside the state arms: `published+fail` (T1) and
  `published+unknown` block; the five non-published states block under a
  passing verdict; the composed ordering test pins the fail reason's position.
- T3 reason-order law composes: `published+fail` + uncovered file + confirmed
  finding → all reasons, structural first, findings in publication order.

Publication ownership (core + E2E):

- T4 `upsertComment` discriminated outcome: abandoned carries no `id`; zero
  writes/deletes on abandon (duplicate cleanup reordered after the guard —
  A3), duplicates remain on the thread; `deletedDuplicates` surfaced on
  created/updated.
- T5 clearing-path race (#381 remainder): newest own-marker comment on a
  foreign head + undatable timestamp → clearing run ends `abandoned`, reason
  not "marker cleared", skip record not written (fails pre-fix — K4).
- T6 triage callers: abandoned upsert is not counted applied; log names no
  owned id; run record reflects the abandonment per F-12.
- T7 post-write abandonment keeps the run's own commentId under provenance and
  pre-write abandonment names none (the ownership distinction pinned).

Enforcement surfaces (E2E, inverting T1's pins):

- T8 red run renders the terminal check: scripted output-contract refusal →
  non-pass check run on the snapshot head naming the terminal state
  (required: `failure`; observe: `neutral` + `OBSERVE-BLOCK`); the
  currently-pinned `checkRuns []` assertions rewritten.
- T9 every non-published terminal renders its §8 row (skip/abandoned ×2/
  refused/failed/nothing-to-review) in both gate modes; action exit stays
  green on BLOCK (contract law).
- T10 `published-without-artifact`: forced artifact-write failure → gate
  surfaces still fire from the canonical (K3's resolved row pinned).

Provenance (record level + E2E):

- T11 the eight adversarial recoveries: forged marker foreign author;
  forged+valid record; forged+current HEAD; forged+historical HEAD; duplicate
  foreign markers; own marker+malformed record; own marker+corrupt base64;
  own marker+mismatched record HEAD. All → first-run reconciliation, none →
  trusted previous state. The matching-head foreign-author case is the one
  that fails pre-fix (K7).
- T12 own honest record still recovers (compatibility control).

SARIF / identity:

- T13 dual identity: `partialFingerprints["primaryLocationLineHash"]` equals
  the Ecoma canonical fingerprint (deterministic, byte-stable across replays);
  the canonical reconciliation fingerprint is unchanged (compat fixtures).
- T14 SARIF schema validity + confirmed-only emission (existing pins kept).

Artifact path + delivery:

- T15 symlink adversarial set: target symlink, parent symlink, nested symlink,
  nonexistent target, normal target, traversal, pre-existing malicious files —
  asserting **zero filesystem mutation before the refusal** (fails pre-fix —
  A1/A2; the strong lstat-segment variant, not just the reorder).
- T16 delivery: declared write ⇒ `artifact-file` output set ⇒ upload
  `artifact-id` non-empty ⇒ artifacts API lists it (scripted equivalent);
  declared write + missing delivery ⇒ loud failure. Green no-write terminals
  assert no false alarm.

Cross-surface consistency + replay (PR9):

- T17 the ten cases A–J of the task brief on one harness: clean pass;
  confirmed finding; unresolved (`blockUnresolved`); verification failure;
  refused; failed; abandoned race; forged comment; stale finding across HEAD;
  malformed record — canonical == gate == comment == SARIF == artifact
  semantics.
- T18 replay harness extensions: stale run, concurrent publication, duplicate
  comment, foreign marker, malformed embedded record, check terminalization
  after failed run — event-ordered, no sleeps, same inputs ⇒ same terminal
  result.

## 10. Proposed PR sequence

Merge order is mandatory; each PR lands through the queue with signed commits
and CI's Verify battery: `pnpm lint && pnpm typecheck && pnpm arch` with the
arch canaries and monopolies, `pnpm test`, `pnpm test:tools`, `pnpm security`,
`pnpm check-skills`, and the remaining `check-*` gates — the full table is
`CONTRIBUTING.md`. The vitest suite discovers only `*/src/**`: the security
corpus and the tools guards are `node --test` trees it never sees, so a green
`pnpm test` alone proves nothing about them (PR1's corpus pin paid that gap).

1. **PR1 — contract lock** (this branch). Contract edits: the pass law names
   `fail` (K1); every terminal lands a gate surface (K2/C6); mapping-table
   repairs (partial row, published-without-artifact row materialized, K3;
   nothing-to-review abandoned-clearing note, K4); ADR 004 "incomplete"
   operationalized; record-ownership sentence (K7 doc half); I10 restated;
   observe/required ruleset note (K8). Code: the `fail` gate arm. Tests
   T1–T3 at the gate level. Audit doc included. The canonical `publication`
   fact moved to PR2: the canonical is built before the upsert
   (`run.mjs:662` precedes `run.mjs:811`), so a defaulted fact would assert
   publication before it happened; PR2 rebuilds construction from the real
   upsert outcome with record parsing covered.
2. **PR2 — publication ownership (#381 close)**. `upsertComment` discriminated
   outcome + guard-before-cleanup (A3); clearing path maps abandon →
   `abandoned` (K4); triage callers stop counting abandoned as applied;
   artifact metadata never attributes foreign comments; the canonical gains
   the `publication` fact beside `state`/`verdict` (additive,
   `CANONICAL_VERSION` stays; `publication_success != review_verdict`
   pinned), built from the upsert outcome now that it is known. Tests T4–T7.
3. **PR3 — terminal check-run semantics (#377 close)**. Terminalizer hook in
   the red boundary and on every non-published terminal; §8 matrix
   implemented; contract carve-out (death before event facts) documented;
   `e2e-merge-bypass`/`e2e-adversarial` absence pins inverted. Tests T8–T10.
4. **PR4 — provenance-bound recovery (#380 close)**. ownLogins resolved before
   recovery and passed explicitly; `previousRecord` applies the upsert's
   ownership test; forge keeps the provenance fields it already receives.
   Tests T11–T12.
5. **PR5 — SARIF identity + real upload**. Emit
   `partialFingerprints["primaryLocationLineHash"]` from the Ecoma
   fingerprint (GitHub's consulted key); workflow gains the pinned
   `upload-sarif` consumer with `security-events: write`, explicit category,
   `if:` semantics per §8; docs state the two identity systems. Tests T13–T14.
6. **PR6 — finding identity hardening.** Fingerprint over the full normalized
   span (truncation becomes display-only), versioned tuple; explicit
   compatibility story for stored v1 records (verify by record version; one
   documented reconciliation churn at migration, no silent invalidation).
   Truncation-collision tests.
7. **PR7 — artifact path security + delivery observability (#378 close)**.
   Strong containment: lstat every path segment, refuse symlinked components
   before any mkdir/cleanup (the A1 sandbox repro becomes the regression);
   then mkdir → realpath → revalidate → cleanup on the validated path →
   write. Delivery: `artifact-file` output, upload passes the exact file,
   `include-hidden-files: true`, `if-no-files-found: warn`, post-upload
   artifacts-API verification gated on a declared write (+`actions: read`).
   Tests T15–T16.
8. **PR8 — PR-execution trust boundary**. The §7.3 questions answered with
   evidence; decision recorded as ADR (pinned-release runtime for untrusted
   contexts, or explicit accepted risk + follow-up issue). No silent risk.
9. **PR9 — cross-surface consistency + replay harness**. T17–T18; §8 matrix
   as an executable table; race repros event-ordered.
10. **PR10 — docs + final audit**. A final audit report —
    `review-enforcement-final.md` beside this file — proving task invariants
    I1–I12 with implementation/tests/E2E evidence and remaining risks; guides
    updated; then the Phase-13 dogfood (observe → controlled ruleset →
    required) on the live repository.

## Exit criteria status

- Terminal states enumerated: §1.2 (all ten production terminals, including
  the carve-out). Verdicts: `pass`/`fail`/`unknown` with producers named (K3:
  `unknown` has no producer — contract row rewritten rather than left
  unmaterializable).
- Valid/invalid combinations: §1.2 + ContractAudit matrix distilled into §8.
- Projections of the canonical result: §5.
- Open issues mapped: #377→K2 (PR3), #378→A4 (PR7), #380→K7 (PR4), #381→K4
  - A3 (PR2; main path already closed by #382 — repro pinned green at
    `e2e-adversarial.test.mjs:470-479`).
- Beyond the tracker, recorded here as first-class findings: K1
  (`published+fail`), K3/K5/K6 (contract materialization), K8 (observe vs
  rulesets), A1/A2 (artifact ordering), S1 (SARIF identity), §7.3 (PR-execution
  trust boundary), T1/T2 (tests pinning defects).

## Residual risks after the program (explicitly carried)

1. A run that dies before it holds the event facts cannot name a head and so
   cannot terminalize a check run; the workflow run is red but a required
   `review gate` stays pending. Named in the contract by PR3; a
   workflow-level pre-creation step is the optional follow-up if the
   dogfood shows it matters.
2. `observe` mode satisfies rulesets by GitHub's definition of a reported
   check; the default stays observe for rollout safety, and PR1 makes the
   "ruleset-gated ⇒ `required`" rule explicit documentation.
3. The dogfood workflow executes PR code with a write-capable token for
   same-repo branches until PR8's decision lands; this audit declines to
   normalize it (§7.3).
4. GitHub-side artifacts listing propagation (seconds-scale eventual
   consistency) is an environmental factor the PR7 verification step must
   tolerate (bounded retry) without softening the loud-failure contract.

## Appendix — audit provenance

- ContractAudit: state×verdict matrix, K1–K8, test matrix T1–T12.
- ConcurrencyAudit: attribution-flow map, A3, triage surfaces.
- ProvenanceAudit: K7 asymmetry, wire-provenance inventory.
- EnforcementAudit: check-run lifecycle, skip points, #377 reproduction path.
- SarifAudit: GitHub matching fields with doc citations, S1.
- ArtifactSecurityAudit: A1/A2 sandbox repros, A4 source chain, safe order.
- TestGapAudit: §9 coverage map, T1/T2 pins.
- Primary verification: direct reads of `merge-gate.mjs`, `canonical.mjs`,
  `identity.mjs`, `comment.mjs`, `sarif.mjs`, `record.mjs`, `run.mjs`,
  `index.mjs`, `artifact.mjs` (ordering), `.github/workflows/review.yml`;
  pinned-source reads of `actions/upload-artifact` v7.0.1 (`action.yml`,
  `src/shared/search.ts`) and `actions/toolkit` glob traversal; the K1
  empirical probe; sandbox symlink repros; baseline gates green at `ad76345`.
