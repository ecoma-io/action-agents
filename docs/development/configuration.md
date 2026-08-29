# Development — the configuration mechanism

The mechanism every action shares for repository-level configuration, written
before any of it was built and kept current with it. `triage` is its first
consumer; the per-action pages beside this one record each schema.

## Where the file lives

A consumer's repository-level policy for an action is one file:

```text
.github/action-agents/<action>/<action>.json5   or   .github/action-agents/<action>/<action>.json
```

- Either extension is accepted, and both are parsed by the same JSON5 parser —
  JSON is a subset of JSON5, so a strict-JSON file is simply the boring case.
  Comments and trailing commas are the reason to prefer `.json5`.
- **Both present is an error.** A repository that has declared its policy twice
  is refused at startup rather than guessed about.
- **Neither present is fine.** The action runs on its inputs and built-in
  defaults alone; an absent file is policy-empty, not a misconfiguration. One
  action has no work at all without its file and refuses rather than runs
  green — `harmonise`, for the reason its page carries.
- A `config-path` input on each action names a different file — location and
  name both. When it is set, only that path is read, and the default locations
  are not consulted; a configured path that does not exist on the resolved
  policy source is a startup error rather than a silently empty policy.

## Which branch governs — the resolved policy source

The file is fetched once, via the API, from a **policy source** the action
resolves at startup from its execution context — a branch name and the
immutable 40-hex commit SHA it pointed at when the run began. Never read from
the checked-out workspace. The working tree is evidence, never configuration:
under `pull_request` a checkout contains the pull request's own content, and a
configuration read from it would let a fork edit the policy that governs its
own triage. Reading policy from a repository ref also keeps actions that have
no reason to check out a repository — `triage` is one — free of a checkout
step.

The resolver maps the context to the source and refuses anything it cannot map:

| Event                                 | Policy source                                       |
| ------------------------------------- | --------------------------------------------------- |
| `pull_request`, `pull_request_target` | the pull request's **base branch**, at its live tip |
| `push` to `refs/heads/*`              | that branch, at the pushed SHA                      |
| `push` of a tag                       | the default branch                                  |
| `workflow_dispatch` on `refs/heads/*` | that branch, at its live tip                        |
| anything else                         | the default branch                                  |

Three properties hold for every row, and the actions enforce them rather than
asking for them:

- **The branch is trusted and the content is pinned.** The source is resolved
  once — branch plus SHA — and every policy read in the run, the config file
  and every instruction document alike, is fetched at that exact SHA. A push
  landing mid-run cannot change what the run reads halfway through, and there
  is exactly one resolution per run to audit.
- **Malformed payloads refuse.** A push or dispatch without a usable ref, a
  pull request without a base branch, a SHA that is not 40 hex digits — each is
  a startup error. The resolver fails closed; it never silently falls back to
  the default branch on input it did not expect.
- **Zero configuration is zero configuration.** With no `config-path` and the
  default branch unresolved, the default branch is exactly what governs — the
  mapping needs no workflow input, and none exists to override it.

A path named inside a config file, an instruction document for instance, is
read the same way: from the resolved policy source, never the working tree.

### `schemaVersion`

A config file may declare `"schemaVersion": 1` — the major this generation of
actions parses. An absent field is accepted, so files written before
versioning keep working; a file declaring a **higher major** is refused at
startup with a message naming the branch, the SHA, the path, the version found
and the version supported. A string (`"1"`) or a fractional value (`1.5`) is
refused the same way — a version is a number, and guessing what `"1"` meant is
how a policy change ships silently. Minor and patch versions do not exist in
the policy schema: a breaking policy change is a new major, and an action that
does not understand it says so instead of improvising.

## Instruction documents

Multi-paragraph prose never goes inside a config file. A one-line gloss is
config; a document is a document, and belongs in one. An action's config
therefore points at markdown files rather than embedding them, and the
convention is a per-action directory beside the config file:

```text
.github/action-agents/<action>/<document>.md
```

Every document is optional: the convention path is tried, a configured path
overrides it, and a missing document is fine. Each is capped (8 KiB) — a
policy document that overflows its cap is refused at startup rather than
silently truncated, because prose cut mid-sentence misleads more reliably than
prose absent.

## The glob dialect

Every pattern a consumer writes — `ignore`, `exclude`, a rule's `include`,
the `documents` filter — speaks one dialect, because it is one hand-written
matcher and there is no dependency to import one from. `*` matches within one
path segment, `**` across segments, `!` at an entry's head negates it,
entries apply in order and the last match wins, braces do not expand. A pattern
that matches nothing is fine everywhere a pattern is accepted.

## Precedence

One direction, no merging:

```text
built-in default   <   config file   <   workflow input
```

With one exception, which is a ceiling rather than a convenience: **a sheet
may only be narrowed.** Where a config file enumerates what a model may choose
between, a workflow input naming that set selects a subset of it — an entry
the file does not declare is refused at startup, with both names in the
message; never silently dropped, and never added. With no sheet to narrow, the
input itself is refused — a `labels:` set in a repository with no config file
names entries nothing declared, and the run ends at startup rather than
guessing.

## What no config file holds

| Does not belong in the file | Belongs to               |
| --------------------------- | ------------------------ |
| `api-url`, `model`          | repository or org `vars` |
| `api-key`, `github-token`   | `secrets`                |
| rubrics and guidance        | instruction documents    |
| `dry-run` and other knobs   | inputs                   |

The dividing line, once: **the file decides what the repository permits an
action to conclude; inputs decide how one run executes.**
