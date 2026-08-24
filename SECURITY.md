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

## The two ceilings everything else rests on

These actions put attacker-influenced text — an issue body, a pull-request
description, a diff hunk, a file in a repository — into a model prompt, in a
process that also holds a write token and a model API key. No amount of prompt
engineering makes that text trustworthy, so the design does not try. Two
ceilings are enforced in code instead:

1. **Model output never selects an API call.** It becomes the text of a comment
   and nothing else — never a label, a review verdict, a merge, an assignment,
   or a permission change. The worst a successful injection achieves is a
   comment saying something wrong, which is visible and reversible.
2. **Everything read from a thread, a diff or a repository file is untrusted
   data, never instruction.** An action that lets a pull-request body change
   what it does has a vulnerability, not a missing feature.

A third rule applies to any action that reads files — `review` does:

3. **File access is confined to the checked-out workspace.** Every path is
   resolved through `realpath` and refused unless it lands inside
   `GITHUB_WORKSPACE`; `.git` is refused outright, because it holds the
   credential the checkout was performed with. A path escape here is a direct
   route from an injected instruction to the runner's secrets, which is why it
   is treated as a vulnerability rather than as a robustness bug.

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
- **anything that reads outside the workspace** — a path escape, a followed
  symlink, a read of `.git`, or a tool that accepts an absolute path;
- **anything that leaks the configured `api-key`** into logs, into a comment, or
  into a request to a host other than the configured `api-url`.

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
