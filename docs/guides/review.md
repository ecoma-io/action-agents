# Guide: `review`

Review a pull request as an agent — it decides what to read, verifies before it
claims, and writes one marker comment with its findings. The model never renders
a verdict (no approval, no request-for-changes) and never removes a finding:
refuted and unresolved findings publish in their own sections.

- [Install and pin](#install-and-pin)
- [Inputs](#inputs)
- [Config file](#config-file)
- [Applicability policy](#applicability-policy)
- [Permissions](#permissions)
- [Outputs and artifacts](#outputs-and-artifacts)
- [Cost and budget controls](#cost-and-budget-controls)
- [Hard ceilings](#hard-ceilings)
- [Failure modes](#failure-modes)
- [Recipes](#recipes)

## Install and pin

Add a workflow file under `.github/workflows/`. The minimal form:

```yaml
- uses: ecoma-io/action-agents/review@v0.10
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    api-url: ${{ vars.LLM_API_URL }}
    api-key: ${{ secrets.LLM_API_KEY }}
    model: ${{ vars.LLM_MODEL }}
```

Pin to a floating minor (`@v0.10`), an exact version (`@v0.10.0`) or a commit SHA.
See [Getting started](getting-started.md#pinning) for the tradeoffs.

The action is referenced as the directory `review` in the repository.

The action runs on `pull_request` events. `edited` is deliberately absent — a
re-worded description does not change the code under review. There is no
`workflow_dispatch`: without a pull request there is nothing to review.

## Inputs

All inputs listed below. Shared inputs are documented in the
[development configuration page](../development/configuration.md).

| Input                | Required | Default            | What it does                                                                                                                                           |
| -------------------- | -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github-token`       | yes      | —                  | Token for GitHub API calls.                                                                                                                            |
| `api-url`            | yes      | —                  | Base URL of an OpenAI-compatible endpoint.                                                                                                             |
| `api-key`            | no       | —                  | Key for that endpoint. Leave unset for keyless endpoints.                                                                                              |
| `model`              | yes      | —                  | Model id to ask.                                                                                                                                       |
| `request-timeout-ms` | no       | `120000`           | Per-attempt timeout in milliseconds.                                                                                                                   |
| `config-path`        | no       | `""`               | Override the config file location.                                                                                                                     |
| `max-turns`          | no       | `30`               | Ceiling on agent turns.                                                                                                                                |
| `context-window`     | no       | `128000`           | Token budget of the configured model.                                                                                                                  |
| `dry-run`            | no       | `false`            | Review and log, comment nothing.                                                                                                                       |
| `artifact-path`      | no       | `.review-artifact` | Directory for the machine-readable run record.                                                                                                         |
| `gate-mode`          | no       | `observe`          | What the merge gate does with its verdict: `observe` records it and blocks nothing; `required` renders a check run a branch ruleset can make required. |

**`max-turns`**: the agent loop reads files (tools), reflects, and decides what
to read next. Reaching the ceiling ends the review and says so in the comment;
it never posts a partial review as if it were complete.

**`context-window`**: the token budget of the configured model. The agent
compacts its transcript before reaching it. Set this to match your model's
context window.

**`dry-run`**: defaults to `false`, unlike `triage` and `harmonise`. A review's
only output is the comment, so defaulting it on would make the action do
nothing. Flip to `true` during initial evaluation.

**`artifact-path`**: directory inside `GITHUB_WORKSPACE` where the
machine-readable run record is written (JSON file named after the reviewed
commit). The action refuses to resolve this outside the workspace. A run that
ends red still leaves its record — a `refused` or `failed` file naming what
killed it — unless it died before it held the facts an artifact is built
from, or the record write itself failed.

## Config file

Behaviour that belongs to the repository rather than to one workflow lives in
the config file.

### Discovery

`review` looks for its config file in order:

1. If `config-path` is set in the workflow, only that path is read.
2. Otherwise, the default locations, tried in order:
   - `.github/action-agents/review/review.json5`
   - `.github/action-agents/review/review.json`

If none exist the action runs with built-in defaults — strictness `medium`,
strategy `standard`, language `en`, no rules, no ignore filter, the convention
instruction path.

### Resolved policy source

Same as `triage`: the file is read from the default branch or the pull request's
base branch at an immutable commit SHA. The full mechanism is in the
[configuration page](../development/configuration.md).

### Keys

The file is JSON5.

| Key             | Required | Default      | What it does                                                                                    |
| --------------- | -------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `schemaVersion` | no       | —            | Must be `1` if present. A higher major is refused.                                              |
| `strictness`    | no       | `"medium"`   | Low, medium or high. Sets the baseline for the intensity axis.                                  |
| `strategy`      | no       | `"standard"` | `"standard"` or `"adversarial"`. An adversarial pass actively seeks what the first pass missed. |
| `language`      | no       | `"en"`       | A BCP-47 tag shaping reviewer prose — severity, paths, lines and schema never move.             |
| `ignore`        | no       | `[]`         | Glob patterns excluding files from the diff universe.                                           |
| `maxDiffLines`  | no       | `5000`       | Ceiling on counted diff lines (additions + deletions) before the action stops reading.          |
| `rules`         | no       | `[]`         | Per-file-group instruction documents.                                                           |
| `instructions`  | no       | —            | The custom rubric.                                                                              |
| `applicability` | no       | —            | Whether review applies at all, which posture it takes, and how deep it goes.                    |

#### `strictness`

One of `"low"`, `"medium"`, `"high"`. Controls the baseline thoroughness of the
review. The applicability policy's intensity axis can override this per rule.

#### `strategy`

- `"standard"` — one review pass, then a verification pass.
- `"adversarial"` — the first pass is followed by an adversarial pass that
  actively tries to find what the first pass missed, then verification.

#### `language`

A BCP-47 tag (e.g. `"en"`, `"vi"`, `"de"`, `"x-pirate"`). Shapes the prose the
reviewer uses. Never affects the contract: severity, paths, lines and schema are
language-independent.

#### `ignore`

An array of glob patterns excluding files from the diff universe. A path matched
by any pattern is invisible to the reviewer.

```json5
ignore: [
  "*.lock",
  "pnpm-lock.yaml",
  "generated/**",
],
```

#### `maxDiffLines`

The maximum counted diff lines (additions + deletions) the action processes. A
diff exceeding this ceiling stops the review before the first model call. Raise
it for large repositories:

```json5
maxDiffLines: 10000,
```

#### `rules`

An array of per-file-group instruction documents. Each rule has an `include`
glob list and an `instruction` path. Rules are additive, not first-match:
every rule whose `include` matches at least one reviewed file is active, in
config order, and each contributes its instruction document — several rules
may apply at once, and none overrides another. A rule matching nothing is
dormancy, not an error.

```json5
rules: [
  {
    include: ["src/**/*.rs"],
    instruction: ".github/action-agents/review/rules/rust.md",
  },
  {
    include: ["src/**/*.ts"],
    instruction: ".github/action-agents/review/rules/typescript.md",
  },
],
```

`include` supports `!` negation within the list to exclude sub-paths.

#### `instructions`

The custom rubric path. Defaults to the convention path:
`.github/action-agents/review/instruction.md`.

```json5
instructions: {
  instruction: ".github/action-agents/review/custom-rubric.md",
}
```

### Complete example

```json5
{
  schemaVersion: 1,
  strictness: "high",
  strategy: "adversarial",
  language: "en",
  ignore: ["*.lock", "generated/**"],
  maxDiffLines: 10000,
  rules: [
    {
      include: ["src/**/*.rs"],
      instruction: ".github/action-agents/review/rules/rust.md",
    },
  ],
}
```

### Byte ceilings

| Boundary                     | Value  |
| ---------------------------- | ------ |
| Config file                  | 64 KiB |
| Rule or instruction document | 8 KiB  |

## Applicability policy

The `applicability` key controls whether review applies to a pull request at
all, which posture it takes, and how deep it goes. It is optional: absent means
review applies to every pull request with the baseline strictness.

Three axes are decided before any model call:

| Axis          | What it decides                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Run**       | Whether the action reviews at all (`true` or `false`).                                                                                           |
| **Posture**   | Which instruction document governs. `"standard"` uses the configured instruction; `"maintainer"` and `"automation"` use mode-specific documents. |
| **Intensity** | The `strictness` value the run runs under. The delta resolves from one per-rule override or the config baseline.                                 |

### Execution context

Before applying rules, the action derives an execution context from the pull
request's metadata — the author, their association, the head provenance —
without reading any review content:

| Context      | Meaning                                                             |
| ------------ | ------------------------------------------------------------------- |
| `automation` | A bot whose login is in the `applicability.bots` allowlist.         |
| `maintainer` | A human with write-class association (OWNER, MEMBER, COLLABORATOR). |
| `external`   | Everyone else — a fork, an unlisted bot, or an unknown author.      |

### Config shape

```json5
{
  applicability: {
    // Bots whose events may classify as `automation` context.
    // Exact logins, case-sensitive.
    bots: ["dependabot[bot]", "github-actions[bot]"],
    // Ordered rules, first-match-wins. A match ends the search.
    rules: [
      {
        id: "skip-dependabot",
        context: "automation",
        when: {
          title: "^build\\(deps\\)",
        },
        run: false,
      },
      {
        // Any GitHub-attested bot not in the allowlist above.
        id: "unlisted-bots",
        when: { author: { isBot: true } },
        run: false,
      },
      {
        // Larger than the scope budget would ever review; recorded as a
        // skip instead of refused as a half-reviewed monster.
        id: "oversized",
        when: { changes: { lines: { gt: 8000 } } },
        run: false,
      },
      {
        id: "stricter-external",
        context: "external",
        posture: "standard",
        intensity: {
          strictness: "high",
        },
      },
    ],
  },
}
```

#### Rule fields

| Field         | Required | What it does                                                                                                                                                                                                                                                       |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | yes      | Name the audit record carries.                                                                                                                                                                                                                                     |
| `context`     | no       | Matches only this execution context. Absent matches every context.                                                                                                                                                                                                 |
| `when`        | no       | Conditions: `title`, `branch` and `base` (regex sources), `paths` (glob array), `labels` (exact names, any-of), `author` (`isBot: true` and/or `equals` logins), `changes` (`lines`/`files`, each `{ gt: N }` over the pre-ignore totals). Combined conjunctively. |
| `run`         | no       | Whether review applies. Defaults to `true`.                                                                                                                                                                                                                        |
| `posture`     | no       | Non-standard posture: `"maintainer"` or `"automation"`. Present only with a deviation from standard.                                                                                                                                                               |
| `instruction` | no       | The posture document's path alongside a non-standard posture.                                                                                                                                                                                                      |
| `intensity`   | no       | The strictness override: `{ strictness: "high" }`.                                                                                                                                                                                                                 |

A rule that sets `run: false` skips review entirely — but only when the rule
is anchored: a pinned non-`external` `context`, `when.author.isBot: true`
(bot-ness is GitHub's own attestation — `user.type` — and cannot be faked by
a pull request's contents), or `when.changes` (a pull request bigger than
the scope budget would refuse anyway; the skip records that outcome honestly
instead). A skip rule naming `external` or anchored only on a title, branch,
base, path or label convention is refused at startup. A rule that sets a
non-standard `posture` must also set an `instruction` path for that posture's
document.

The design record (issue #179) is in the
[development applicability page](../development/applicability-policy.md). The
three axes are shipped in the `review` development page.

## Permissions

```yaml
permissions:
  contents: read
  pull-requests: write
```

- `contents: read` — reading the working tree (the review's subject), config
  file, and instruction documents.
- `pull-requests: write` — writing the one marker comment.

A fork's pull request carries a read-only token. The action detects this and
fails loudly at startup rather than running green and silently skipping the
comment — the posture the action documents, and `continue-on-error` remains a
workflow choice.

## Outputs and artifacts

**Marker comment**: one comment per pull request, created or updated in place by
its marker. The comment carries the review's findings with their verification
states — confirmed, refuted, unresolved — policy and risk table, gate outcomes,
and the phase log. It also embeds the published run's canonical record as a
machine-readable block, so the next run can reconcile against it.

**Cross-run labels**: when the previous marker comment carried a readable
record, code compares the two published records and tags every finding
`[new]`, `[persisting]`, `[moved]` or `[resolved]`, adds a one-line comparison
count under the summary, and lists the findings that resolved where they
retired. The labels are informational prose over the same facts the artifact
already carries: they never change the gate verdict, the SARIF projection or
any exit code, and a missing or unreadable previous record simply renders the
comment as a first run.

**Run artifact** (when `dry-run` is `false`): a machine-readable JSON file
written inside the workspace at `artifact-path`, named after the reviewed commit.
The file carries the same facts the comment renders; every bound verdict also
records the sha256 of the exact evidence window it judged plus a bounded
retention excerpt of it, so a consumer can re-check the content behind the
verdict. Skipped runs leave a record too — a skip record naming which skip
path wrote it, under the same upload glob — and so does a red exit: a
`refused` record when one of the run's own ceilings declined to act, a
`failed` record for anything else. Upload the records as a workflow
artifact to keep them across runs:

```yaml
- name: Upload the run artifact
  if: always()
  uses: actions/upload-artifact@v5
  with:
    name: review-run-artifact
    path: .review-artifact/review-artifact-*.json
    if-no-files-found: ignore
```

The record's `schemaVersion` is `5` for the bare family and `6` once an
applicability policy is active. A breaking shape change moves the number —
the red-terminal shapes moved the bare family from `4` to `5`, green
artifacts included — so tooling that consumes records should follow the
family rather than hard-pin a number that cannot move. The
[run contract](../run-contract.md) states the rule.

File names state the outcome before a consumer opens the file: a red exit
uploads as `review-artifact-refused-<head sha>.json` or
`review-artifact-failed-<head sha>.json`, and a run that died before it
resolved a head writes `no-head` in the sha's place — retention tooling that
parses shas out of these names must tolerate `no-head`.

**Job outputs** (after a published review): `gate-verdict` — the merge gate's
verdict as surfaced, `PASS` or `BLOCK` in `required` mode and `OBSERVE-PASS`
or `OBSERVE-BLOCK` in `observe` mode — and `sarif-path`, the SARIF projection
of the same record, written under the runner's temp directory (never inside
the workspace, which the checkout owns). `sarif-path` is present when the
write succeeded; a failed write is a logged loss that never disguises itself
as success.

**Merge gate**: the gate is code's deterministic decision over the published
record — a finding the verification confirmed or could not resolve blocks,
under every kind in the vocabulary, and a refuted finding never blocks.
`gate-mode` chooses whether the verdict enforces:

- `observe` (the default) — the verdict lands on the outputs and a `neutral`
  `review gate` check run, and blocks nothing. Roll out with this first.
- `required` — the check run's conclusion is `success` on a PASS and
  `failure` on a BLOCK: the run a branch ruleset can make required.

The action's own exit never fails on a BLOCK — enforcement is the check
run's and the ruleset's job, so a BLOCK is still a published, green run with
its outputs standing. A branch ruleset requiring the `review gate` check is
satisfied by the neutral `observe`-mode check — a ruleset only starts
enforcing after the workflow sets `gate-mode: required`. A refused or failed
run renders no gate check run at all, which a ruleset treats as pending:
fail-closed. The SARIF upload is the consumer's step:

```yaml
- id: review
  uses: ecoma-io/action-agents/review@v0.10
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    api-url: ${{ vars.LLM_API_URL }}
    api-key: ${{ secrets.LLM_API_KEY }}
    model: ${{ vars.LLM_MODEL }}
- name: Upload the SARIF projection
  if: always()
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: ${{ steps.review.outputs.sarif-path }}
```

## Cost and budget controls

| Control              | Default  | Effect                                                              |
| -------------------- | -------- | ------------------------------------------------------------------- |
| `max-turns`          | `30`     | Ceiling on agent turns. More turns = more model calls.              |
| `context-window`     | `128000` | Token budget before compaction. Match to your model.                |
| `maxDiffLines`       | `5000`   | Ceiling on diff size. Large diffs stop before the first model call. |
| `dry-run`            | `false`  | Review and log, comment nothing. Model calls still count.           |
| `request-timeout-ms` | `120000` | Per-attempt timeout for one provider call.                          |

The agent loop reads one file per tool call. The number of model calls depends
on the diff size and the model's decisions about what to read. The `max-turns`
ceiling is the hard stop.

## Hard ceilings

These are enforced in code across every action. See the
[development ceilings page](../development/ceilings.md) for the full list.

| Ceiling                       | Value                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Evidence is never instruction | Untrusted content is wrapped as evidence, never read as instruction.                       |
| Sanitiser                     | Model output must survive the sanitiser before it reaches a thread.                        |
| Workspace confinement         | Path resolution confined to `GITHUB_WORKSPACE`; `.git` refused outright.                   |
| Marker-based upsert           | Model text reaches a thread through exactly one route: a comment identified by its marker. |

## Failure modes

| Symptom                                                                                         | Cause                                                                                              | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Run would publish nothing — read-only token"                                                   | Fork's pull request with no write token.                                                           | `review` is designed for same-repo PRs. Under `pull_request` a fork gets a read-only token and no secrets, so the action cannot run on forks at all. Reaching for `pull_request_target` is the trap: that trigger runs the base repository's workflow with full secrets, and **combining it with a checkout of `github.event.pull_request.head.sha` is the "pwn request" pattern** that hands an attacker your secrets regardless of which action you then call. If you use `pull_request_target`, never check out the head SHA and never run the pull request's code — but prefer not using it at all; a PAT does not make reviewing a fork safe. |
| "the diff counts … lines against a …-line budget"                                               | The pull request diff is past `maxDiffLines`.                                                      | Raise `maxDiffLines`, or split the PR. Recorded `refused`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| "the assembled prompt estimates at … tokens, past half the …-token window"                      | The assembled prompt cannot fit half the configured context window.                                | Split the PR, or point `context-window` at a model with a larger window. Recorded `refused`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| "the final answer failed the output contract twice"                                             | The provider's final answer was not the contract JSON, on both attempts.                           | Usually transient at the provider — re-run the job; if it persists, check the endpoint's model and protocol. Recorded `refused`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| "the posture document '…' does not exist on branch '…'", or "… is … bytes, past the …-byte cap" | A non-standard posture rule's `instruction` document is missing or oversized at the policy source. | Add the document, or bring it under the 8 KiB cap. Recorded `failed` — the loader's own error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| "Config file exceeds 64 KiB"                                                                    | Config file too large.                                                                             | Reduce it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| "Document exceeds 8 KiB"                                                                        | A rule or instruction document is too large.                                                       | Shorten it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| "No config file at PATH"                                                                        | `config-path` set to a non-existent path.                                                          | Fix the path or remove it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| "schemaVersion Y is not supported"                                                              | Config declares an unknown schema version.                                                         | Update the action tag or downgrade `schemaVersion`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| "max-turns reached"                                                                             | The agent loop hit the ceiling.                                                                    | Raise `max-turns`, or split the PR into smaller reviews.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Provider unreachable                                                                            | The `api-url` endpoint did not respond.                                                            | Check the endpoint and the timeout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Recipes

### Baseline review, no config file

The action runs with built-in defaults: strictness `medium`, strategy `standard`,
language `en`. No config file needed.

```yaml
- uses: ecoma-io/action-agents/review@v0.10
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    api-url: ${{ vars.LLM_API_URL }}
    api-key: ${{ secrets.LLM_API_KEY }}
    model: ${{ vars.LLM_MODEL }}
```

### Stricter review with per-language rules

High strictness, adversarial strategy, a Rust rule and a TypeScript rule.

```json5
{
  strictness: "high",
  strategy: "adversarial",
  rules: [
    {
      include: ["src/**/*.rs"],
      instruction: ".github/action-agents/review/rules/rust.md",
    },
    {
      include: ["src/**/*.ts"],
      instruction: ".github/action-agents/review/rules/typescript.md",
    },
  ],
}
```

### Skip dependabot PRs

Use the applicability policy to skip PRs from `dependabot[bot]` whose titles
match `^build\(deps\)`.

```json5
{
  applicability: {
    bots: ["deploy-key-rotation[bot]"],
    rules: [
      {
        id: "skip-dependabot",
        context: "automation",
        when: {
          title: "^build\\(deps\\)",
        },
        run: false,
      },
    ],
  },
}
```

### Skip every bot you do not allowlist

`author.isBot` reads the GitHub-attested `user.type` — not a title convention,
not a login guess — so one rule covers dependabot, release tooling and anything
else GitHub classifies as a bot. Allowlisted bots never reach this rule: the
`automation` context matches first via `bots`.

```json5
{
  applicability: {
    bots: [],
    rules: [
      {
        id: "unlisted-bots",
        when: { author: { isBot: true } },
        run: false,
      },
    ],
  },
}
```

### Skip oversized pull requests

Without this rule, a diff over `maxDiffLines` is refused — red, half-reviewed
monster never shown. With it, the same pull request ends green with a skip
record naming the rule and its measured totals (`9000 changed lines across 12
files`). The guard reads the **pre-ignore** totals; `maxDiffLines` counts the
post-ignore universe.

```json5
{
  maxDiffLines: 5000,
  applicability: {
    rules: [
      {
        id: "oversized",
        when: { changes: { lines: { gt: 8000 } } },
        run: false,
      },
    ],
  },
}
```

### Label-gated review for draft-quality branches

Exact, case-sensitive label names matched any-of. A pull request missing
labels does not match — absence costs review, never saves it.

```json5
{
  applicability: {
    rules: [
      {
        id: "triaged-only",
        context: "maintainer",
        when: { labels: ["needs-review"] },
        intensity: { strictness: "high" },
      },
    ],
  },
}
```

### Upload the run artifact

Keep the machine-readable record for every run, including failed ones.

```yaml
- name: Upload the run artifact
  if: always()
  uses: actions/upload-artifact@v5
  with:
    name: review-run-artifact
    path: .review-artifact/review-artifact-*.json
    if-no-files-found: ignore
```

---

For the architecture this action is built to — the agent loop, the tool surface,
the finding lifecycle — read the [development page](../development/review.md).
