# tool-protocol fixtures

The model's tool protocol, attacked from the resource-exhaustion side. Every
fixture pins the same promise: **tool answers are bounded and marked, the tool
ledger never loses captured bytes, and the loop always finalises with a
bounded, tools-withheld summarise step.**

| Fixture                             | Attack                                                                                                                                                  | Bounded capability                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search-and-read-ceilings.test.mjs` | a search whose candidate set dwarfs `MAX_SEARCH_MATCHES`; a `read_file` past `MAX_READ_BYTES`; a file exactly at the ceiling; a BOM + CRLF file past it | the answer is exactly the ceiling's worth of entries with the `(search stopped at N matches)` marker; the `(showing the first X of Y bytes)` header carries the real byte counts; the read ledger keeps every captured byte; byte counts stay byte-true for BOM and CRLF |
| `tool-call-budget.test.mjs`         | a model that never stops requesting tool calls; cumulative evidence crossing `MAX_CUMULATIVE_EVIDENCE_BYTES`; evidence staying under it                 | the loop finalises with `bound: "tool-calls"` at exactly `MAX_TOOL_CALLS` executions, tools withheld, conversation wire valid; `bound: "evidence"` on the crossing (`Partial` posture at run level); an unbounded natural stop below the cap                             |
| `args-and-json5-bounds.test.mjs`    | extra or missing tool-call arguments; one hostile call in a good batch; a ~40k-level JSON5 document, valid and unbalanced                               | typed `unknown argument` / `missing argument` refusals, the hostile call refused alone while good calls apply; the iterative parser survives the depth and refuses the unbalanced document with a typed `SyntaxError`                                                    |

Deterministic and offline: scripted trees in temp dirs, scripted chat stubs,
injected evidence delimiters, no network, no model, no timers.
