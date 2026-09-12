# Architecture-report fixtures

Adversarial corpus for the `architecture-report` input: the delta envelope a
consumer's pinned archkeep step leaves in the workspace is untrusted bytes —
shaped by the code the PR author wrote and by whatever the step itself chose
to write — and these fixtures mount attacks through it against the production
review run.

| Fixture                     | Attack                                                                                                                                                                                                                                                                                    | Bounded outcome                                                                                                                                                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hostile-envelope.test.mjs` | A coherent-but-hostile envelope: coverage notes that issue instructions, a waived row whose reason carries a mention and HTML, a violation note that opens with a newline-dash to forge a bullet, a decision ref shaped like a traversal path, and an obedient model echoing it all back. | The report reaches the model only as one code-built, flattened evidence block that cannot forge line structure; the traversal ref is refused by shape before any read; the echoed comment is sanitised (no live mention, no raw HTML, no forged marker); the only forge write is the one comment upsert. |

## Running

```sh
node --test security/fixtures/arch-report/
```

`node:test` + `node:assert/strict` only, deterministic and offline. Each file
builds its own minimal fakes (forge, chat, io, workspace) and never imports
another test file or any test-only helper.
