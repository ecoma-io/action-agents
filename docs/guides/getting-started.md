# Getting started

Three GitHub Actions for repository upkeep — `triage`, `review` and
`harmonise` — each one a separate action you adopt on its own, running on the
runner's own Node 24 against any OpenAI-compatible model. No bundle to trust, no
dependency to audit, no install step before the action starts: what the runner
executes is the source you can read at the tag you pinned.

This page wires all three into a repository in one pass. For the full surface of
one action — every input, every config key, every failure mode — read its guide:
[`triage`](triage.md), [`review`](review.md), [`harmonise`](harmonise.md). For
the architecture each action is built to, read the development pages:
[`triage`](../development/triage.md), [`review`](../development/review.md),
[`harmonise`](../development/harmonise.md).

## Prerequisites

- A GitHub repository on a plan that allows Actions.
- A runner image with Node 24 — `ubuntu-latest` has it.
- An OpenAI-compatible endpoint: keyed (a provider key) or keyless (a gateway
  you host). The chat-completions protocol is the whole of what crosses the seam,
  so a free-tier endpoint is a supported path, not a degraded one.
- A model id the endpoint serves.

Store the endpoint URL and model in repository **variables** (`vars.`), and the
key in a **secret** (`secrets.`). The config file never holds these — they are
inputs, not policy. See [the configuration page](../development/configuration.md)
for what belongs where.

## Pinning

Every `uses:` reference takes a ref that controls what code runs. Three shapes,
in order of safety:

| Ref                  | Example                                 | What it resolves to                                                     |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `v0.10` (floating)   | `ecoma-io/action-agents/review@v0.10`   | The latest patch release in the `v0.10` line. Gets fixes automatically. |
| `v0.10.0` (exact)    | `ecoma-io/action-agents/review@v0.10.0` | Exactly that release. Never moves.                                      |
| `<sha>` (SHA-pinned) | `ecoma-io/action-agents/review@abc123…` | Exactly those bytes. Immutable.                                         |

Floating tags deliver patches without a workflow edit — that is usually what you
want. Exact tags deliver reproducibility — that is what you want when it is. A
commit SHA delivers an audit trail — the strongest pin, and what security policy
engines enforce.

**Do not use `@main`.** A push to `main` can change what the action does at any
time, including in ways that are not yet released. Every published ref is
immutable or floating within a declared compatibility line.

Always reference a specific action directory — `triage`, `review`, or
`harmonise` — in your `uses:` line. The repository root is a stub that fails with
an error naming the three real actions.

## Where configuration lives

Behaviour that belongs to the repository rather than to one workflow lives in
one file per action:

```text
.github/action-agents/triage/triage.json5
.github/action-agents/review/review.json5
.github/action-agents/harmonise/harmonise.json5
```

Each file is read from the action's **resolved policy source** — the default
branch on most events, the pull request's base branch on pull requests — at an
immutable commit SHA, so a pull request cannot edit the policy that governs it
and a push landing mid-run cannot change what a run reads halfway through. The
working tree is evidence, never configuration.

Every action runs without its file, with one exception: `harmonise` refuses
rather than running green on nothing, because a translation run with no language
map has no work to do. For `triage` and `review`, an absent file is
policy-empty, not a misconfiguration — the action runs on its inputs and
built-in defaults alone.

The full mechanism — discovery, the resolved policy source, precedence, the
glob dialect — is in [the configuration page](../development/configuration.md).
Each action's config keys are in its guide.

## Wire all three actions

Each action is a separate workflow file. Copy one, adapt the `uses:` ref, set
your endpoint and model, and commit. Every example below defaults to a safe
dry-run where one exists: `triage` and `harmonise` default to `dry-run: true`,
so a first run cannot surprise anyone; `review` defaults to `dry-run: false`
because its only output is the comment.

### `triage` — classify issues and pull requests

```yaml
name: Triage
on:
  issues:
    types: [opened, edited, reopened]
  pull_request:
    types: [opened, edited, synchronize, reopened]
  workflow_dispatch:

permissions:
  contents: read
  issues: write
  pull-requests: write

concurrency:
  group: triage-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
          fetch-depth: 1

      - uses: ecoma-io/action-agents/triage@v0.10
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          api-url: ${{ vars.LLM_API_URL }}
          api-key: ${{ secrets.LLM_API_KEY }}
          model: ${{ vars.LLM_MODEL }}
          dry-run: true
```

