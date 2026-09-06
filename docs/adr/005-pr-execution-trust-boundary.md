---
id: 005-pr-execution-trust-boundary
status: accepted
created: 2026-09-06
---

# 005 — The dogfood review runtime executes the code under review, and the boundary that holds is GitHub's

## Context

PR8 of the review-enforcement hardening program asks what the review runtime
actually executes on a pull-request event in this repository's dogfood, and
requires the answer to end in a decision — migrate the dogfood to a
pinned-release runtime, or record an explicit accepted risk with a follow-up
issue. No silent risk (`docs/audit/review-enforcement-audit.md`, §7.3 and
§10 PR8).

The evidence, from `.github/workflows/review.yml` on `main` (as PR5 left
it):

- **Trigger.** `pull_request` with types `opened, synchronize, reopened,
ready_for_review` — never `pull_request_target`, never `workflow_dispatch`
  (`review.yml:47-53`).
- **Checkout.** `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`
  (a full-commit pin) with `persist-credentials: false` and `fetch-depth: 1`
  (`review.yml:91-94`). Under `pull_request` the action's default ref is
  GitHub's merge preview, `refs/pull/N/merge`.
- **The runtime is the merge preview.** The action is invoked as
  `uses: ./review` (`review.yml:97`), resolved from that same checkout, and
  `review/action.yaml` declares `runs: using: node24` with
  `main: src/index.mjs`. Every byte the run executes — every ceiling, guard
  and sanitiser in it — is therefore the pull request's own. The workflow
  says so itself (`review.yml:40-45`): "a pull request is reviewed by
  exactly the code it carries", with "a same-repo branch [running] its own
  review code with the LLM gateway key in reach. Here that means a
  maintainer's own push."
- **Credentials and bounds.** `github-token: ${{ secrets.GITHUB_TOKEN }}`
  and `api-url`/`api-key` from `ECOMA_LLM_BASE_URL`/`ECOMA_LLM_API_KEY`
  (`review.yml:99-101`), under a workflow-level `permissions: read-all`
  floor (`review.yml:61`) that the job's block replaces rather than widens
  (`review.yml:81-86`) — `contents: read`, `pull-requests: write`,
  `checks: write` and, since PR5, `security-events: write` and
  `actions: read` for the Code Scanning upload — beside a
  per-pull-request `concurrency` group (`review.yml:65-67`). Live mode:
  `dry-run: "false"`, `gate-mode: "observe"` (`review.yml:103-110`).
- **Write surface.** One upserted marker comment guarded by a
  pre-publication re-read of state and head, a `neutral` `review gate`
  check run, and the run artifact uploaded from the workspace — plus, only
  after a published review, the SARIF upload to Code Scanning
  (`review.yml:121-126`: gated on the run's `sarif-path` output, published
  runs only, confirmed findings only, an explicit `review` category,
  pinned `tag@digest`). `contents` stays read-only, so the job's token can
  write no commit, ref, release or setting.
- **What a pull-request author can steer.** The executed runtime itself
  (any file under `review/` in the merge preview), the reviewed bytes — the
  working tree is the review subject — and the pull request's title and
  body, both untrusted data by the third ceiling. What the released runtime
  keeps out of a pull request's reach is the policy: `config-path` resolves
  `.github/action-agents/review/review.json5`/`.json` from the base branch
  at an immutable commit SHA, and "a pull request cannot edit the policy
  that governs it" (SECURITY.md, "`pull_request` and
  `pull_request_target`").
- **Two platform facts complete the boundary.** First, a `pull_request`
  run takes its workflow definition from the merge ref — the property
  `pull_request_target` trades away when it runs the base repository's
  workflow, the "pwn request" line SECURITY.md warns about — so a same-repo
  pull request can rewrite the workflow itself, its permissions block, and
  its secrets references for its own run. Second, a fork's pull request
  executes the same PR-carried code with no secrets and a read-only
  `GITHUB_TOKEN`: GitHub-enforced, independent of this repository's code.
