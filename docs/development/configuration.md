# Development — the configuration mechanism

The mechanism every action shares for repository-level configuration, written
before any of it was built and kept current with it. `triage` is its first
consumer; the per-action pages beside this one record each schema.

## Where the file lives

A consumer's repository-level policy for an action is one file:

```text
.github/action-agents/<action>.json5   or   .github/action-agents/<action>.json
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
  are not consulted; a configured path that does not exist on the default
  branch is a startup error rather than a silently empty policy.

## The default branch, not the working tree

The file is fetched once, via the API, from the repository's default branch —
never read from the checked-out workspace. The working tree is evidence, never
configuration: under `pull_request` a checkout contains the pull request's own
content, and a configuration read from it would let a fork edit the policy that
governs its own triage. Reading from the default branch also keeps actions
that have no reason to check out a repository — `triage` is one — free of a
checkout step.

A path named inside a config file, an instruction document for instance, is
read the same way: from the default branch, never the working tree.

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
