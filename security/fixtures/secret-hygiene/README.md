# secret-hygiene

Adversarial fixtures for the credential seam — the GitHub write token and the
provider API key are treated as secrets whose only sanctioned channel is the
`Authorization` header of the exact request each authenticates. Each fixture
drives a full production `triage` run — the real `main` and `run`, the real
forge and chat clients over one recording `fetch` — and asserts the plaintext
appears nowhere else: never in console output, never in a request URL, never
in a request body, never in a header that is not the `Authorization` header,
and never on the other origin.

The enforcement under test lives in [`core/src/runtime.mjs`](../../../core/src/runtime.mjs)
(`maskSecret`, emitted once per secret before anything else can print) and the
transport constructors that keep each credential to its one header
(`authorization` is set only for the exact credential, and only when
non-empty): [`core/src/chat.mjs`](../../../core/src/chat.mjs),
[`core/src/forge.mjs`](../../../core/src/forge.mjs) and
[`core/transport/http.mjs`](../../../core/transport/http.mjs). The providers
are scripted fetches inside each fixture — including the keyless path, where
an empty key must mean no header at all, never a blank one.

Cross-checked against the per-module unit tests so the corpus adds to them —
see `security/README.md` for the corpus contract.
