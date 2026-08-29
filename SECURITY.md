# Security policy

## Reporting a vulnerability

**Do not open a public issue.** These actions run inside other people's
repositories holding a token that can write to their issues and pull requests. A
public report hands every one of those repositories a working exploit before
there is anything to upgrade to.

Report privately through GitHub's
[security advisory form](https://github.com/ecoma-io/action-agents/security/advisories/new).
If that is unavailable to you, email **john.itvn@gmail.com** with `SECURITY` in
the subject line.

Please include:

- what an attacker can do, and what they need in order to do it;
- the affected version, tag or commit;
- a reproduction — the smaller the better. An issue body or a diff hunk that
  triggers the behaviour is the ideal report.

## What to expect

This project is maintained by one person, so these are honest targets rather
than a contractual guarantee:

| Stage                        | Target         |
| ---------------------------- | -------------- |
| Acknowledgement              | within 3 days  |
| Initial assessment           | within 7 days  |
| Fix or documented mitigation | within 30 days |

You will be told which of those applies as soon as the assessment is done,
including when the answer is that the report is not a vulnerability.

## The ceilings everything else rests on

These actions put attacker-influenced text — an issue body, a pull-request
description, a diff hunk, a file in a repository — into a model prompt, in a
process that also holds a write token and a model API key. No amount of prompt
engineering makes that text trustworthy, so the design does not try.

The question a ceiling answers is therefore not _how do we stop a model being
talked into something_, which has no reliable answer, but **what is the worst a
model that has already been talked into something can reach.** Four ceilings
answer it, and each is enforced in code rather than asked for in a prompt:

1. **Model output never composes an API call. It may only choose from a set a
   human declared outside the prompt, and that set — never the prompt — is the
   ceiling.** A model that has been talked into demanding something is answering
   a printed multiple-choice sheet rather than writing on a blank page: an
   answer that is not on the sheet is refused and logged, and never becomes a
   request. `triage`'s sheet is the `labels` its config file declares on the
   default branch; the workflow's `labels:` input narrows it for one call site
   and nothing widens it. With no file there is no sheet, and comment text is
   the whole of what the action can produce.

2. **What may go on the sheet is bounded in turn, and no input widens it.**
   Enumeration alone would only move the risk out of our prompt and into a
   consumer's workflow, where a maintainer can list an operation they should not
   have. So an operation is offered to a model only when all three of these hold
   at once, and is human-only otherwise:

   |                                           | reversible in one click | visible where the work is | notifies nobody | a model may choose it |
   | ----------------------------------------- | ----------------------- | ------------------------- | --------------- | --------------------- |
   | apply or remove a label                   | yes                     | yes                       | yes             | **yes**               |
   | set a size, or a status field             | yes                     | yes                       | yes             | **yes**               |
   | close or reopen a thread                  | yes                     | yes                       | **no**          | no                    |
   | assign, request a reviewer, `@mention`    | yes                     | yes                       | **no**          | no                    |
   | approve, or request changes on a review   | **no**                  | yes                       | **no**          | no                    |
   | merge, push a branch, change a permission | **no**                  | yes                       | **no**          | no                    |

   What the table judges is the operation a **model's answer selects**. An
   operation an action performs unconditionally — `harmonise` opening a pull
   request whether the model found one drift or thirty — is not a model choice
   at all, and what bounds it depends on the credential: when the run carries
   `GITHUB_TOKEN`, the workflow's `permissions:` block bounds it; when the
   workflow supplies a different identity — a GitHub App token, for instance —
   the block does not bind that identity, and the identity's grant is the
   operative bound. What holds under either credential is the code-pinned
   write surface: one ref named by the run's config, files drawn from the
   language map, nothing else. Confusing the two is how a table like this
   gets read as forbidding the very shape that makes a change reviewable.

   The third column is the one that surprises people, and it is the reason the
   line falls where it does: an operation that mails a human turns a wrong
   answer into someone else's afternoon, and no amount of reverting takes the
   mail back. That single test decides all three actions without further
   argument — `triage` applies labels because labels sit above the line;
   `review` comments its findings and never files a verdict, because a verdict
   sits below it; `harmonise` proposes an edit as a pull request, and the
   model's only power over that proposal is its text. The one ref a run ever
   writes is the action's own proposal branch, `harmonise/<source-language>`
   — named by the run's config, never by the model — force-upserted onto a
   commit parented on the audited base. The write is guarded, not atomic:
   the ref API has no compare-and-swap, so the tip is re-read immediately
   before the force-write and a branch caught moving under the run is
   refused rather than overwritten — the residue is a window one round trip
   wide, closed in our workflows by a `concurrency` group and inherited by
   any consumer workflow that ships without one. No other branch or ref is
   ever touched. GitHub's audit log records that ref write as a
   push, but it is not a model choice. What bounds it depends on the
   credential: when the run carries `GITHUB_TOKEN`, the workflow's
   `permissions:` block bounds it; when the workflow supplies a different
   identity — a GitHub App token, for instance — the block does not bind
   that identity, and the identity's grant is the operative bound. The
   guarantee that holds under either credential is the write surface just
   described: the one ref the run's config names, guarded before its
   force-write.

   The table records what may be _offered_, not what is — `triage`'s size is
   never on any sheet, because it is measured from the diff; that row is
   permission, not practice.

3. **Everything read from a thread, a diff or a repository file is untrusted
   data, never instruction.** An action that lets a pull-request body change
   what it does has a vulnerability, not a missing feature.

4. **File access is confined to the checked-out workspace.** This one applies to
   any action that reads files — `review` does. Every path is resolved through
   `realpath` and refused unless it lands inside `GITHUB_WORKSPACE`; `.git` is
   refused outright, because it holds the credential the checkout was performed
   with. A path escape here is a direct route from an injected instruction to
   the runner's secrets, which is why it is treated as a vulnerability rather
   than as a robustness bug.

## Scope

In scope: this repository's source, every `action.yaml`, and the workflows that
decide what runs on a consumer's runner.

Particularly in scope:

- **anything a thread's title or body, or a diff, can make an action do** —
  content that escapes its untrusted-data framing, or model output that reaches
  a comment without passing the sanitiser;
- **anything that lets a comment be written that a maintainer did not intend** —
  a marker forged from injected text so an action edits the wrong comment, a
  container closed early so injected Markdown escapes a collapsed block, a
  `@mention` that survives to notify people on every re-run;
- **anything that performs an operation the model was not offered** — a request
  built from model output rather than chosen from the workflow's declared set,
  an entry accepted into that set from any of the human-only rows above, or a
  match made loosely enough that `bug ` or `Bug` passes for `bug`;
- **anything that reads outside the workspace** — a path escape, a followed
  symlink, a read of `.git`, or a tool that accepts an absolute path;
- **anything that leaks the configured `api-key`** into logs, into a comment, or
  into a request to a host other than the configured `api-url`;
- **anything that lets a commit be made that a maintainer did not intend** —
  `harmonise` writes model text verbatim into a commit by design, bounded by
  the pairing the action itself enumerated (the model never names a path) and
  controlled by the human at the pull request; a route around that pairing is
  the report;
- **anything that lets untrusted content make a run not finish** — a search,
  a tool result, a provider response with no bound on the work or the bytes it
  causes; every surface that consumes untrusted bytes is capped, and a missing
  cap is a gap, not a style point.

Out of scope:

- **A consumer's own workflow being misconfigured** in a way this repository's
  documentation warns against — see the next section. That is a real
  vulnerability in **their** repository, and it is not a defect in these
  actions. Tell them, not us.
- **An action deciding wrongly.** A wrong label, a bad translation, a review
  finding that is not real — those are bugs, sometimes serious ones, and they
  belong in a public issue where they can be discussed. An action acting
  **outside what it is permitted to do** is the opposite: that is exactly a
  security report.
- Vulnerabilities in third-party dependencies with no exploitable path through
  these actions. There are no runtime dependencies, so this is almost always a
  development-tooling report — send it upstream.

## `pull_request` and `pull_request_target`

**`review` is designed for pull requests raised from within the repository.** It
reads the working tree, so the calling workflow checks the code out — and under
`pull_request` that is safe, because a fork's pull request gets a read-only
token and no secrets.

That last clause is also why the temptation exists: with no secrets, `review`
cannot run on a fork's pull request at all. The apparent fix is
`pull_request_target`, which runs the base repository's workflow with full
secrets and a write token. **Combining that trigger with a checkout of the pull
request's head is the "pwn request" pattern**, and it hands an attacker your
secrets — regardless of which action you then call.

If you use `pull_request_target`, never check out
`github.event.pull_request.head.sha`, and never run anything from the pull
request's code. We consider a report that these actions _encourage_ that
arrangement to be in scope; a report that a consumer configured it themselves is
not.

## A note on which provider you point these at

The `api-url` and the models behind it are your choice, and everything an action
sends goes to them: the content of the thread or the diff it is running on, and
the instructions you wrote. That data flow is inherent to the feature rather
than a flaw in it, so it is not a vulnerability report — but if you find that an
action sends more than that, or sends it somewhere other than the configured
endpoint, that very much is.

## Verifying what you are running

There is no bundle. What the runner executes is the JavaScript in the tag you
pinned, exactly as it appears in the repository — no `dist/`, no `node_modules`,
no build step between what you can read and what runs. Reading the source of the
action you are about to adopt is therefore a practical thing to do rather than a
formality, and it is the main reason this repository is arranged the way it is.

For the strongest guarantee, pin a commit SHA rather than a floating tag:

```yaml
- uses: ecoma-io/action-agents/review@<full-40-character-sha> # pin to a commit
```

A floating tag (`v0.1`) delivers fixes without an edit, which is usually what
you want; a SHA delivers exactly the bytes you reviewed, which is what you want
when it is not.

## Disclosure

Fixes are released before details are published. Because consumers pin a
floating tag, a fix is only actually delivered once that tag moves — so an
advisory is published after the release workflow has moved it, not before.

Credit goes to the reporter unless you ask otherwise.
