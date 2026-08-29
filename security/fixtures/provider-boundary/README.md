# provider-boundary

Adversarial fixtures for the provider seam — the OpenAI-compatible chat API is
treated as a hostile-but-bounded network peer. Each fixture pairs a concrete
attack (a lying redirect, a Retry-After shaped to stall, an unbounded body, a
DNS rebinding attempt, a junk completion body) with a deterministic assertion
that the capability it targets stays bounded.

The enforcement under test lives in [`core/transport/http.mjs`](../../../core/transport/http.mjs)
(origin pinning, redirect ceiling, Retry-After bounds, byte caps, typed errors)
and [`core/src/chat.mjs`](../../../core/src/chat.mjs) (typed refusal of unusable
completions). Production modules are imported by their public subpaths; the
providers themselves are scripted fetches inside each fixture.

Cross-checked against the per-module unit tests so the corpus adds to them —
see `security/README.md` for the corpus contract.