- **The trade is not review's alone.** `triage.yml` runs `./triage` under
  `pull_request` ("the residual exposure is a same-repo branch, which here
  means a maintainer's own push") and `harmonise.yml` runs `./harmonise`
  with a GitHub App token whose grant exceeds the permissions block by
  design — the block binds only `GITHUB_TOKEN`.

The decisive observation sits in SECURITY.md's own framing of the ceilings:
"each is enforced in code rather than asked for in a prompt". A pull request
that replaces the code replaces the ceilings. What bounds a replaced runtime
is only what the platform bounds.

## Decision

1. **Accepted risk, recorded rather than migrated.** The dogfood stays
   `uses: ./review` under `pull_request`. The residual risk, stated so a
   maintainer can refuse it: anyone who can push a branch to this
   repository — today, the single maintainer — can raise a pull request
   whose merge preview executes arbitrary code on the Actions runner with
   the job's `GITHUB_TOKEN` granted `contents: read`, `pull-requests:
write`, `checks: write`, `security-events: write`, `actions: read`, and
   — because the run takes its workflow definition from the merge ref —
   any repository secret that branch's
   workflow names: today `ECOMA_LLM_BASE_URL`, `ECOMA_LLM_API_KEY`,
   `ECOMA_APP_ID`, `ECOMA_APP_KEY`, plus the job-scoped runner environment
   GitHub always gives a run. Worst case: those secrets exfiltrated to a
   host of the author's choosing, comments, check runs and Code Scanning
   uploads forged within the token's grants, the ephemeral hosted runner
   abused — never a contents write, a release or a settings change with
   `GITHUB_TOKEN`, since
   `contents` stays read-only, and a fork's pull request reaches none of
   it. The action's ceilings do not bound this case — they are enforced by
   the code the pull request carries — so the accepted controls are
   GitHub's (`pull_request`, never `pull_request_target`; fork token and
   secret rules; hosted-runner isolation) plus this repository's
   collaborator policy, which makes the residual "a maintainer's own
   push", exactly as `review.yml`'s header states it.
2. **Why a pin does not close it.** The actor a pinned-release runtime
   would defend against — a write collaborator pushing a hostile branch —
   can, in that same branch, rewrite `.github/workflows/review.yml` itself
   (the merge-ref definition), point `uses:` anywhere, and name any
   repository secret. A pin defends against accidental drift of the
   runtime, a review-quality concern the normal pull-request review already
   owns; it is not a privilege boundary, and recording it as one would be
   the silent risk the audit forbids. For genuinely untrusted contexts — a
   fork's pull request — the exposure is already the platform floor every
   repository accepts by running tests on pull requests: PR-carried code on
   an ephemeral hosted runner with no secrets and a read-only token, where
   a pinned runtime processing the same untrusted bytes would change
   nothing. And the dogfood is the point: "a pull request is reviewed by
   exactly the code it carries" is the feedback loop that exercises review
   changes on real pull requests before release; a pinned runtime reviews
   every pull request with the previous release and the loop is gone.
3. **Compensating controls already in place.** `pull_request` only —
   SECURITY.md documents the `pull_request_target` line these workflows
   stay behind; a `read-all` permissions floor whose job-level block is
   stated, not inherited — `contents` read-only, PR5's `security-events`
   and `actions: read` scoped to the Code Scanning upload they serve;
   `persist-credentials: false` on the checkout and, in the released
   runtime, the `.git` refusal of the fourth ceiling; a code-pinned write
   surface (one guarded marker comment, a `neutral` observe check run, a
   workspace artifact) and a per-pull-request concurrency group; policy
   resolved from the base branch at an immutable SHA. The five ceilings and
   the run contract bind the released runtime — the one consumers run.
4. **Re-open conditions.** The acceptance is pinned to today's posture;
   when one of these turns true, the migration below is the fix, not a
   fresh acceptance (tracked in #386): the write-collaborator set grows
   beyond the single maintainer; the repository starts holding secrets
   whose compromise outlives rotation; the dogfood moves the `review gate`
   to `gate-mode: required` on a ruleset-protected branch; GitHub changes
   fork token or secret semantics in a way that weakens the floor.
5. **The migration, sketched for that day and not applied** — PR8 is
   docs-only by the program's freeze (#386 carries it as the follow-up):

   ```yaml
   # .github/workflows/review.yml — the action step
   - id: review
     # the uses: line pins the released review action by its full
     # 40-character commit SHA (was: uses: ./review)
     with:
       github-token: ${{ secrets.GITHUB_TOKEN }}
       api-url: ${{ secrets.ECOMA_LLM_BASE_URL }}
       api-key: ${{ secrets.ECOMA_LLM_API_KEY }}
       model: review
       dry-run: "false"
       gate-mode: "observe"
   ```

   The checkout step stays — the working tree is the review subject, not
   the runtime — and so does the Code Scanning upload step, which already
   pins a third-party action and reads `steps.review.outputs.sarif-path`;
   the re-pointed step keeps `id: review` for exactly that reason. The
   re-pointed `uses:` value is the released action,
   `ecoma-io/action-agents/review`, with the release's full 40-character
   commit SHA after the at-sign — a full commit SHA, never a floating tag
   (SECURITY.md, "Verifying what you are running"): the day this migration
   reviewed-exact-bytes matters. Pair it with a scheduled or dispatched
   head-dogfood workflow on `main` that keeps running `./review` in
   dry-run, so unreleased code is still exercised before release. The same
   shape migrates `triage.yml` and `harmonise.yml`.

## Consequences

- No runtime behavior changes with this record: no `.mjs`, `.yml` or
  `action.yaml` file is touched. The workflows read exactly as before;
  what changes is that the trade they make is a decided, numbered position
  instead of dogfood folklore.
- The ceilings continue to be judged as code — they bound the released
  runtime consumers run, and the hardening program's tests and fixtures
  keep proving them there. This record does not weaken any of them; it
  declines to claim them where they cannot hold, at the merge preview.
- The audit stays as the historical record with a one-line pointer at
  §7.3; #386 owns the re-open conditions and the migration sketch. When a
  condition turns true, the fix lands as a workflow change judged by the
  normal process, not as an edit to this record.

## Landing

Landed as PR8 of the review-enforcement hardening program: this record, the
`(audited: ADR 005)` pointer in
`docs/audit/review-enforcement-audit.md` §7.3, and follow-up issue #386
carrying the re-open conditions and the migration sketch. Merges after
PR1–PR7 in the program's order.
