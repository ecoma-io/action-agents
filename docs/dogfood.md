# Internal dogfood rollout

Three repositories of the organisation are about to run these actions against
their own issues and pull requests, on the released 0.11.2 line. This page is
the runbook for that rollout: which actions go where and why, the exact
workflows, the configuration each target starts with, what a run's record tells
you, the numbers that decide whether the rollout continues, and what stops it.

It is written against this repository at the 0.11.2 release. Every claim it
makes about the actions is checkable in that tree: the inputs against each
`action.yaml`, the ceilings against `SECURITY.md` at the repository root, the
terminal states, verdicts, failure classes and records against the
[run contract](run-contract.md). The per-action guides —
[`triage`](guides/triage.md), [`review`](guides/review.md),
[`harmonise`](guides/harmonise.md) — carry the full input and config surface
and are not repeated here.

- [Targets](#targets)
- [Refs and secrets](#refs-and-secrets)
- [Workflows](#workflows)
- [Configuration](#configuration)
- [What a run tells you](#what-a-run-tells-you)
- [Success criteria](#success-criteria)
- [Rollout order and first-run verification](#rollout-order-and-first-run-verification)
- [Incident rules](#incident-rules)
- [The rollout checklist](#the-rollout-checklist)

## Targets

| Repository                                         | Primary surface                                                            | `triage` | `review`      | `harmonise` |
| -------------------------------------------------- | -------------------------------------------------------------------------- | -------- | ------------- | ----------- |
| [`ecoma-io/loom`](#ecoma-ioloom)                   | Vue 3 / TypeScript UI system and composition library                       | yes      | yes           | no          |
| [`ecoma-io/archkeep`](#ecoma-ioarchkeep)           | npm-published module-boundary governance tool, polyglot                    | yes      | yes           | no          |
| [`ecoma-io/release-craft`](#ecoma-iorelease-craft) | Release automation (packaging, versioning, changelogs), under construction | yes      | not initially | no          |

`ecoma` and `dot-github` are out of scope for this rollout and are not
discussed further here.

**`harmonise` is deliberately not configured on any target.** None of the three
targets is multilingual: none carries a translated documentation mirror, so a
harmonise run would have no translatable pair to keep in step. The only
harmonise deployment in the organisation remains this repository's own weekly
self-hosted run (`.github/workflows/harmonise.yml` here), which is the
production surface the rollout observes as a baseline — not a target. If a
target ever grows a second-language mirror, that is a new rollout decision, not
an edit to this one.

### `ecoma-io/loom`

The most active of the three (assumption): a Vue 3 / TypeScript component and
composition library with Tailwind and design tokens. Both actions apply —
`triage` because issue inflow is the highest of the three (assumption), and
`review` because pull request volume justifies it (assumption) and the surface
(accessibility, token contracts, composition API) rewards a reviewer that reads
the diff rather than the title.

Expected event volume, as assumptions — refreshed with the first observed
numbers at the day-7 audit, closed at the day-30 review: roughly 10–20 issues
and 15–30 pull requests per month.

Risk notes: highest cost exposure of the three (volume × model calls), and the
largest noise surface if a live run misbehaves — which is why loom starts in
dry-run and flips last among the write surfaces. Component-library diffs
include generated or near-generated files (assumption); if capacity refusals
appear, the `ignore` set, not the budget, is the first lever.

### `ecoma-io/archkeep`

The npm governance tool whose verdicts gate every repository in the
organisation. A defect here propagates, so `review` earns its cost despite a
modest volume (assumption: 5–10 issues, 10–15 pull requests per month).

**Its issue forms and the sheet share a label — a known collision, resolved
before the sheet goes live, not after.** Archkeep's `bug` issue form applies
the `bug` label (assumption — read `.github/ISSUE_TEMPLATE/*.yml` to confirm),
and `bug` is one of the four labels the starter sheet below declares. The
collision is not cosmetic: the triage policy holds single-valued roles to one
label per thread across the thread's _existing_ labels and the assessment
together, so a bug-form issue that arrives already carrying `bug` and is then
classified by the model into a different category of that role is refused as a
red run — no mutation, but a refusal the sheet itself manufactured, inflating
the refusal-rate row below. The day-7 audit resolves the ownership before
phase 2 goes live: read the forms' actual `labels:` entries, then either drop
`bug` from the sheet (the form keeps it; the model never offers it) or remove
the label from the forms (the sheet owns it). One owner per label; the audit
records which way it went.

Risk notes: low volume means slow signal accumulation — judge archkeep on
verdict quality per run, not on weekly counts. Review findings here are
likely to be architecture-sensitive; treat sustained high dismissal rates as a
rubric problem, not a reviewer problem.

### `ecoma-io/release-craft`

Under construction, not adopted anywhere yet. `triage` applies and doubles as
the cheapest live validation of the plumbing: labels notify nobody and are
reversible in one click. `review` does **not** start here — the pull request
stream is the maintainer's own scaffolding (assumption: 2–4 issues and 2–4
pull requests per month), so agent review is cost without readership. The
criterion to add it: sustained merged-pull-request rate above ~8 per month or
a second contributor. Until then the review section of this page does not
apply to release-craft.

Risk notes: earliest-stage codebase; mislabels are low-consequence, which is
exactly why it is safe to let triage go live here first.

## Refs and secrets

**Refs.** Production dogfood pins the **released exact tag**, never `@main` and
never a floating tag: `ecoma-io/action-agents/<action>@v0.11.2` — where
`v0.11.2` stands for **the released version** the rollout rides. Every
`uses:` line below carries a `# roadmap ref` comment until that tag exists;
it is inert YAML and may be dropped at paste time. Floating tags
(`@v0.11`) deliver patches automatically, which is right for a mature
adoption and wrong for a first rollout: the operator should know which bytes
run before any of them do. When action-agents releases again and the rollout
adopts the fix, the flip is a deliberate re-pin (see
[Incident rules](#incident-rules)) — never an accident of a moving tag.

**Secrets.** Two organisation-level secrets, already available under the same
names in every target repository — no per-repo secret creation is needed:

- `ECOMA_LLM_BASE_URL` — the OpenAI-compatible endpoint, passed as `api-url`;
- `ECOMA_LLM_API_KEY` — its key, passed as `api-key`.

This is the same wiring this repository's own dogfood workflows use
(`.github/workflows/triage.yml`, `review.yml`, `harmonise.yml` here). The model
ids are literal per-action names (`triage`, `review`) because the gateway route
serves one model per action; that the same routes resolve for the targets is an
**assumption** carried by the first run — a run that refuses or fails on
the model name names it in the record's `reason`.

**Token.** `secrets.GITHUB_TOKEN`, not an App token, on both actions. Neither
action's writes start workflow runs (labels, comments), so GitHub's recursion
suppression costs nothing; the App-token machinery in this repository's
`harmonise.yml` exists only because harmonise opens pull requests, and
harmonise is not in this rollout.

## Workflows

One workflow per (repo, action) pair, below. Conventions, all copied from this
repository's own dogfood workflows at the 0.11.2 tag, which are the live
reference:

- Third-party actions are pinned `tag@digest` (`actions/checkout`,
  `actions/upload-artifact`); Renovate keeps the digest pairs current in this
  repository's workflow files. **Copy the pins from the released tag's
  `.github/workflows/*.yml` at deploy time** rather than from this page — the
  page may lag a Renovate bump.
- Every terminal that declares a record is uploaded, with
  `include-hidden-files: true` (the record directories are hidden by design;
  upload-artifact prunes hidden files by default and would match zero files
  while reporting success) and `if-no-files-found: warn` (a declared write that
  lands nowhere must be loud, not green over nothing).
- Dry-run is set **explicitly**, never left to the default, so the flip to live
  is a visible one-line diff in the target's git history.

The snippets are written for the named targets but differ only in comment
text — the `triage` workflow is identical on all three targets, and the
`review` workflow is identical on loom and archkeep.

### `triage` — one workflow, all three targets

```yaml
name: Triage

on:
  issues:
    types: [opened, edited, reopened, labeled]
  pull_request:
    types: [opened, edited, synchronize, ready_for_review, reopened, labeled]

permissions: read-all

concurrency:
  group: triage-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
      issues: write
      pull-requests: write
    steps:
      - uses: ecoma-io/action-agents/triage@v0.11.2 # roadmap ref
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          api-url: ${{ secrets.ECOMA_LLM_BASE_URL }}
          api-key: ${{ secrets.ECOMA_LLM_API_KEY }}
          model: triage
          dry-run: "true"

      - name: Upload the run record
        if: always()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: triage-run-record
          path: .triage-record/triage-record-*.json
          include-hidden-files: true
          if-no-files-found: warn
```

Why it looks the way it does, and where it differs from this repository's own
`triage.yml`:

| Choice                                                                                         | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow-level `read-all`; job-level `contents: read`, `issues: write`, `pull-requests: write` | The same grants this repository's own triage workflow holds, arranged like the review workflow's: a job-level block **replaces** the workflow-level one, so a job added later inherits read-only instead of silently widening. `pull-requests: write` is load-bearing even though triage only writes labels — GitHub refuses the issues-API label write on a pull request number without it. The dry-run phases hold these write grants without exercising them; the ladder below is why — the sheet can go live the moment its checklist passes, with no permissions diff riding along. |
| No `security-events`, no `actions` grants                                                      | Triage never touches them; a dogfood workflow that grants more than its action needs is a defect before it runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| No checkout step                                                                               | This repository's workflow checks out only so the runner can find the action at `./triage`; a target references the released action by ref, and triage reads everything through the API. One less thing in the workspace.                                                                                                                                                                                                                                                                                                                                                                |
| Triggers `issues` + `pull_request`                                                             | The action's event matrix re-triages `opened`, `edited`, `reopened`, `labeled` (queue-marker cases only) and `synchronize` / `ready_for_review` on pull requests, and skips the rest. There is no `workflow_dispatch` — the entrypoint refuses every event but these two (run contract F-01), and a dispatched run has no thread to classify. The first dry runs come from real threads: wait for the target's first real issue or pull request, or file a throwaway issue to produce one.                                                                                               |
| `ready_for_review` present                                                                     | A draft's flip to ready changes the evidence a classification rests on. This repository's own workflow omits it; the targets should not — drafts are expected in loom and archkeep (assumption).                                                                                                                                                                                                                                                                                                                                                                                         |
| Concurrency keyed on the thread, `cancel-in-progress: true`                                    | As in this repository's own workflow: a rapid edit sequence replaces the queued run instead of stacking classifications of stale text. The [`triage` guide](guides/triage.md#redelivery) recommends leaving it off for conservative adopters; the repair story (a run re-derives from live state, removals before additions) is what makes cancellation acceptable here.                                                                                                                                                                                                                 |
| `dry-run: "true"`                                                                              | The rollout's starting posture on every target. The flip to `"false"` is a deliberate step with its own checklist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Upload glob `.triage-record/triage-record-*.json`                                              | Triage has no per-file output; the glob is what this repository's own workflow uploads, with the two knobs above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Fork pull requests** end red by design: a fork's pull request carries
neither org secret nor a write token, so the run fails at startup — the
required `api-url` input is empty — and writes nothing. That is the guide's
documented posture for triage (fail loudly rather than run green over
nothing), and it is not an incident.

### `review` — loom and archkeep

```yaml
name: Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions: read-all

concurrency:
  group: review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          fetch-depth: 1

      - id: review
        uses: ecoma-io/action-agents/review@v0.11.2 # roadmap ref
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          api-url: ${{ secrets.ECOMA_LLM_BASE_URL }}
          api-key: ${{ secrets.ECOMA_LLM_API_KEY }}
          model: review
          dry-run: "true"

      - name: Upload the run artifact
        if: always() && steps.review.outputs.artifact-file != ''
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: review-run-artifact
          path: ${{ steps.review.outputs.artifact-file }}
          include-hidden-files: true
          if-no-files-found: warn
```

| Choice                                                                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow-level `permissions: read-all`, job-level explicit block          | As in this repository's own `review.yml`: a job-level block **replaces** the workflow-level one, so a job added later inherits read-only instead of silently widening.                                                                                                                                                                                                                                                             |
| `contents: read` + `pull-requests: write`, nothing else                   | The action's own needs: the working tree is the review's subject, and the one write is the marker comment. This is **one grant narrower** than this repository's own review job, which adds `security-events: write` for its SARIF upload step — a grant the action itself never needs. The targets start without the Code Scanning surface; adding it later means adding both the upload step and that grant, never either alone. |
| Checkout with `persist-credentials: false`, `fetch-depth: 1`              | Unlike triage, review's subject IS the working tree. No credential left in the workspace the checkout fills with pull-request content — under `pull_request` that content is untrusted input, and a fork's pull request gets neither secrets nor a write token, which is the arrangement `SECURITY.md` documents.                                                                                                                  |
| Triggers `[opened, synchronize, reopened, ready_for_review]`, no `edited` | As in this repository's own workflow: a re-worded description does not change the code under review. No `workflow_dispatch` exists — without a pull request there is nothing to review.                                                                                                                                                                                                                                            |
| Concurrency keyed on the pull request, `cancel-in-progress: true`         | A push sequence replaces the queued review instead of stacking reviews of stale heads.                                                                                                                                                                                                                                                                                                                                             |
| Upload path is the `artifact-file` output, not a glob                     | As in this repository's own workflow: the exact file the run declared, set on green runs and on the red boundary's record alike, and empty on terminals that declare none — which the `if` covers both ways.                                                                                                                                                                                                                       |

**Draft pull requests** end as recorded skips — review's skip family includes
draft runs — and the `ready_for_review` trigger is what starts the real review
when the draft flips.

### What is intentionally absent from every target workflow

- **No SARIF upload, no `security-events: write`.** The Code Scanning surface
  is this repository's own merge-enforcement story ([ADR
  006](adr/006-code-scanning-merge-enforcement.md)), and the dogfood there opts
  out of requiring the tool. The targets have no enforcement need during the
  rollout; the comment and the run artifact are the evidence. A target that
  later wants alerts in its Security tab adds the `upload-sarif` step gated on
  `steps.review.outputs.sarif-path != ''` plus `security-events: write` — both
  together, and pins `github/codeql-action/upload-sarif` by full SHA.
- **No App token minting.** Nothing the rollout's actions write needs to start
  a workflow run.
- **No `verify: true` on triage.** The second-look pass is opt-in and useful
  once the sheet is live; starting with it on muddies the read of what the
  decision pass alone does. It can be switched on at the same step the sheet
  goes live, or later.

## Configuration

The targets have no `.github/action-agents/` tree today. What each action
starts with, and what changes when that changes:

### `triage`: dry-run without a sheet first, then a sheet, then live

Phase 1 — **no config file at all.** With no sheet, triage's classification
has nowhere to go but a comment, which is the action's noisiest output; so
phase 1 never writes anyway (`dry-run: "true"`), and every decision lands in
the run record — the sheet-shaped `decision` block with its `add` / `remove`
kinds and sanitised `rationale` — plus the run log. Zero new labels, zero
commits to the target, zero writes; the rollout's first honest question (does
the model classify these threads sensibly?) is answered from records alone.

Phase 2 — **add the sheet, still dry-run.** One canonical starter, identical on
all three targets, at `.github/action-agents/triage/triage.json5` on the
target's default branch:

```json5
{
  schemaVersion: 2,
  labels: {
    use: ["bug", "enhancement", "documentation", "question"],
    roles: {
      bug: "semantic-classification",
      enhancement: "semantic-classification",
      documentation: "semantic-classification",
      question: "semantic-classification",
    },
    exclusive: ["semantic-classification"],
  },
}
```

Schema 2 is a policy, not a registry: GitHub is the source of truth for each
label's description, and **a label the config names must exist in the
repository or the run refuses at startup.** Creating the four labels on each
target is therefore part of the same step that commits the file — see the
[checklist](#the-rollout-checklist). No size ladder yet (the measured rungs add
`triageOwned` labels and a diff measurement the first phase does not need), no
`workflowMarkers` (a queue marker is a process commitment each target's
maintainer makes, not a rollout default), no `priority`, no instruction
documents.

Phase 3 — **go live** (`dry-run: "false"`). In sheet mode the write surface is
labels: add-only categories, plus — on issues only — one marked signal comment
when an issue is judged incomplete or a near-duplicate. Some labels are
applied **by code, never offered to the model**: `needsMoreInfo` (added when
the model judges the thread incomplete, but chosen by code), priority rungs
(severity answers mapped through the config's `priority` map), workflow
markers (cleared, not added). A **routing-area** label is the one partial
exception: the routing map applies it by code when an issue's form id matches,
but a routing-area label on the sheet is also an ordinary model choice — the
starter sheet declares none, so on this rollout every label the model can add
is a category. Nothing is closed, assigned or mentioned.

What a later config change means, so nobody re-litigates it mid-rollout:
adding `size` turns on diff measurement and size-label replacement; adding
`workflowMarkers` turns on marker clearing (and makes the `labeled` trigger
load-bearing); adding `instructions` attaches repository-written prose to the
prompt, capped at 8 KiB per document; the `labels:` workflow input can narrow
the sheet for one call site and can never widen it — and setting it with no
sheet on disk is a startup refusal, not an empty one.

### `review`: no policy file to start

Review runs without a config file on built-in defaults — strictness `medium`,
strategy `standard`, language `en`, `maxDiffLines` 5000, no `ignore` — and an
absent file is policy-empty for review, not a misconfiguration. That is the
honest baseline: the first question is whether the default reviewer's findings
are worth reading on this target, unconfounded by local rubric.

Add `.github/action-agents/review/review.json5` later, when the records say so
— `schemaVersion` must be `1` if present, and the keys that will actually
matter are:

- `ignore` — lockfiles and generated trees; the diff universe shrinks and
  capacity refusals fall with it;
- `maxDiffLines` — raise only as a measured capacity decision; past the budget
  the run is **refused** (red), never silently skipped — see
  [the semantics are frozen](run-contract.md#the-semantics-are-frozen);
- `applicability` — bot skips (`author.isBot`, GitHub-attested) when the target
  grows bot pull requests; a deliberate size skip only as a last resort, with
  the recipe's two caveats read first.

## What a run tells you

The [run contract](run-contract.md) is the constitution; this section is the
operator's extract of it. Every run ends in exactly one terminal state and
carries one verdict:

| State       | Meaning                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `published` | the run did what it set out to do and its writes landed                                               |
| `partial`   | some operations applied before the run stopped — recorded, never replayed                             |
| `refused`   | the action's own ceilings declined to act — off-sheet answer, capacity, a typed deterministic refusal |
| `abandoned` | a fresher state superseded this one; can follow a write, so state alone proves nothing                |
| `skip`      | nothing to do — dry-run, draft, eligibility rule, all-in-step                                         |
| `failed`    | a defect or environment break; the failure class names which                                          |

Verdicts (`review` only): `pass`, `fail`, `unknown`. A fresh run's code
assigns only the first two — `mayPublish && coverageComplete ? "pass" :
"fail"` — so a review a bound cut short publishes with verdict `fail` and the
bound named; `unknown` is reserved vocabulary a recovered record may carry,
never a fresh-run outcome, and it never passes wherever it appears.
`refused` is not `failed`: the first is the ceilings working, the second is a
defect. Conflating them is how red herrings enter this rollout's weekly read.

**Where the evidence lands.** Every terminal the actions declare writes one
machine-readable record inside the runner's workspace, and the workflow's
upload step publishes it as a workflow artifact (`triage-run-record`,
`review-run-artifact` on the targets; `harmonise-run-record` on the
self-hosted run). Two carve-outs are contracted, not bugs: a run that died
before it held the facts a record is built from (the entrypoint's input and
context reads), and a record whose own write failed — the first leaves no
file, the second is a logged loss that never relabels the terminal. Review
additionally embeds its canonical record in the published comment, and writes
its SARIF projection under the runner's temp directory — surfaced as
`sarif-path`, uploaded by a step the targets do not carry yet.

### `triage` — read the record

Fields to watch: `outcome`; `reason`; `decision` (`kind`, the `add` / `remove`
label lists with code-owned reasons, `refusals`, the sanitised `rationale`);
`policy` (`basis`, `branch`, `sha` — proving which sheet the run read);
`dryRun`; `verification` (empty unless the opt-in pass ran).

- **Healthy**: `published` runs whose `decision.add` names a sheet label and
  whose rationale matches the thread; `skip` runs on label-only events; the
  policy SHA matches the target's default-branch tip when the run started.
- **Degraded**: `refused` with off-sheet `refusals` (the sheet is too narrow —
  phase-2 material); `abandoned` (the thread moved mid-run — the freshness gate
  working, but frequent abandonment means the concurrency or the process is
  thrashing); `failed` with the truncation reason (`the provider truncated its
response (finish_reason: length)`) — expected exactly zero after #451, so
  any occurrence is a finding against action-agents, not against the target.

A dry run's record **is** the run's whole output — if the upload is missing,
the run is red or the record write failed; it is never green over nothing.

### `review` — read the artifact

The file name states the outcome before it is opened:
`review-artifact-<head>.json` (published), `-abandoned-`, `-dry-run-`,
`-skip-`, `-refused-<head>`, `-failed-<head>`; a run that died before
resolving a head writes `no-head` in the sha's place. Fields to watch: the
declared gates' outcomes —
conclusion, bound, coverage, provenance, verification, each recorded, a
missing fact a typed refusal; the coverage ledger (examined files vs changed
files); `applicability`'s execution context once a policy file exists.
A dry run writes the reduced `-dry-run-` artifact — `{schemaVersion,
repository, pullRequest, headRef, outcome}` (plus `applicability` once a
policy file exists) — nothing more: the gates' outcomes and the coverage
ledger appear in no dry-run record, and during a dry run that evidence
lives in the run log, which carries the comment the run would have
published. The verdict (`pass` / `fail` / `unknown`) is no artifact field
in any shape — it rides the published comment's embedded record, derived
from `gates` + `coverage` by the code's law (`mayPublish &&
coverageComplete`).

- **Healthy**: published comments whose verdicts are `pass` or an honest
  `fail` with the bound named (`max-turns reached`, partial coverage);
  skip records for drafts; red terminals that are rare and explained.
- **Degraded**: published `fail` verdicts — the code's own law is
  `mayPublish && coverageComplete ? "pass" : "fail"`, so a review a bound cut
  short (`max-turns reached`, the prompt past its context headroom) publishes
  with verdict `fail` and the bound named in the record; a run of them is a
  signal to raise the ceilings (`max-turns` / `context-window` / `ignore`),
  not to read less and claim more. `refused` records naming the diff-line
  budget or the prompt-headroom ceiling (capacity — fix with `ignore` or a
  budget decision, never by reclassifying to a skip). A SARIF write failure
  would be a logged loss with the verdict standing (not applicable to the
  targets until the Code Scanning surface is added). `unknown` is **not** a
  degradation signal to count here: no fresh-run code path assigns it — it
  exists in the vocabulary for recovered records and it never passes.

### `harmonise` — the self-hosted baseline, read weekly

Fields to watch: `outcome`; `reason`; `pairs` (`selected`, `proposed`,
`unchanged`, `skipped`, `failed` — the five total the selected schedule);
`pullRequest` (`number`, `created`); `headSha`.

- **Healthy**: `published` with the pull request carried, or `skip`
  (everything in step, or a dry run); `unchanged` dominating `proposed`
  week over week.
- **Degraded**: `partial` (read which pair line failed before the next
  scheduled run); refused pairs — counted under `pairs.skipped`, each with a
  typed deterministic refusal reason: the script gate (a candidate not in the
  target language's script, I17), the placeholder-order verdict, or the byte
  cap; `failed` — pairs that errored after every retry: a transport break, a
  junk answer, a manual-edit conflict. A refusal recurring on two consecutive
  weekly runs is a model or language-map problem by the gate's own reading,
  not a document problem.

### The failure taxonomy — the vocabulary for every finding

Fifteen classes; the class names the outcome, so the mapping is a function.
When a dogfood finding is filed against action-agents, its title carries the
class:

| #     | Class                     | Outcome                                                                                                                                                                                                                        |
| ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-01  | event-name-unsupported    | `failed`                                                                                                                                                                                                                       |
| F-01a | event-action-unsupported  | review `failed`; triage re-triages                                                                                                                                                                                             |
| F-02  | config-invalid/absent     | `refused` for the validation arm — triage, review, harmonise; `failed` for the reader arm (triage, review): a path absent, a policy declared twice, a foreign schema major, a file that does not parse or is past the byte cap |
| F-03  | policy-source-unavailable | `failed`                                                                                                                                                                                                                       |
| F-04  | transport-5xx/429         | `failed` after retries                                                                                                                                                                                                         |
| F-05  | transport-timeout         | `failed` (non-idempotent writes: one attempt)                                                                                                                                                                                  |
| F-06  | auth (401/403)            | `failed`, zero writes                                                                                                                                                                                                          |
| F-07  | not-found-mid-write       | treated as applied                                                                                                                                                                                                             |
| F-08  | rate-limit-exhausted      | `failed`                                                                                                                                                                                                                       |
| F-09  | provider-invalid-answer   | `refused` or `failed` — off-sheet/junk/truncation per action                                                                                                                                                                   |
| F-10  | provider-refusal          | reserved, unused                                                                                                                                                                                                               |
| F-11  | ceiling-exceeded          | typed refusal, else `failed`                                                                                                                                                                                                   |
| F-12  | subject-moved             | `abandoned` (triage, review); `failed` (harmonise)                                                                                                                                                                             |
| F-13  | partial-mutation          | `failed` (triage); `partial` (harmonise)                                                                                                                                                                                       |
| F-14  | artifact-write-failure    | the run's own terminal verdict stands (logged loss)                                                                                                                                                                            |
| F-15  | internal-unknown          | `failed` — a bug, and the record says so                                                                                                                                                                                       |

The full table with the rule each class pins is
[the run contract's](run-contract.md#failure-taxonomy).

## Success criteria

These are **decision rules to observe and record, not SLOs to enforce** —
wrong-but-measurable beats right-but-unmeasurable, and every threshold below is
revisited at the day-30 close with the observed distribution in hand.

**Every row is posture-keyed, and no denominator mixes postures.** A dry-run
triage record ends `skip`, never `published` — the dry run gates the write,
never the decision, and the record carries the full decision plan — so the
phase-1 audit reads **decision blocks out of dry-run records**, and the
live-phase rows count **live runs only**. Windows: per target, whichever
comes **last** of the run count and 14 days — loom 20, archkeep 10,
release-craft 8 decision-bearing runs — so the window guarantees the minimum
sample the volumes assumed in [Targets](#targets) can actually fill, inside
the fortnight to a month it may span. Evidence source is named per rule.

### `triage`, per target

| Counter               | Continue                                                                                                         | Pause and fix                                                       | Roll back                                              | Evidence                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Sample-audit accuracy | ≥ 8 of 10 sampled decisions right — dry-run phase: the record's decision block; live phase: the applied decision | < 8 of 10, or ≥ 2 maintainer-reported mislabels rooted in the sheet | > 10% of labelled threads reported wrong in the window | phase 1: dry-run records' decision blocks vs thread state; phase 3: published decisions vs thread state; sampled weekly |
| Refusal rate          | ≤ 20% of live runs                                                                                               | > 20% (sheet too narrow, or gateway junk — read `refusals` first)   | —                                                      | records, `outcome: refused`, counted over live runs only                                                                |
| Abandoned rate        | ≤ 10% of live runs                                                                                               | > 10% (concurrency or process thrash)                               | —                                                      | records, `outcome: abandoned`                                                                                           |
| Truncated answers     | 0                                                                                                                | —                                                                   | —                                                      | records, `failed` + truncation reason                                                                                   |

Any occurrence in the truncation row is filed against action-agents with the
record attached (expected zero after #451) — it pauses the target until
answered, because a cut answer that reached a thread would be a correctness
blocker, and the contract refuses it before that can happen.

### `review`, per target (loom and archkeep)

| Counter                                     | Continue                                                                | Pause and fix                                                                                             | Roll back | Evidence                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Budget-cut publishes (`fail` + bound named) | ≤ 20% of live published runs                                            | > 20% — raise `max-turns` / `context-window`, or add `ignore`, then re-judge                              | —         | artifacts: `gates` + `coverage` — no `verdict` field, the verdict derives from them per the law; the bound in the failing gate's `reason` |
| Capacity refusals                           | ≤ 20% of live runs                                                      | > 20% — add `ignore` entries or raise `maxDiffLines` as a measured capacity decision                      | —         | artifacts named `-refused-`, reason class                                                                                                 |
| Finding acceptance                          | ≥ 30% of confirmed findings accepted (fixed or filed) by the maintainer | sustained < 30% across the window — the rubric is noise: drop `strictness`, or stop review on this target | —         | comment threads, maintainer dispositions                                                                                                  |
| Verdict mix (recorded)                      | trend recorded weekly, no threshold                                     | —                                                                                                         | —         | artifacts, counted weekly                                                                                                                 |

### `harmonise` — self-hosted baseline, weekly

| Counter                | Action                                                                                    | Evidence                                                                                                                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `failed` outcome       | any occurrence → issue in action-agents naming the F-class, before the next scheduled run | records                                                                                                                                                                                                                                                                                          |
| Recurring refused pair | same pair refused two consecutive runs → investigate model / language map                 | refusal **count** from `pairs.skipped` in the records (a refusal lands there — `pairs.failed` is pairs that errored after every retry, not refusals; the record holds counts, no pair ids — identify the pair from the typed-refusal reason text in the record or the run log, an operator read) |
| `partial` outcome      | read the failed pair line before the next run                                             | records                                                                                                                                                                                                                                                                                          |

### The day-30 close

Per (repo, action): one of **continue** (all rows green or explainably amber),
**adjust** (named config change, recorded, window restarts), or **roll back**
(workflow disabled, incident or a criteria row failed twice). The decision and
its numbers are recorded in the rollout log — a threshold that was never
compared against its number was not an SLO, it was decoration.

## Rollout order and first-run verification

Two orders, deliberately different. The **dry-run order** is loom, then
archkeep, then release-craft: a dry run's marginal risk is model cost, so the
binding constraint is signal, and loom's volume (assumption) produces
classification evidence fastest while archkeep validates a second profile. The
**live order** is the reverse — release-craft, then archkeep, then loom —
because release-craft's mislabels are the lowest-consequence in the
organisation and loom, the loudest surface, flips last. No target goes live
before its own ladder below has completed.

Per target, in this order:

1. **Triage dry-run** (phase 1: no config file). Let real events run: wait for
   the target's first real issue or pull request — or file a throwaway issue to
   produce one, since the workflow only fires on real threads.
2. **Triage phase 2**: commit the starter sheet and create the four labels;
   let a real event re-run it, still dry-run.
3. **Triage live**: flip `dry-run: "false"`.
4. **Review** (loom, archkeep): start `dry-run: "true"`, first runs on the
   next real pull request; flip to `"false"` after the first-run checklist
   passes twice.

### The first-run checklist (every flip, every target)

1. The run appears in the target's Actions tab and completes.
2. A record artifact exists (`triage-run-record` / `review-run-artifact`),
   downloads, and parses as JSON; its `outcome` is in the six-word vocabulary;
   its `policy.sha` names the target's default branch.
3. The write surface is exactly as intended for the posture, checked
   mechanically by diffing the record's `decision` (`add` / `remove`) against
   the labels actually on the thread and by counting the thread's comments:
   - triage dry-run — **no** labels added, **no** comments (check the thread
     and its label list before/after);
   - triage live — exactly the sheet labels, add-only, and on issues at most
     one marked signal comment; nothing closed, assigned or mentioned;
   - review dry-run — **no** comment on the pull request;
   - review live — exactly one marker comment, upserted in place on the next
     run, never duplicated.
4. No secret reaches the log — asserted on three levels. Both actions mask the
   key and token at startup (add-mask on the workflow log), and GitHub masks
   secrets in rendered and archived logs regardless, so **a log search for the
   key value cannot be the check** — it is vacuously green by construction.
   What an operator asserts from the downloaded archive: (i) the endpoint URL
   appears only inside transport-error lines, nowhere else; (ii) no literal
   key-shaped value (a long opaque token, masked or not) appears anywhere. The
   authoritative leak control is outside the runner: the organisation gateway
   in front of `ECOMA_LLM_BASE_URL` sees every request with the key and is the
   one place a leak to a foreign host would show — its request log is read
   once per target at the first live flip, not per run.
5. The record's `reason` and `decision` read coherent against the thread —
   the first human read of model output on this target.

A flip happens only after its checklist has passed at the current posture; the
flip itself is one line, and the next run re-verifies item 3 in the new
posture.

## Incident rules

Any of the following is a **security or correctness blocker**, not a tune-up:

- a write outside the intended surface — a label the sheet does not declare, a
  thread closed, assigned or mentioned, a second comment, a ref or branch
  touched, a read outside the workspace;
- any secret leakage — the API key in a log, a comment, or a request to a host
  other than `ECOMA_LLM_BASE_URL`;
- a wrong terminal classification — a run recorded green that wrote, or a
  refusal dressed as a skip;
- stale evidence trusted — a decision applied against a thread whose head or
  labels had moved;
- a claimed-but-missing record — an `artifact-file` output naming a file that
  never uploaded, or a green run whose declared record is absent;
- an incomplete review recorded as passing — a `fail` or `unknown` verdict
  rendered as clean anywhere.

For any of them: **disable the target's workflow immediately** (Actions → the
workflow → "Disable workflow" — visible, reversible, and recorded in the
target's audit log), leave every record and comment in place as evidence, and
report privately per `SECURITY.md` at the action-agents repository root — the
private advisory form, never a public issue. **No silent patching**: nobody
edits the target's workflow to "make it stop doing that" before the assessment
is done, because the edit destroys the evidence and the advisory's
reproduction.

Rollback, when the blocker is real:

1. Disable the workflow on every target running the same ref (the disable is
   per-workflow and per-repository; do all three).
2. Assess from the records and comments — what wrote, where, under which
   policy SHA; attach them to the advisory.
3. Fix in action-agents, through its own review and release process.
4. Re-pin the targets to the **released exact tag** carrying the fix —
   `@v0.11.2` becomes the next released tag, deliberately, with the digest of
   the change known.
5. Re-enable, and re-run the [first-run checklist](#the-first-run-checklist-every-flip-every-target)
   at dry-run before going live again.

Anything that is merely **wrong** — a bad label, a review finding that is not
real — is a public issue in action-agents, not an incident; the ceilings are
about what an action may do, not about being right.

## The rollout checklist

Mechanically checkable, in order. Nothing is skipped; each step names its
evidence.

1. [ ] action-agents 0.11.2 is released; the exact tag `v0.11.2` exists and
       carries each `action.yaml` (evidence: the tag's tree).
2. [ ] `ECOMA_LLM_BASE_URL` and `ECOMA_LLM_API_KEY` exist at org level and are
       visible to loom, archkeep and release-craft (evidence: each repo's
       Settings → Secrets → Organization secrets shows "Used by" including it).
3. [ ] This page re-read against the released tag: every input below exists in
       the tag's `action.yaml` files; the workflow snippets' third-party pins
       are re-copied from the tag's `.github/workflows/*.yml`.
4. [ ] loom: `triage` workflow committed exactly as
       [above](#triage--one-workflow-all-three-targets), `dry-run: "true"`.
5. [ ] loom: a first dry run completes on a real thread (file a throwaway
       issue if none is in flight); [first-run checklist](#rollout-order-and-first-run-verification)
       items 1–2 and 4–5 pass; item 3 passes in the dry-run form.
6. [ ] loom: real-issue and real-PR dry runs observed through the phase-1
       window; [success criteria](#success-criteria) triage rows green.
7. [ ] loom: sheet committed (`.github/action-agents/triage/triage.json5`,
       `schemaVersion: 2`) and the four labels created (`bug`, `enhancement`,
       `documentation`, `question`); real-thread re-run stays green, still dry-run.
8. [ ] loom: `review` workflow committed, `dry-run: "true"`; next real pull
       request produces a `-dry-run-` artifact and no comment; checklist passes.
9. [ ] archkeep: triage phases 1–2 as steps 4–7 (own threads, own dry-run
       window, own sheet and labels) — with the form-label collision resolved
       first: the audit named in [Targets](#ecoma-ioarchkeep) reads the issue
       forms' actual `labels:` entries and picks one owner for `bug` before
       the sheet is committed.
10. [ ] archkeep: `review` workflow committed, `dry-run: "true"`; checklist
        passes on the next real pull request.
11. [ ] release-craft: triage phases 1–2 as steps 4–7 (triage only — no review
        workflow; the phase-1 window still runs in full).
12. [ ] First live flip — release-craft triage: `dry-run: "false"`; checklist
        item 3 passes in the live form (labels exactly as the sheet declares).
13. [ ] archkeep goes live: triage `dry-run: "false"`, then review
        `dry-run: "false"` after its checklist has passed twice; one marker
        comment, never duplicated.
14. [ ] loom goes live last: triage `dry-run: "false"`, then review
        `dry-run: "false"` after its checklist has passed twice.
15. [ ] Harmonise deliberately absent on all three (not multilingual); the
        self-hosted weekly run here continues and its records stay on the weekly
        read.
16. [ ] Day-7 audit: sample records read; the first observed volumes refresh
        the assumptions in [Targets](#targets) — the day-30 close, not this
        audit, finalises them.
17. [ ] Day-30 close: per (repo, action) decision — continue / adjust / roll
        back — recorded with its numbers.
18. [ ] The rollout log carries: every flip's date and commit, every incident
        (or "none"), the day-30 decisions, and the observed totals that replace
        this page's assumptions.
