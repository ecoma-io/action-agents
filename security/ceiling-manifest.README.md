# The ceiling-to-fixture manifest gate

`ceiling-manifest.mjs` is the doctrine-to-proof gate for the adversarial corpus.
`run-adversarial.mjs` already fails closed on an empty corpus; this gate pins the
**mapping** between what `SECURITY.md` claims and what `security/fixtures/`
actually proves.

## What it pins

The corpus has always asserted the bounded outcome of one attack per fixture,
but nothing tied a fixture to the doctrine it substantiates. That left two
silent gaps:

- a ceiling documented in `SECURITY.md` could be claimed while **no fixture
  exercises it** — the corpus would still be green;
- a fixture could exist that **claims to pin a ceiling the doctrine never
  states** — or worse, a fixture could exist that no one can say what doctrine
  it defends.

This gate refuses the first as a **failure** and surfaces the second as a
**warning** (see _choice_ below). The mapping itself is `ceiling-manifest.json`,
a hand-maintained registry that is the single source of truth for what each
fixture is for.

## How it works

`node security/ceiling-manifest.mjs` (plain `node`, zero runtime deps):

1. reads `ceiling-manifest.json`;
2. globs `security/fixtures/**/*.test.mjs` — the same discovery
   `run-adversarial.mjs` uses;
3. for every ceiling key, requires at least one referenced fixture to exist in
   that glob. A ceiling with an empty fixture list, or one referencing a file
   that is not a real adversarial test, **fails** listing the ceiling and the
   missing/empty reference;
4. reports as a **warning** any discovered fixture that no ceiling references;
5. exits `0` on a fully-populated, consistent manifest and `1` otherwise.

Deterministic and offline: it reads one JSON file and globs a directory — no
network, no model, no timers.

## Manifest schema

`ceiling-manifest.json` is an object with:

| field         | type   | meaning                                                            |
| ------------- | ------ | ------------------------------------------------------------------ |
| `version`     | number | schema version (currently `1`)                                     |
| `base`        | string | informational; the path prefix fixture references are stored under |
| `description` | string | free-text intent                                                   |
| `ceilings`    | array  | one entry per documented ceiling                                   |

Each `ceilings` entry:

| field      | type     | meaning                                                       |
| ---------- | -------- | ------------------------------------------------------------- |
| `key`      | string   | stable identifier, e.g. `path-confinement`                    |
| `name`     | string   | human name of the ceiling                                     |
| `source`   | string   | where in `SECURITY.md` the ceiling is stated                  |
| `fixtures` | string[] | `security/fixtures/`-relative paths of the proving test files |

Fixture paths are stored relative to `security/fixtures/` (for example
`prompt-injection/off-sheet-demand.test.mjs`), matched against the normalised
glob. The `base` field is accepted but ignored for membership, so a drift in
the declared base can never paper over a real gap.

## The ceilings pinned today

`SECURITY.md`'s "The ceilings everything else rests on" states four ceilings,
and its "Scope" enumerates the further invariants in scope. Each maps to the
fixtures that prove it:

| key                                  | SECURITY.md source                   | proving fixtures                                                                                                                                              |
| ------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model-output-never-compounds-calls` | ceiling 1                            | `prompt-injection/off-sheet-demand`, `github-mutation/off-sheet-refusal`, `github-mutation/two-size-label-invariant`, `policy-tampering/tampered-instruction` |
| `sheet-and-write-surface-bounded`    | ceiling 2                            | `github-mutation/off-sheet-refusal`, `github-mutation/two-size-label-invariant`, `github-mutation/mutation-ceiling`, `policy-tampering/*`                     |
| `untrusted-is-not-instruction`       | ceiling 3                            | all `prompt-injection/*`, all `marker-forgery/*`, `policy-tampering/tampered-instruction`                                                                     |
| `path-confinement`                   | ceiling 4                            | all `path-traversal/*`                                                                                                                                        |
| `comment-write-surface`              | Scope — sanitiser / marker / mention | `prompt-injection/sanitise-rules`, `prompt-injection/hostile-filename`, all `marker-forgery/*`                                                                |
| `resource-ceilings`                  | Scope — every surface is capped      | all `tool-protocol/*`, `github-mutation/mutation-ceiling`, `provider-boundary/body-cap`, `path-traversal/collect-files-bounds`                                |
| `provider-boundary`                  | Note on provider                     | all `provider-boundary/*`                                                                                                                                     |
| `secret-hygiene`                     | Scope — api-key never leaves api-url | `provider-boundary/hostile-redirect-location`, `provider-boundary/dns-hostile-provider`                                                                       |

Every ceiling the doctrine states has real fixture coverage today, so the
manifest is fully populated and the gate exits `0` — there is no orphany to
report.

## Unreferenced fixtures: warning, not failure (the choice)

An adversarial fixture that no ceiling references can mean two very different
things: a genuinely auxiliary test, or a test that drifted from the doctrine.
Failing on it would force every such fixture into the manifest, even the
deliberately auxiliary, and would make the gate brittle to a legitimate reason
for an uncategorised test. This gate therefore reports it as a **warning**: it
is surfaced in the output, but does not change the exit code.

Run with `--strict` to promote that warning to a failure, for a CI profile that
wants a manifest where every fixture is accounted for:

```sh
node security/ceiling-manifest.mjs          # unreferenced fixture => warning
node security/ceiling-manifest.mjs --strict # unreferenced fixture => failure
```

## Maintenance rules

- **Add a fixture** to a category → add its path to every ceiling it proves in
  `ceiling-manifest.json`; otherwise the next `--strict` run flags it.
- **Add a ceiling to `SECURITY.md`** → give it a key and at least one real
  fixture, or the gate fails (the intended signal).
- **Rename/move a fixture** → update every reference in the manifest; a stale
  reference fails the gate.

The gate is wired into `pnpm security`: `run-adversarial.mjs` runs the corpus
first and then this gate with `--strict`, so the single CI entry proves both
that the fixtures hold and that the doctrine is covered. Run it standalone
with plain `node` as above when you only want the mapping check.
