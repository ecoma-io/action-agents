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
- uses: ecoma-io/action-agents/review@v0.5
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    api-url: ${{ vars.LLM_API_URL }}
    api-key: ${{ secrets.LLM_API_KEY }}
    model: ${{ vars.LLM_MODEL }}
```

Pin to a floating minor (`@v0.5`), an exact version (`@v0.5.0`) or a commit SHA.
See [Getting started](getting-started.md#pinning) for the tradeoffs.

The action is referenced as the directory `review` in the repository.

The action runs on `pull_request` events. `edited` is deliberately absent — a
re-worded description does not change the code under review. There is no
`workflow_dispatch`: without a pull request there is nothing to review.

## Inputs

All inputs listed below. Shared inputs are documented in the
[development configuration page](../development/configuration.md).

| Input                | Required | Default            | What it does                                              |
| -------------------- | -------- | ------------------ | --------------------------------------------------------- |
| `github-token`       | yes      | —                  | Token for GitHub API calls.                               |
| `api-url`            | yes      | —                  | Base URL of an OpenAI-compatible endpoint.                |
| `api-key`            | no       | —                  | Key for that endpoint. Leave unset for keyless endpoints. |
| `model`              | yes      | —                  | Model id to ask.                                          |
| `request-timeout-ms` | no       | `30000`            | Per-attempt timeout in milliseconds.                      |
| `config-path`        | no       | `""`               | Override the config file location.                        |
| `max-turns`          | no       | `30`               | Ceiling on agent turns.                                   |
| `context-window`     | no       | `128000`           | Token budget of the configured model.                     |
| `dry-run`            | no       | `false`            | Review and log, comment nothing.                          |
| `artifact-path`      | no       | `.review-artifact` | Directory for the machine-readable run record.            |

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
commit). The action refuses to resolve this outside the workspace. When the
review publishes nothing, no file is written.

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
glob list and an `instruction` path. Rules are evaluated in order; the first
matching rule's instruction is used for that file.

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

| Field         | Required | What it does                                                                                         |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `id`          | yes      | Name the audit record carries.                                                                       |
| `context`     | no       | Matches only this execution context. Absent matches every context.                                   |
| `when`        | no       | Conditions: `title` (regex), `branch` (regex), `paths` (glob array). Combined conjunctively.         |
| `run`         | no       | Whether review applies. Defaults to `true`.                                                          |
| `posture`     | no       | Non-standard posture: `"maintainer"` or `"automation"`. Present only with a deviation from standard. |
| `instruction` | no       | The posture document's path alongside a non-standard posture.                                        |
| `intensity`   | no       | The strictness override: `{ strictness: "high" }`.                                                   |

A rule that sets `run: false` skips review entirely. A rule that sets a
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
and the phase log.

**Run artifact** (when `dry-run` is `false`): a machine-readable JSON file
written inside the workspace at `artifact-path`, named after the reviewed commit.
The file carries the same facts the comment renders. Upload it as a workflow
artifact to keep the record across runs:

```yaml
- name: Upload the run artifact
  if: always()
  uses: actions/upload-artifact@v5
  with:
    name: review-run-artifact
    path: .review-artifact/review-artifact-*.json
    if-no-files-found: ignore
```

## Cost and budget controls

| Control              | Default  | Effect                                                              |
| -------------------- | -------- | ------------------------------------------------------------------- |
| `max-turns`          | `30`     | Ceiling on agent turns. More turns = more model calls.              |
| `context-window`     | `128000` | Token budget before compaction. Match to your model.                |
| `maxDiffLines`       | `5000`   | Ceiling on diff size. Large diffs stop before the first model call. |
| `dry-run`            | `false`  | Review and log, comment nothing. Model calls still count.           |
| `request-timeout-ms` | `30000`  | Per-attempt timeout for one provider call.                          |

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

| Symptom                                       | Cause                                        | Resolution                                                                                                                                                       |
| --------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Run would publish nothing — read-only token" | Fork's pull request with no write token.     | The action is designed for same-repo PRs. Use a `pull_request_target` trigger and a PAT if you need review from forks, but understand the security implications. |
| "Diff exceeds maxDiffLines"                   | The pull request diff is too large.          | Raise `maxDiffLines`, or split the PR.                                                                                                                           |
| "Config file exceeds 64 KiB"                  | Config file too large.                       | Reduce it.                                                                                                                                                       |
| "Document exceeds 8 KiB"                      | A rule or instruction document is too large. | Shorten it.                                                                                                                                                      |
| "No config file at PATH"                      | `config-path` set to a non-existent path.    | Fix the path or remove it.                                                                                                                                       |
| "schemaVersion Y is not supported"            | Config declares an unknown schema version.   | Update the action tag or downgrade `schemaVersion`.                                                                                                              |
| "max-turns reached"                           | The agent loop hit the ceiling.              | Raise `max-turns`, or split the PR into smaller reviews.                                                                                                         |
| Provider unreachable                          | The `api-url` endpoint did not respond.      | Check the endpoint and the timeout.                                                                                                                              |

## Recipes

### Baseline review, no config file

The action runs with built-in defaults: strictness `medium`, strategy `standard`,
language `en`. No config file needed.

```yaml
- uses: ecoma-io/action-agents/review@v0.5
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
    bots: ["dependabot[bot]"],
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