`triage` reads everything through the API — the checkout exists only so the
runner can find the action. It needs no config file to run: with no file, the
classification is written as a comment. With a file declaring a label sheet, it
applies labels drawn from that sheet and never from anywhere else. See
[`triage`](triage.md) for the label sheet, size measurement and the marker
comment.

`pull-requests: write` is load-bearing even though triage only writes labels:
GitHub's token refuses the issues-API label write on a pull request number
without this scope.

### `review` — review a pull request as an agent

```yaml
name: Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
          fetch-depth: 1

      - uses: ecoma-io/action-agents/review@v0.10
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          api-url: ${{ vars.LLM_API_URL }}
          api-key: ${{ secrets.LLM_API_KEY }}
          model: ${{ vars.LLM_MODEL }}

      - name: Upload the run artifact
        if: always()
        uses: actions/upload-artifact@v5
        with:
          name: review-run-artifact
          path: .review-artifact/review-artifact-*.json
          if-no-files-found: ignore
```

`review` runs on `pull_request`, raised from within the repository. Its subject
is the working tree, so it needs a checkout. It decides what to read, verifies
before it claims, and writes one comment — never a verdict (no approval, no
request-for-changes). The artifact upload step keeps the machine-readable run
record as a downloadable file; `if: always()` preserves it even when the comment
step fails. See [`review`](review.md) for the agent loop, the tool surface, the
applicability policy and the run artifact.

`edited` is deliberately absent from the activity types — a re-worded
description does not change the code under review.

### `harmonise` — keep multilingual docs in step

```yaml
name: Harmonise
on:
  schedule:
    - cron: "17 3 * * 1"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: harmonise
  cancel-in-progress: false

jobs:
  harmonise:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
          fetch-depth: 1

      - uses: ecoma-io/action-agents/harmonise@v0.10
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          api-url: ${{ vars.LLM_API_URL }}
          api-key: ${{ secrets.LLM_API_KEY }}
          model: ${{ vars.LLM_MODEL }}
          source-language: en
          dry-run: true
```

`harmonise` is not a per-pull-request action. It runs on `schedule` and
`workflow_dispatch`, reads and writes everything through the API, and needs no
checkout beyond finding the action. A real run writes one commit to one branch
and maintains one pull request. A pull request opened by `GITHUB_TOKEN` gets no
workflow runs — GitHub suppresses events its own token caused — so consumers who
want the harmonise PR to run CI mint a GitHub App token and pass it as
`github-token`. See [`harmonise`](harmonise.md) for the language map, the
glossary, the pull request and the manual-edit protection.

`harmonise` requires a config file: no file is a red refusal, because a run with
no language map has nothing to do.

## What each action is allowed to do

A model never composes an API call. It picks from a set the repository declared
— `triage`'s label sheet is the one that exists — and a value not in that set is
refused, not coerced. An operation only reaches that set if it is reversible in
one click, visible where the work is, and notifies nobody. Labels qualify.
Closing a thread, assigning, `@mention`, a review verdict, a merge, a push, a
permission change do not — and no input opens them, because a maintainer
listing something they should not have is the failure mode enumeration alone
would still allow.

Anything read from a thread, a diff or a repository file is untrusted data. It
is evidence, never instruction. A change that lets a pull-request body steer
what an action does is the bug, not a missing feature. The threat model is in
the repository root's `SECURITY.md`; the architectural half is in
[the doctrine](../doctrine.md).

## Next steps

- [`triage`](triage.md) — the label sheet, size from the diff, the marker
  comment, failure modes and recipes.
- [`review`](review.md) — the agent loop, the tool surface, the applicability
  policy, the run artifact, failure modes and recipes.
- [`harmonise`](harmonise.md) — the language map, the glossary, skip directives,
  the pull request, failure modes and recipes.
- [The configuration mechanism](../development/configuration.md) — file
  discovery, the resolved policy source, precedence, the glob dialect.
