# Documentation

The pages here are written as they are earned. This index is the map; a row
without a link is a page that does not exist yet, and saying so is better than
a link that goes nowhere.

| Page                                                                     | What it covers                                                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [Doctrine](doctrine.md)                                                  | Where a new piece of code goes, and what an action may become                                |
| [Development: configuration](development/configuration.md)               | The shared config-file mechanism — discovery, format, the default branch, precedence         |
| [Development: `triage`](development/triage.md)                           | `triage`'s full design — schema, prompt, pipeline                                            |
| [Development: `harmonise`](development/harmonise.md)                     | `harmonise`'s full design — document model, prompt, pull request                             |
| [Development: `review`](development/review.md)                           | `review`'s full design — config, tool surface, agent loop                                    |
| [Development: review applicability](development/applicability-policy.md) | Design record (issue #179) — all three axes are shipped in [`review`](development/review.md) |
| [Development: the core ceilings](development/ceilings.md)                | The ceiling modules' contracts — evidence, sanitiser, marker comment, workspace, seam        |
| [Guide: getting started](guides/getting-started.md)                      | Adding one action to a workflow, and the permissions it needs                                |
| [Guide: `triage`](guides/triage.md)                                      | The label sheet, size from the diff, the marker comment, failure modes and recipes           |
| [Guide: `review`](guides/review.md)                                      | The agent loop, the tool surface, the applicability policy, the run artifact, failure modes  |
| [Guide: `harmonise`](guides/harmonise.md)                                | The language map, the glossary, skip directives, the pull request, failure modes             |
| Configuration                                                            | `.github/action-agents/<action>.json5`, and the inputs each action takes                     |
| Providers                                                                | Pointing the actions at an OpenAI-compatible endpoint, keyed or keyless                      |

Doctrine comes first deliberately. The rows below it describe behaviour that
exists — all three actions do their work, released and pinnable —
and the development pages carry each action's architecture: the contract the
shipped code is still judged against, and the ceilings the actions share.

Alongside it, the three documents at the repository root are the whole of what
else exists, and each is complete on its own:

- `README.md` — what these actions are and how one is used.
- `CONTRIBUTING.md` — everything a pull request is judged on.
- `SECURITY.md` — the threat model, and how to report a vulnerability.

A page added here must link only within `docs/` — `pnpm check-docs-links`
enforces that, because a reader inside the documentation is a documentation
reader. Root files may link inwards; pages here may not link back out.
