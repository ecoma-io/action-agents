---
id: 006-code-scanning-merge-enforcement
status: accepted
created: 2026-09-07
---

# 006 — Merge enforcement is GitHub's decision, made over review's Code Scanning projection

## Context

The review gate (#362) gave a review's canonical result a merge consequence:
a deterministic `PASS`/`BLOCK` verdict landed as a `review gate` check run,
`gate-mode` chose whether it enforced, and a branch ruleset could make the
check required. The hardening program proved the gate enforceable — the
`fail` arm (#384), terminal check runs (#390), the verdict law (#410), the
required-mode rollout (#397) — and in doing so recorded the architecture's
own costs:

- A required custom check run is the highest-value forged artifact an action
  run can produce. ADR 005's re-open condition 3 fired the moment the
  dogfood pinned `gate-mode: required` on a ruleset-protected branch; the
  acceptance was retained, with eyes open, in that record's addendum.
- A required check is merge-queue poison unless the workflow that reports it
  also runs on group heads: #412's deadlock stalled four queue entries and
  was answered with a neutral skip check — a workaround, not an authority.
- One action was carrying three judgments with three different owners:
  review correctness (is the claim a confirmed finding — code, from
  evidence), review completeness (did the run read what it judged — code,
  from the coverage ledger), and merge enforcement (what blocks a merge —
  properly a repository's own protection surface).

One day after v0.11.0 shipped, the dogfood's `main` ruleset returned its
required checks to `ci-gate` and `analysis-gate`. The platform posture this
record regularises already holds on GitHub; what remained was the code, the
contracts and the docs.

## Decision

1. **Review produces; GitHub disposes.** The canonical review result stays
   the single source of truth review projects from
   ([ADR 004](004-canonical-review-result.md) — decisions 1–3, 5 and 6
   stand). Its consequence surfaces are the comment, the run artifact and
   the SARIF/Code Scanning projection. Review declares no merge consequence
   of its own: no `gate-mode` input, no `gate-verdict` output, no check
   run, and no `checks: write` in its permission needs.
2. **Merge enforcement is the consumer's ruleset, over Code Scanning.** A
   repository that wants confirmed findings to block merges points its Code
   Scanning protection rules (or its ruleset's code-scanning requirement) at
   the `upload-sarif` step the consuming workflow already runs —
   `category: review`, confirmed findings only, byte-identical for the same
   canonical record. Thresholds, per-tool scoping and alert dismissal are
   that ruleset's vocabulary, never an input of this action. A repository
   that opts out still gets the visibility: the alerts exist in the
   Security tab either way.
3. **Completeness is recorded, never enforced at a merge.** The verdict law
   is untouched: `mayPublish && coverageComplete`, and `unknown` and `fail`
   never pass. An incomplete review publishes its `fail` through every
   surface review owns — the canonical record, the partial comment posture,
   the run artifact — and no surface of review calls it clean. Code Scanning
   sees confirmed findings only, so it neither sees nor enforces
   completeness. Emitting a synthetic "incomplete review" result into SARIF
   was considered and rejected: it would re-conflate the two judgments and
   rewrite the projection's confirmed-only law.
4. **Review does not run for merge groups.** The `merge_group` trigger, the
   merge-group skip record family and the neutral check on group heads are
   deleted. A `merge_group` event that still reaches the action is an
   unsupported event — a typed refusal, no write. Required merge validation
   belongs to the workflows that carry required checks (`ci.yml` and
   `analysis.yml` on the dogfood); the merge queue needs nothing from
   review.
5. **The model never decides a consequence — unchanged, and now the whole
   story.** Consequences are code-owned from the canonical record: the
   recorded verdict and the SARIF projection. SECURITY.md's fifth ceiling is
   re-anchored on that pair; the gate policy vocabulary (`blockKinds`,
   `blockUnresolved`, `GatePolicyError`) is retired with the module that
   defined it.

## Consequences

- **Breaking, deliberate, no shim.** `gate-mode` and `gate-verdict` leave
  `review/action.yaml`. A consumer whose ruleset requires the `review gate`
  check must drop the requirement — the check no longer exists — and, if it
  wants findings to block merges, add the Code Scanning requirement instead.
  The one known consumer, this repository, migrates in the same change;
  the release notes carry the steps.
- **`unresolved` findings stop being merge-blocking.** The gate's default
  policy blocked them; SARIF publishes `confirmed` only. They remain
  recorded in the comment and the artifact.
- **A no-findings or incomplete run is indistinguishable from clean to Code
  Scanning.** That is decision 3 holding: enforcement attaches to findings,
  and only review's own surfaces speak about completeness. A consumer who
  wants "a review ran and completed" as a merge condition will not find it
  here — that is a required check on their own validation workflow, and this
  action deliberately does not provide it.
- **The forge surface shrinks by one operation.** `createCheckRun` and the
  `CHECK_RUN_CONCLUSIONS` vocabulary are removed;
  `listCheckRuns` stays — triage's advisory rollup reads it.
- **The reviewer-capacity signal changes shape.** The enforcement audit's
  coverage-capacity risk (multi-file diffs degrading reads) was surfaced by
  BLOCK evidence; it now surfaces as the recorded `fail` verdict, the
  comment's partial posture, and the loop's uncovered-files feedback
  (#424) — never as silence in review's own surfaces.
- **[ADR 004](004-canonical-review-result.md)'s decision 4 is superseded in
  part** — its check-run landing; its "incomplete never passes" law stands,
  restated in decision 3. [ADR 005](005-pr-execution-trust-boundary.md)'s
  fired re-open condition 3 is resolved by this removal: the forged-check
  value the condition warned of is gone rather than accepted. #386 re-audits
  the accepted risk against the smaller write surface.

## Landing

Landed as the contract-first commit of the gate-retirement migration (#436):
this record; the run contract's rewrite (the gate-surfaces paragraph, the
merge-group outcome row, the projection lists, the verdict-as-recording
statement); ADR 004's superseded-in-part banner; ADR 005's second addendum.
Live record at landing, read from the GitHub API on 2026-09-07: the `main`
ruleset requires `ci-gate` and `analysis-gate` and carries a code-scanning
requirement over CodeQL and Semgrep OSS at the `errors` threshold;
review's `category: review` upload path is in history — three live analyses
under tool `ecoma-io/action-agents/review`, all from 2026-09-07, each an
empty analysis (`result_count: 0`, `rules_count: 0`), the no-findings shape
decision 3 predicts — but no review analysis has yet carried a finding, so
the finding→alert lifecycle a confirmed finding would ride is exercised by
tests, not yet by history, and verifying it stays part of the migration
rather than an assumption.
