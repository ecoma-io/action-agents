# Batch-1 second-order adversarial review

**Refs #122**

This report documents the second-order adversarial review of the `ecoma-io/action-agents`
repository at `origin/main` (c3b70b99e4122569a955f6bcf66be75013ef9ef6). It is the
follow-up to the first-order findings in issue #122's four track comments — every
finding below was discovered after the first-order fixes (#160–#170) and subsequent
refactors (#186, #188, #190, #191, #193, #194, #195, #197, #198, #199, #200, #202, #203)
landed.

The review ran four parallel scout subagents, one per track, reading every module
affected by the recent changes. Each finding below is classified as OBSERVED
(deterministic from cited lines) or INFERRED (needs interleaving/scale to confirm).

---

## Per-track findings

### Track (a) — Review engine

2 real defects, 3 hygiene findings.

#### A1 — DEFECT: `nothingToReview` loses the applicability classification record

**OBSERVED** — `review/src/run.mjs:290-291`, `883-923`

When the applicability policy is active and the inventory is empty (all files
ignored by `ignore` config), the `nothingToReview` path at line 291 is called
without the `applicabilityFact` that was computed earlier at line 224. The
function at line 883 accepts only `{ pullRequestNumber, headSha, io, dryRun,
startedAt }` — no applicability parameter. The returned result lacks an
`artifact` property, so no applicability section is recorded.

**Failure scenario:** A consumer configures the applicability policy and an
`ignore` rule that catches every changed file (e.g. `ignore: ["*"]` for a
specific subdirectory). The run skips silently: the log says "universe empty"
but there is no record of the applicability decision that preceded the skip.

**Canonical issue:** #206 — fixed by #213 (`c00fd9c`).

#### A2 — DEFECT: `lanesAssigned` is always `true`, masking a validation gap

**OBSERVED** — `review/src/loop.mjs:164-165`

The `phaseContext()` function hardcodes `lanesAssigned: true` at line 165.
This value is consumed by `oriented()` at `phases.mjs:259-261` as a condition
for exiting the orient phase. Because it is always true, the orient phase
becomes exit-eligible after one reading turn regardless of whether lanes were
actually assigned. If a future code path forgets to assign lanes before the
loop, the phase machine will not catch it.

**Failure scenario:** A refactor that removes or delays lane assignment would
not be detected by the phase machine — the orient phase would still advance to
investigate after one turn, and the model would receive unrestricted tools
without the lane budget constraints the code intended.

**Canonical issue:** #208 — fixed by #213 (`c00fd9c`).

#### A3 — HYGIENE: `phases.mjs` mirrors (does not import) the coverage gate's conclusion logic

**OBSERVED** — `review/src/phases.mjs:244-249` vs `review/src/coverage.mjs:258-260`

Both `concludeReachable()` and `canConcludeReview()` implement the same
condition: `policy !== "high" || uncovered.length === 0`. The phase machine
copies the coverage gate's logic instead of importing it. A future change to
the conclusion rule (e.g. adding a "medium-high" strictness level) would need
to find and update both sites.

#### A4 — HYGIENE: Applicability fact is not recorded in the run artifact's provenance section

**OBSERVED** — `review/src/artifact.mjs:1079-1091`

The `withCommentId()` function attaches only `commentId` to the provenance
section. The applicability context (`automation`, `maintainer`, `external`)
is recorded in the `applicability` fact section but is absent from
`provenance`. Post-run analysis tools reading the provenance section alone
cannot tell which execution context the review ran under.

#### A5 — HYGIENE: `writeRunArtifact` catch block silently downgrades `published` to `published-without-artifact`

**OBSERVED** — `review/src/index.mjs:173-184`

When the artifact file write fails after a comment was published, the catch
block at line 173 changes `result.outcome` from `"published"` to
`"published-without-artifact"` and logs the failure. The comment stands but
the artifact is permanently lost. This is a documented design tradeoff
(`docs/development/review.md:985-987`), but the outcome string
`"published-without-artifact"` is a single nonstandard value among the
standardised outcomes, creating a caller-surprise surface.

---

### Track (b) — Harmonise

0 findings. All modules clean.

The advisory-file suffix implementation (#202) is consistent across read and
write paths with a correct one-cycle legacy fallback. The `protect.mjs` /
`protection.mjs` split is a genuine separation of concerns (document-level
content protection vs manual-edit protection policy), not dead code or
duplication. All six baseline fixes (#162, #165, #166, #167, #168) landed
correctly with proper test coverage. No second-order regression was found
between suffixed advisory files and the path-independent pure modules
(`drift.mjs`, `stale.mjs`, `threeway.mjs`, `fingerprint.mjs`).

**Verified clean** (key areas):

- `harmonise/src/state.mjs` — suffixed path, legacy fallback ordering, corrupt
  degradation to null (advisory, never blocks)
- `harmonise/src/tm.mjs` — suffixed path, unbounded store (#167), `keepKeys`
  bounds the published file
- `harmonise/src/index.mjs` — writes suffixed files, optimistic lock on
  `upsertBranch`, pool error mapping
- `harmonise/src/protection.mjs` — fail-closed policy table
- `harmonise/src/protect.mjs` — content protection, imported by `plan.mjs` only
- `harmonise/src/recovery.mjs` — total over all inputs, refuses malformed
  overrides (#168)
- Tests: suffixed path reads/writes, legacy fallback, corrupt degradation

---

### Track (c) — Core + artifact

1 hygiene finding. All fixes verified clean.

**Verified clean:**

- `core/transport/http.mjs` — retryable body cancel (#168), per-attempt
  `AbortSignal.timeout()` (#108), typed 404 detection (#169)
- `core/src/transport-errors.mjs` — re-export shim, single door for actions
- `core/src/forge.mjs` — `upsertBranch` re-read before force-PATCH (#166),
  `removeLabel`/`deleteComment` `maxAttempts:1` (#194)
- `core/src/comment.mjs` — marker upsert with dedupe
- `review/src/artifact.mjs` — `assertFreshArtifact` pre- and post-comment
  freshness guard (#160)
- `core/src/order.mjs` — `utf8Compare` using `Buffer.compare` (#170)
- `package.json` imports field — correctly maps `#core/*` and `#core-transport/*`

#### C1 — HYGIENE: Stale `core/src/http.mjs` references in development docs

**OBSERVED** — The transport-seam consolidation (#199) moved the HTTP client
from `core/src/http.mjs` to `core/transport/http.mjs`, but three development
documentation files still reference the old path:

| File                            | Lines          |
| ------------------------------- | -------------- |
| `docs/development/harmonise.md` | 32, 735        |
| `docs/development/review.md`    | 284, 1027–1028 |
| `docs/development/triage.md`    | 40             |

These are prose citations describing the timeout/retry architecture. The
`check-docs-links` tool does not flag them (no `docs/` prefix), but the
citations are stale and will confuse readers.

---

### Track (d) — Workflows + security

1 hygiene finding (same stale doc references as Track C). All fix PRs verified
clean.

**Verified clean:**

- `triage/src/index.mjs` — triage marker declared and reconciled, clear-marker
  logic verifies universal category before removal (#191)
- `core/src/forge.mjs` — `removeLabel` (line 541) and `deleteComment`
  (lines 607, 642) pin `maxAttempts: 1`, preventing DELETE replay (#194)
- `SECURITY.md` — App-token attribution correctly documented (#193), workspace
  confinement, all four ceilings stated
- `.github/workflows/triage.yml` — `pull-requests:write` documented as
  load-bearing (#171)
- `.github/ISSUE_TEMPLATE/question.yml` — correctly carries `needs triage`
  label
- `core/transport/http.mjs` — preserves retryable body cancel and per-request
  `maxAttempts` override (#168)

---

## Re-verification of first-order fixes

Every first-order fix PR (#160–#170) and the fixes that landed in subsequent
PRs (#186, #188, #190, #191, #193, #194, #202) was re-verified against current
code:

| PR        | Fix for                               | Status                        |
| --------- | ------------------------------------- | ----------------------------- |
| #160      | Freshness guard — assertFreshArtifact | Verified                      |
| #161      | Nothing found                         | Verified                      |
| #162      | Recovery policy                       | Verified                      |
| #163      | State skip                            | Verified                      |
| #164      | Preserve-required routing             | Verified                      |
| #165      | Advisory file path                    | Verified (superseded by #202) |
| #166      | upsertBranch re-read                  | Verified                      |
| #167      | TM max entries                        | Verified                      |
| #168      | Retryable body cancel                 | Verified                      |
| #169      | Typed 404                             | Verified                      |
| #170      | Byte-wise sort                        | Verified                      |
| #186      | Workspace canary                      | Verified                      |
| #188      | Post-publication write failure        | Verified                      |
| #190      | Read ledger by resolved path          | Verified                      |
| #191      | Triage label lifecycle                | Verified                      |
| #193      | App-token attribution                 | Verified                      |
| #194      | DELETE maxAttempts:1                  | Verified                      |
| #195–#200 | Applicability policy                  | Verified                      |
| #202      | Advisory-file suffix                  | Verified                      |
| #203      | Dedupe refactor                       | Verified                      |

All 21 fix/refactor PRs land correctly at current HEAD. No first-order finding
was re-exposed.

## Disposition

All findings in this report shipped with their fixes in the same batch,
issued and closed together in the tracker:

| Finding                                                              | Issue | Fix              |
| -------------------------------------------------------------------- | ----- | ---------------- |
| A1 — `nothingToReview` loses the applicability classification record | #206  | #213 (`c00fd9c`) |
| A2 — `lanesAssigned` is always `true`, masking a validation gap      | #208  | #213 (`c00fd9c`) |
| A3/A4/A5 — review-engine hygiene                                     | #210  | #213 (`c00fd9c`) |
| C1 — stale `core/src/http.mjs` references in dev docs                | #211  | #213 (`c00fd9c`) |

As of this page's current state on `main`, no finding here is unfiled and
none is unfixed. The two DEFECT findings (A1, A2) and the C1 hygiene item
were filed as canonical issues and closed by the fix PR; the remaining
hygiene items (A3, A4, A5) were filed and fixed together with them.

---

## Methodology

Four parallel scout subagents (one per track) read every module affected by the
recent changes at `origin/main` (c3b70b9). Each scout received:

1. A shared brief (`local://review-brief.md`) listing every first-order finding
   and its disposition, to prevent re-reporting known issues
2. A per-track file list and second-order focus areas
3. An output format specifying `id`, `title`, `classification` (OBSERVED/INFERRED),
   `evidence` (file:line), `failure scenario`, `canonical issue`, and
   `verified-clean` list

Findings were cross-referenced against the issue tracker before inclusion. No
finding in this report is a duplicate of a first-order finding from issue #122
or any existing canonical issue.

---

## Summary

| Track                    | Defects | Hygiene | Clean       |
| ------------------------ | ------- | ------- | ----------- |
| (a) Review engine        | 2       | 3       | —           |
| (b) Harmonise            | 0       | 0       | All modules |
| (c) Core + artifact      | 0       | 1       | All fixes   |
| (d) Workflows + security | 0       | 1       | All fixes   |
| **Total**                | **2**   | **5**   | —           |

The two defects (A1, A2) are in the review engine's recently landed
applicability and phase-machine features — areas with the most new code.
No regression was found in the harmonise advisory-file suffix, the transport
seam, the workflow permissions, or the security boundaries.
