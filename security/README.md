# Security Adversarial Corpus

An executable form of the repository's security doctrine. Where
[`SECURITY.md`](../SECURITY.md) and [`docs/doctrine.md`](../docs/doctrine.md)
say _what_ the ceilings guarantee, this tree proves it: each fixture is a
concrete adversarial input — a forged marker, a hostile redirect `Location`,
a path escape, an off-sheet label demand, a policy-tampering payload, a
resource-exhaustion input — paired with a deterministic assertion that the
capability it targets stays bounded.

Every fixture established the same shape:

```text
attack attempted
      →
capability remains bounded
```

## How to run

```bash
pnpm security
```

The runner hands the whole `security/fixtures/**/*.test.mjs` tree to the Node
test runner (the same shape as `pnpm test:tools`). There is no separate harness
to trust — `node --test` is the runner, and each fixture imports the real
production modules and asserts boundedness. CI runs it as a required step
alongside `test:tools`, so a regression on any boundary turns the build red.

## The corpus is deterministic and offline

A fixture never calls a live model or a network endpoint. That is deliberate:
the ceilings must hold **independent of model strength and provider behaviour**,
including the weak and keyless paths. A bounded capability proved once against
a hostile input is a fact the runner can re-prove on every run without any
moving part beyond Node itself.

## Layout

```text
security/
  run-adversarial.mjs        # the `pnpm security` runner
  fixtures/
    prompt-injection/        # evidence-delimiter forgery, framing, off-sheet demands
    path-traversal/          # symlink->.git, symlink cycles, absolute / .. escapes
    github-mutation/         # op-set bounds, size-label invariant, exact-match sheet
    marker-forgery/          # forged markers, container / mention injection
    provider-boundary/       # hostile Location / Retry-After, byte caps, hang bounds
    policy-tampering/        # schemaVersion refusals, stale-base / fork governance
    tool-protocol/           # tool-call ceilings, evidence budgets, exhaustion
```

Each category maps to one attack surface in the doctrine; fixtures inside it
are cross-checked against the existing per-module unit tests so the corpus
**adds** to them rather than duplicating them.

## What is and is not in scope

In scope: adversarial fixtures, deterministic tests, the `pnpm security` gate,
and CI wiring. The corpus changes **no runtime behaviour** of any action — it
imports the real modules and asserts the boundedness they already enforce. A
fixture that fails is either a genuine regression in a ceiling (a security
report) or a corpus bug, and the doctrine's "an action acting outside what it
is permitted to do" rule is what decides which.
