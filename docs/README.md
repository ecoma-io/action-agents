# Documentation

The pages here are written as they are earned. This index is the map; a row
without a link is a page that does not exist yet, and saying so is better than
a link that goes nowhere.

| Page                            | What it covers                                                             |
| ------------------------------- | -------------------------------------------------------------------------- |
| [Doctrine](doctrine.md)         | Where a new piece of code goes, and what an action may become              |
| Getting started                 | Adding one action to a workflow, and the permissions it needs              |
| Configuration                   | `.github/action-agents.json`, and the inputs each action takes             |
| `triage`, `review`, `harmonise` | One page per action: what it decides, and what it is not allowed to decide |
| Providers                       | Pointing the actions at an OpenAI-compatible endpoint, keyed or keyless    |

Doctrine comes first deliberately, and it is the only row with a link. The rows
below it describe behaviour, and no action does its work yet — a getting-started
page written now would document a step that refuses. What is settled is the
design those actions are being built to, so that is what is written.

Alongside it, the three documents at the repository root are the whole of what
else exists, and each is complete on its own:

- `README.md` — what these actions are and how one is used.
- `CONTRIBUTING.md` — everything a pull request is judged on.
- `SECURITY.md` — the threat model, and how to report a vulnerability.

A page added here must link only within `docs/` — `pnpm check-docs-links`
enforces that, because a reader inside the documentation is a documentation
reader. Root files may link inwards; pages here may not link back out.
