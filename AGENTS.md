# Agent guidance

For an AI agent working **on** this repository. It is deliberately short: the
rules a diff gets rejected for violating are in
[`CONTRIBUTING.md`](CONTRIBUTING.md), and what each action is for is in
[`README.md`](README.md). Read this file for what is specific to being an agent
here; read those two for the work.

## What this repository is

Three AI-powered GitHub Actions for repository upkeep — `triage`, `review`,
`harmonise` — against any OpenAI-compatible model. Each one is a
separate action a consumer adopts on its own: `ecoma-io/action-agents/triage@v0.1`
names a directory, and that directory holds everything the action is.

```text
core/src/          shared runtime primitives — infrastructure only
triage/action.yaml triage/src/
review/action.yaml review/src/
harmonise/action.yaml harmonise/src/
```

## The three rules most changes are judged on

**1. `core/` is infrastructure, never an action's domain logic, and no action
may import another.** This is the rule a monorepo of actions rots by
breaking, so it is mechanical rather than remembered: the constraint table is
[`module-boundaries.config.mjs`](module-boundaries.config.mjs), the project map
is [`archkeep.json`](archkeep.json), and `pnpm arch` is what judges both. Run it
before you claim a change is done.

**2. There is no build and there are no runtime dependencies.** Every action is
`runs.using: node24` pointing straight at `src/index.mjs`. No `dist/`, no
`node_modules` on the consumer's runner, no install step, no network before the
action starts. What that forbids in practice: **`package.json` has no
`dependencies` block and adding one is a design decision, not a convenience.**
The standard library and `fetch` are the whole runtime. `pnpm` is a development
tool here and never runs on a consumer's runner.

**3. Types come from JSDoc, checked by `tsc --noEmit --checkJs`.** There is no
`.ts` file in this tree and there is no compiler between the source and what
executes. `pnpm typecheck` is a real gate; annotate accordingly.

## The architecture skills

Five `arch-*` skills are available to you here with no setup, from
`.claude/skills/` (Claude Code) and `.agents/skills/` (Codex, opencode):

| Skill          | When                                                                  |
| -------------- | --------------------------------------------------------------------- |
| `arch-context` | Before modifying code — establish the boundary facts and the Intent.  |
| `arch-change`  | While making a change that touches the core/action line.              |
| `arch-check`   | After a change, before committing. The authoritative gate.            |
| `arch-review`  | Reviewing a change or a pull request for governance.                  |
| `arch-migrate` | Bringing a tree under Archkeep governance. Rarely what you want here. |

They come from `@ecoma-io/archkeep`, they are vendored copies, and **they are
not this repository's text to edit** — `pnpm check-skills` fails on any
difference. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the mechanism and the
re-sync command.

Two things the skills cannot know about this repository:

- `archkeep` is a dev dependency and is not on `PATH`. Every `archkeep …`
  command in a skill is `pnpm exec archkeep …` here, and the full-workspace run
  is `pnpm arch`.
- The skills cite `docs/…` pages of the Archkeep repository, not of this one.
  Those paths do not exist here; do not go looking for them, and do not create
  them.

## Editor-time gates

Every file you write is formatted, linted and checked for dead documentation
references immediately, in all three hosts — Claude Code via
`.claude/settings.json`, Codex via `.codex/config.toml`, opencode via
`.opencode/plugins/editor-gates.js`, all three routed to the same scripts in
`scripts/editor-hooks/`. One implementation, three hosts: a hook that fires for
one agent and not another is a repository where the answer depends on who is
asking.

If one of them fails on a file you just wrote, fix it then — that is the whole
point of it firing at edit time rather than at commit time.

## What an action may do, and what it may not

An action here runs in someone else's repository holding a token that can write
to their issues and pull requests, with a model API key in the same process.
Two ceilings follow, and neither is negotiable in a diff:

- **Model output never selects an API call.** It becomes the text of a comment
  and nothing else. No labels, no reviews, no merges, no permission changes
  chosen by a model.
- **Anything read from a thread, a diff or a repository file is untrusted
  data.** It is evidence, never instruction. A change that lets a pull-request
  body steer what an action does is the bug, not a missing feature.

[`SECURITY.md`](SECURITY.md) is the longer form of both.

## Before you say a change is done

`pnpm lint`, `pnpm typecheck`, `pnpm arch`, `pnpm test` and `pnpm check-skills`
at minimum. The full command table, and which of them CI requires, is in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

Never bypass a hook with `--no-verify` to land a change.
