# Contributing to Action Agents

Thank you for being here. This document is the short version of everything a
pull request is judged on, so nothing about the process is a surprise.

By contributing you agree that your work is licensed under the Apache License
2.0, and that you have the right to grant that license — see
[Ownership of what you contribute](#ownership-of-what-you-contribute).

> **The repository is pre-release.** No action has shipped and there is no tag
> to pin. What is written here is the shape the repository is built to, not a
> description of a finished product.

## The one rule that decides most questions

**Each action is general, and none of them is designed around the repository
that happens to maintain it.** Ecoma dogfoods these actions, which is a good way
to find out whether they work and a bad reason to shape them. The test for any
proposal is whether it would still be the right design for a repository whose
languages, provider and conventions are nothing like ours.

Three consequences, each of which has already turned down a plausible design:

- **Nothing is special-cased by language.** Not Vietnamese, not Chinese, not
  English. Languages arrive through configuration, and a rule that cannot be
  derived from it — a script set, a length expectation — does not get to exist.
  A heuristic reading "if the text is Chinese" is the shape of the bug, not of
  the fix.
- **The free-tier path is a supported path, not a degraded one.** Some people
  will point these actions at an endpoint with no key, on models that are
  individually weak. A change that only makes sense when the model is good is a
  change that abandons those users.
- **Provider-specific behaviour lives behind the model seam or nowhere.** What
  crosses into the rest of the code is the OpenAI chat-completions protocol. A
  feature needing more than that protocol offers is proposing to narrow who can
  use this, and needs a design discussion first.

## The layout

```text
core/src/            shared runtime primitives — infrastructure only
triage/action.yaml   triage/src/
review/action.yaml   review/src/
harmonise/action.yaml harmonise/src/
```

Each directory beside `core/` is a whole action: the `action.yaml` a consumer
names in `uses:`, and the source that runs. A consumer writes
`ecoma-io/action-agents/review@v0.1`, which is that directory and nothing else.

## Setting up

Requirements: **Node ≥ 24** (`.node-version` pins the major) and **pnpm 11**
(pinned via `packageManager`, so Corepack fetches the right one).

```bash
git clone https://github.com/ecoma-io/action-agents.git
cd action-agents
pnpm install
```

`pnpm install` runs `lefthook install`, which is what puts the Git hooks in
place. If you have ever wondered why a repository's hooks did not run for you:
it is because that step was skipped. Do not skip it.

**pnpm is a development tool here and nothing else.** It never runs on a
consumer's runner — see the next section for why that matters more than it
sounds like it should.

## Why there is no build, and no runtime dependency

Every action is a JavaScript action:

```yaml
runs:
  using: node24
  main: src/index.mjs
```

The runner executes that file directly, on the Node 24 it ships with. There is
no bundler, no `dist/` to commit, no `npm install` step, and no network round
trip before the action starts. The whole repository is checked out when a
consumer names one action, so `core/` is reachable from each action by ordinary
relative import — which is what makes a shared layer possible without publishing
anything.

That arrangement holds only while one condition holds, so it is a rule rather
than a preference:

> **`package.json` has no `dependencies` block, and adding one is a design
> decision.**

The standard library plus `fetch` is the entire runtime. This is not
minimalism for its own sake — the alternatives were measured, and each one
costs a consumer something on every job:

| Instead of this          | The cost                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Commit `dist/`           | A generated blob in every diff, and a CI gate to prove it matches the source                                        |
| Commit `node_modules/`   | The same, larger, and unauditable                                                                                   |
| Composite + install step | pnpm is not present on the runner, so a bootstrap action plus an install — ~10–25s and a network dependency per job |

So the two packages an action would reach for first are written out instead:
what `@actions/core` does is read `INPUT_*` variables and print `::command::`
lines, and what an API client does is `fetch`. Both are specified by GitHub and
by the chat-completions protocol respectively, and both are small enough to own.

If you believe a change genuinely needs a runtime dependency, open an issue
before the pull request. It may be the right answer — but it changes what every
consumer runs, so it is not decided in a diff.

## Types without TypeScript

There is no `.ts` file in this tree. Types are JSDoc annotations on plain
JavaScript, and `pnpm typecheck` runs `tsc --noEmit` with `allowJs` and
`checkJs` over them in `strict` mode. TypeScript is a dev dependency that never
emits: the source is what runs, and a type error is still caught before it
lands.

Annotate the boundaries — every exported function's parameters and return. Every
value crossing into these actions is untrusted or unvalidated (a webhook
payload, JSON a model wrote, a file in someone's repository), and turning one of
those into a real type is much of what this code is for.

## The boundary law

A monorepo of actions sharing one directory has exactly one way to rot:
`core/` slowly absorbing whatever the second action happened to need, until the
shared layer is the union of every action's domain. Two rules stop that, and they are
mechanical rather than remembered:

- `core/` may not import any action.
- No action may import another. An action depends on `core/` or on nothing.

[`archkeep.json`](archkeep.json) declares the projects and their tags,
[`module-boundaries.config.mjs`](module-boundaries.config.mjs) holds the
constraint table, and `pnpm arch` judges the tree against both. Adding an action
means adding a project in the first file and a `scope:` row in the second; there
is no third place to remember.

The rule the gate cannot check is the one worth stating in prose: **core holds
infrastructure, not an action's policy.** A helper that only one action could
ever want does not belong there even when the import direction is legal.
Duplicate a few lines and promote them once a second action genuinely needs
them — not in anticipation that one might.

## The commands

| Command                 | What it does                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`             | ESLint, zero warnings tolerated                                                                                                   |
| `pnpm typecheck`        | `tsc --noEmit` over the JSDoc types — the only place a type error is caught                                                       |
| `pnpm arch`             | `archkeep check` — the core/action boundary, judged mechanically                                                                  |
| `pnpm test`             | Vitest, with coverage thresholds                                                                                                  |
| `pnpm test:tools`       | `node --test` over `tools/**` and `scripts/**` — the gates that check the gates                                                   |
| `pnpm check-docs-links` | Every markdown link, prose `docs/…` citation, and path named in a `.yml`/`.yaml` resolves                                         |
| `pnpm check-anchors`    | Every `(file#fragment)` link resolves against a heading that is really there — duplicate headings included                        |
| `pnpm check-uses-refs`  | Every documented `uses: ecoma-io/action-agents/<action>@<ref>` resolves against a tag that exists, and an action that ships at it |
| `pnpm check-skills`     | The vendored `arch-*` skills are byte-identical in both agent directories and match the pinned `@ecoma-io/archkeep`               |
| `pnpm sync-skills`      | Rewrites those vendored skills from an Archkeep source tree. Not a gate — the only sanctioned way they change                     |
| `pnpm format`           | Prettier, in place                                                                                                                |
| `pnpm format:check`     | Prettier, read-only — what CI runs                                                                                                |

Everything above except `pnpm format` and `pnpm sync-skills` is a gate. Run them
before you push; a shorter local run just moves the red to the pull request.

Notice what is **not** on that list: there is no `build`, and no step that
produces an artifact. That is the point of the previous two sections.

### When a reference gate is wrong, say so on the line

Two of those gates resolve a reference against the tree, and both can meet a
reference that is legitimately unresolvable. Neither takes an ignore file: the
waiver goes on the line it applies to, so it is read by whoever next reads the
line rather than in a list nobody opens.

| Marker            | Gate               | What it claims                                                                       |
| ----------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `# roadmap ref`   | `check-uses-refs`  | This `uses:` names a version this repository has not published yet                   |
| `# consumer path` | `check-docs-links` | This path is read in the CONSUMER's repository, and its absence here is not a defect |

Both are counted and reported by the run that honours them, so a growing number
of them is visible rather than quiet. A marker is a claim someone wrote down; if
you cannot write the sentence that justifies it, the gate is probably right.

## The architecture skills your agent already has

Clone this repository, open Claude Code, Codex or opencode in it, and five
`arch-*` skills are already there — `arch-context`, `arch-change`, `arch-check`,
`arch-review` and `arch-migrate`. They come from
[`@ecoma-io/archkeep`](https://github.com/ecoma-io/archkeep), the tool that
judges this repository's boundary, and they are what teaches an agent to
establish the architectural facts before a change and prove the boundary still
holds after one.

They are committed twice, and the duplication is the mechanism. A skill reaches
an agent only from a directory that agent scans, and the three hosts do not scan
the same one:

| Host        | `.claude/skills/` | `.agents/skills/` |
| ----------- | ----------------- | ----------------- |
| Claude Code | reads             | **does not read** |
| Codex       | **does not read** | reads             |
| opencode    | reads             | reads             |

Neither directory alone reaches Claude Code and Codex both, so the pair is the
smallest set that reaches all three. Copies rather than a symlink, because Git
on Windows without symlink support writes a symlink out as a text file holding a
path — a contributor with five files and no skills, and no error saying so.
Committed rather than generated on install, because the window this closes is
between `git clone` and `pnpm install`, which is exactly when someone opens an
agent to ask what this repository is.

**Do not edit those files.** They are byte-identical copies of an upstream
release and `pnpm check-skills` fails on any difference, in either tree, in
either direction — including a Prettier reflow. A fix belongs upstream; anything
else is lost at the next sync. To take a new upstream version:

```bash
pnpm sync-skills --from ../archkeep/skills   # an archkeep clone at the pinned tag
```

`@ecoma-io/archkeep` does not publish `skills/` to npm, which is the only reason
that argument exists. The gate reads two facts together, and that is the point:
the recorded hashes catch an edited copy, and the version recorded beside them
catches the opposite failure — a dependency bump whose pull request touches
nothing but `package.json` and the lockfile, leaving both copies perfectly
consistent with each other and describing a CLI this repository no longer
installs. When that goes red, re-sync; the fix is never to edit a skill.

Note that `archkeep` is not on your `PATH` here — it is a dev dependency, so the
skills' `archkeep …` commands are `pnpm exec archkeep …`, and the full-workspace
run has a script of its own: `pnpm arch`.

## What the hooks do

- **pre-commit** — Prettier _checks_ the staged files rather than rewriting
  them, so an unformatted file fails the commit instead of changing under you:
  run `pnpm format`, stage the result, commit again. ESLint runs over the staged
  code. `check-docs-links` and `check-skills` both run over the whole tree on
  every commit rather than on a glob, because what each one catches can sit in a
  file that commit never touched — a broken reference, or a vendored skill left
  behind by a dependency bump.
- **commit-msg** — commitlint checks the message shape, with the same
  configuration CI re-checks the pull request title against.
- **There is no `pre-push` hook.** Everything that depends on _what_ changed is
  slow enough to be noticed, and a hook slow enough to notice is a hook people
  learn to skip with `--no-verify`, which defeats it more thoroughly than not
  having it at all.

Bypassing a hook with `--no-verify` is occasionally the right call during a
rebase. It is never the right way to land a change.

Every file an AI agent writes is put through the same format, lint and
doc-reference checks at edit time, in all three supported hosts — see
[`AGENTS.md`](AGENTS.md).

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), enforced by
commitlint.

```text
<type>(<scope>): <subject>
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`.

**Scope is optional**, and when used must come from this list — the actions,
the layer under them, and the things around both:

`core`, `triage`, `review`, `harmonise`, `docs`, `workspace`,
`deps`, `ci`.

`deps` and `ci` are on that list because Renovate writes them, and a scope list
without them would fail commitlint on every dependency update. `workspace` is on
it because release-please's release pull request uses it.

```text
feat(review): read the diff one file at a time instead of seeding all of it
fix(core): honour retry-after instead of a fixed backoff
chore(deps): update dependency vitest to v4.2.0
```

A breaking change is marked with `!` after the type or scope, and explained in a
`BREAKING CHANGE:` footer. Here that means something narrower than usual and
more consequential: **the breaking surface is `action.yaml`.** Consumers pin a
floating tag, so renaming an input, changing a default, or tightening what an
input accepts reaches every one of them on the next run, with no version bump
they chose. Removing an input is breaking. Making an optional input required is
breaking. Changing what an output contains is breaking. Say plainly what a
consumer must edit in their workflow file.

### If your commit was AI-assisted

Add a trailer naming the tool: `Assisted-by: <tool>`, or `Generated-by: <tool>`
where the tool produced substantially the whole commit. A pull request
description can be edited later and no clone carries it; the commit trailer
travels with the code.

**One trailer per pull request, on the last commit** — not one per commit.
Squashing concatenates every commit message on the branch into the body of the
one that lands, trailers and all.

## Releases

Nobody picks a version number here. `release-please` reads the conventional
commits on `main`, keeps a release pull request up to date with the next version
and its changelog, and cuts the release when that pull request merges. So **the
commit type you choose is the version decision.**

| Commit          | While below 1.0.0 | From 1.0.0 on |
| --------------- | ----------------- | ------------- |
| `fix:`          | patch             | patch         |
| `feat:`         | minor             | minor         |
| `feat!:`        | **minor**         | major         |
| everything else | no release        | no release    |

`bump-minor-pre-major` sends breaking changes to the minor digit while the
version is below 1.0.0, so no action backs into a 1.0 it has not earned.

**All four actions share one version and one tag.** That is a deliberate
simplification with a real cost, and it is better stated than discovered: a fix
in `harmonise` moves the tag that a consumer of `triage` is pinned to, and they
get it on their next run. What the shared tag buys is that there is one release
to reason about instead of four, and one changelog. If per-action versioning
becomes worth its complexity, that is a change to
`release-please-config.json` — not something to work around in a diff.

**There is no `v0` tag, on purpose.** The floating tag is what a consumer pins
to get fixes without editing their workflow, so what it is allowed to deliver
decides its shape. Below 1.0.0 a minor bump may break you — the bolded cell
above makes that routine — so a `v0` would hand breaking changes to anyone
tracking it. The floating tag is the minor line instead: `v0.1`, `v0.2`. From
1.0.0 on it becomes `v1`, where semver's promise makes a floating major safe
again.

Two things about the release pull request that are not obvious:

- **Its title is pinned** to `chore(workspace): release <version>`.
  release-please's own default puts the target branch in the scope —
  `chore(main): release 0.1.0` — and `main` is not in the scope list above, so
  CI would reject it on every release.
- **`CHANGELOG.md` and `.release-please-manifest.json` are in
  `.prettierignore`.** release-please writes them and Prettier disagrees with
  its output; formatting them by hand only produces a commit release-please
  overwrites next time.

## Tests

Two tiers live beside the source, distinguished by filename:

| Tier            | File                          | What it may touch                                                                          |
| --------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| **Unit**        | `<name>.test.mjs`             | The unit alone. Project-internal collaborators are stubbed; third-party libraries are not. |
| **Integration** | `<name>.integration.test.mjs` | Real collaborators — justified only when that interaction _is_ the behaviour being pinned. |

**No model is ever called from a test.** Not a real one, not a free one, not
"just this one integration test". A test that talks to a provider fails on
someone else's rate limit and passes for the wrong reason on a good day. The
model seam is stubbed, and what gets pinned is how this code behaves against the
responses a provider actually produces — including the ugly ones.

Three things a reviewer will check:

- **A test pins intent, not just current output.** If the logic that matters
  could change without failing your test, the test is not doing its job.
- **A test is titled by the behaviour it pins**, never by the phase of work that
  added it.
- **The failure cases are covered, not just the success case.**

### Testing something that is not deterministic

`review` is an agent: it decides what to read, and the same pull request can
produce a different transcript twice. That rules out asserting on a model's
output, and it does **not** rule out testing — it moves what a test is for:

- The loop, the tool surface, the budgets and the context compaction are
  ordinary deterministic code, and they are tested as such against a stubbed
  model. Whether compaction preserves what it promised to preserve is a unit
  test, not a matter of taste.
- Whether the review is any _good_ is measured over fixtures, and it is measured
  rather than asserted. A quality regression shows up as a worse number, not as
  a red equality assertion.

Never commit a focused or skipped test. `it.only` silences the rest of the suite
while still reporting green; `it.skip` reports green for something nobody ran.
An unimplemented case is `it.todo`, which is visible.

## What a reviewer will actually look for

These actions run in other people's repositories holding a write token, with a
model API key in the same process. So the question a change is judged on is not
"does it work when the model behaves" — it is **what happens when the model
misbehaves, and what happens when the input is hostile.** A change that touches
an action's pipeline is expected to have an answer for:

- the provider returns a non-2xx, times out, or returns HTML;
- the provider returns HTTP 200 with an error object in the body — several do;
- the model returns prose where JSON was demanded, or JSON of the wrong shape;
- the model asks to do something outside what the action is permitted to do;
- the model stops partway through, or exhausts the context window;
- a pull-request body, a diff hunk or a repository file contains an instruction
  aimed at the model;
- a path handed to a file-reading tool points outside the workspace.

None of those is hypothetical. [`SECURITY.md`](SECURITY.md) is the fuller
statement of the last two, which are the ones that turn a bug into a
vulnerability.

## Analysis

CodeQL runs over two languages, and the second one is the interesting one:
`actions` reads the workflow files in this repository. These **are** GitHub
Actions, and the mistakes that leg reports — an untrusted checkout under
`pull_request_target`, `github.event.*` interpolated into a `run:` block, a job
with no `permissions:` — are precisely the mistakes our own consumers will make
in workflows they copy from our README. Treat a finding in a workflow file as a
finding in documentation as well as in code.

**Semgrep** runs beside it, in two passes on purpose. The reporting pass carries
this repository's own rules alongside a registry pack and uploads the result;
the blocking pass re-runs our own rules alone and fails the job on a finding.
Only our rules block, because a registry pack can gain a rule overnight and turn
`main` red for a change nobody made.

**Gitleaks** scans the whole history rather than the diff, because a secret
removed in a later commit is still a leak for as long as it sits in the tree.

All three report through one required check, `analysis-gate`, for the same
reason CI has `ci-gate`: the name a branch ruleset requires stays stable while
the job list does not.

## Opening a pull request

1. Branch from `main`.
2. Make the change, with tests, and run the full command list above.
3. Fill in the pull request template honestly — especially **Consumer impact**.
   Writing "none" is fine when it is true; leaving it blank is not.
4. Keep it focused. Unrelated cleanup found along the way is welcome as its own
   pull request — mixed into this one it makes the real change unreviewable.

### How a pull request lands

**Squash, always.** Three things follow:

- **The pull request title becomes the subject of the commit on `main`**, so the
  title must itself be a valid Conventional Commit. CI checks it with the same
  commitlint configuration the `commit-msg` hook uses.
- **One release-worthy change per pull request.** A pull request holding a
  `feat:` and an unrelated `fix:` gets one subject line, so it announces one of
  them. If you have two, send two.
- **You do not need to sign your commits.** GitHub signs the squash commit it
  creates, and the commits on your branch are never the ones that land.

## Reporting problems

- **Bugs and proposals** — use the issue forms. The questions they ask are the
  ones that decide whether something is actionable.
- **A wrong decision by an action** — a wrong label, a bad translation, a review
  finding that is not real — is a bug, and a public issue is the right place for
  it. Include what the action saw, so it can become an evaluation case.
- **Security vulnerabilities** — never a public issue. Follow
  [`SECURITY.md`](SECURITY.md).

## Ownership of what you contribute

You keep the copyright in your contribution and license it to the project under
Apache-2.0, which includes the patent grant that license carries.

Please only send work you have the right to send. If you are employed as a
developer, your employment agreement may assign what you write to your employer
even on your own time and your own hardware — in which case you need their
permission before contributing, not after. Anything you did not write yourself,
including substantial output from an AI tool, must be disclosed as described
above.

## Code of Conduct

Everyone taking part is held to the [Code of Conduct](CODE_OF_CONDUCT.md).
Reports go to john.itvn@gmail.com.
