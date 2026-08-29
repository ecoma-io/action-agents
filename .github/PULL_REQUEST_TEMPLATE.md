<!--
Write your prose — the description, the verification steps, anything you explain
— in whatever language you are comfortable in. The headings and checkbox labels
stay English because this template BECOMES the pull request body: a reviewer
scans the same list on every pull request, and a second language in it is noise
repeated in every pull request forever.

Cứ viết mô tả và các bước kiểm chứng bằng ngôn ngữ bạn thoải mái nhất — tiếng
Việt được hoan nghênh ngang tiếng Anh. Heading và nhãn checkbox giữ tiếng Anh vì
template này TRỞ THÀNH nội dung pull request, nên mỗi dòng song ngữ là tiếng ồn
lặp lại ở mọi pull request, mãi mãi.
-->

## Description

<!-- What changes, and why. Link the issue this closes. -->

Closes #

## Type of change

- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New or changed behaviour in one action (`triage` / `review` / `harmonise`)
- [ ] New capability in `core/`
- [ ] Breaking change (a consumer must edit their workflow file to upgrade)
- [ ] Documentation
- [ ] Build, CI, or repository tooling

## Consumer impact

<!-- Consumers pin a floating tag — `v0.<minor>` below 1.0.0, `v<major>` from
1.0.0 on — so whatever lands here reaches them on their next run with no version
bump they chose. `action.yaml` is the breaking surface: an input renamed, a
default changed, an accepted value narrowed, an output whose meaning moved. Say
what a consumer sees. Write "none" if nothing changes for them, and say so
explicitly rather than leaving it out. -->

- [ ] No `action.yaml` changed — no input, default, or output moved
- [ ] An `action.yaml` changed, and the change is described above

## Architecture

<!-- `core/` holds infrastructure, never an action's policy, and no action
     reaches into another. `pnpm arch` is what judges that. -->

- [ ] `pnpm arch` passes — no import crosses the core/action boundary
- [ ] Nothing was added to `core/` that only one action could ever want
- [ ] No action imports another action

## Runtime shape

<!-- The arrangement that makes these actions installable with no build and no
dependency audit: no `dependencies` block, no bundle, nothing generated into the
tree. See CONTRIBUTING.md. -->

- [ ] `package.json` still has no `dependencies` block
- [ ] No build step, no committed artifact, nothing generated into the tree

## Behaviour when things go wrong

<!-- Delete this section only if the change touches nothing in an action's
pipeline. This is the section a reviewer reads first: the interesting question is
never what happens when the model behaves. -->

- [ ] A provider failure (non-2xx, timeout, HTML, or an error object inside a 200) is handled
- [ ] Model output that is not the demanded shape is rejected rather than parsed optimistically
- [ ] A failure produces a loud, red result — never a silent no-op or a partial result presented as complete
- [ ] Nothing new is written to a thread without passing the sanitiser
- [ ] No model output selects an API call
- [ ] No file-reading path can escape `GITHUB_WORKSPACE`
- [ ] No new logging path can print the configured `api-key`

## Generality

<!-- Each action is general; none is designed around the repository that
     maintains it. -->

- [ ] Nothing here special-cases the repository that maintains it
- [ ] Nothing here assumes a strong model, a paid tier, or a provider beyond the OpenAI chat-completions protocol
- [ ] No rule is special-cased by language

## How this was verified

<!-- What you actually ran and saw, not what should happen. -->

**Steps:**

1.
2.

- [ ] Unit tests added or updated (`pnpm test`)
- [ ] Failure cases covered, not only the success case

## AI-assisted development

- [ ] This pull request is AI-assisted (drafted or substantially written by an AI coding agent)
- [ ] The disclosure trailer is on the last commit: `Assisted-by: <tool>`, or `Generated-by: <tool>` where the tool produced substantially the whole commit

<!-- Name the tool and model, e.g. "Claude Code, opus". A description can be
edited later and no clone carries it — the commit trailer travels with the code. -->

## Checklist

- [ ] Every gate passes locally: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm arch`, `pnpm arch:canary`, `pnpm arch:transport-seam`, `pnpm test`, `pnpm test:tools`, `pnpm security`, `pnpm check-docs-links`, `pnpm check-anchors`, `pnpm check-uses-refs`, `pnpm check-action-inputs`, `pnpm check-workflow-inputs`, `pnpm check-release-invariants`, `pnpm check-skills`
- [ ] I have self-reviewed this diff
- [ ] Documentation is updated in the same pass as the behaviour it describes
- [ ] No unrelated changes are included
- [ ] I have the right to contribute this work under the Apache License 2.0
