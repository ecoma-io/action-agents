# Prompt-injection fixtures

Adversarial corpus: each fixture mounts one prompt-injection attack against the
production modules and asserts the same invariant — **attack → capability
remains bounded** — plus the exact bounded outcome.

| Fixture                               | Attack                                                                                                                                               | Bounded outcome                                                                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence-delimiter-forgery.test.mjs` | A hostile body prints the run's own `[end-evidence:<id>]` to close the evidence frame early and stand outside it as instruction.                     | The frame closes exactly once per block; a forged close is escaped to an inert ZWSP form inside the block; nothing lands after the legit close.                                                                 |
| `framing-duplication.test.mjs`        | A hostile body reprints the framing boilerplate, a fake labels-sheet JSON, or the task-instruction lines as a second "frame".                        | Frame/close counts stay exactly one per block; forged copies ride inside the evidence block and never reach the system message; a complying model writes the same labels as the honest body.                    |
| `hostile-filename.test.mjs`           | A PR filename or review finding path carries a delimiter collision, a newline, a mention, or HTML that would shadow the action's own comment markup. | Prompt side: hostile names stay inside the diff-stats evidence block (colliding close escaped). Comment side: paths defanged, mentions broken, HTML escaped, beakons stripped — the write surface is the sheet. |
| `sanitise-rules.test.mjs`             | Model text forges comment structure, raw HTML, mentions, newlines, or a code-span "trust" zone.                                                      | Core rules hold directly: no structural token, no raw HTML, no mention, visible caps; `one-line` flattens any whitespace run.                                                                                   |
| `off-sheet-demand.test.mjs`           | A hostile PR body demands a label the sheet does not declare.                                                                                        | The sheet — never the body — is the exact-match ceiling: off-sheet names are refused and logged, a partly off-sheet answer applies only its on-sheet half, an entirely off-sheet answer writes nothing.         |

## Running

```sh
node --test security/fixtures/prompt-injection/
```

`node:test` + `node:assert/strict` only, deterministic and offline. Each file
builds its own minimal fakes (forge client, chat, evidence, io) and never
imports another test file or any test-only helper.
