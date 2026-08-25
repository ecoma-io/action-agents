# Development — `harmonise`

Design, not behaviour: nothing on this page runs yet. This is the architecture
`harmonise` is to be built to, written before implementation starts. The shared
mechanism it rests on — file discovery, the default branch, precedence — is in
[the configuration page](configuration.md); this page is the document model,
the prompt and the pull request.

## What `harmonise` decides

For every translated document in a repository: does it still convey what the
source-language version says? Where it does not, the model returns a rewritten
version, and the action proposes it. The pull request is opened unconditionally
— one drift or thirty — so what bounds that operation is the workflow's
`permissions:` block, never the model's answer. That is the branch of the
doctrine's diagram where **the model chose the text and nothing about the
call**: there is no sheet here, no operation for a model to pick, and the
rewritten text never names a path — the action already knows which file each
answer belongs to, because it enumerated the pair itself.

## Trigger and surface

`harmonise` is not a per-pull-request action. Its subject is the default
branch's documentation, so it runs on `schedule` and `workflow_dispatch`, and
reads and writes everything through the API: **no checkout, no working tree,
no files on the runner**. The working tree is not merely the wrong trust level
here — under `pull_request` it would be the wrong subject, a merge ref rather
than the branch being kept in step.

A real run needs `contents: write` and `pull-requests: write`, and the
workflow's `permissions:` block is the bound on both.

## Inputs

| Input             | Meaning                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`    | the token the action writes with — the workflow's `permissions:` block is the real bound                                                                         |
| `api-url`         | base URL of an OpenAI-compatible endpoint                                                                                                                        |
| `api-key`         | key for that endpoint; empty is a supported keyless configuration                                                                                                |
| `model`           | model id to ask                                                                                                                                                  |
| `config-path`     | overrides `.github/action-agents/harmonise/harmonise.json5` / `.json` — see the configuration page                                                               |
| `source-language` | overrides `sourceLanguage`; must name a language the file declares. Today `required: true` — implementation relaxes it to _required unless the file names it_    |
| `documents`       | glob filter over the source-document set; empty = all of them. Today's default `docs/**/*.md` becomes empty at implementation, because the map defines the space |
| `dry-run`         | report drift, propose nothing — the default, because the output of a real run is a pull request                                                                  |

## The config file

`.github/action-agents/harmonise/harmonise.json5`, in full:

```json5
{
  // The language every other version is judged against. It must be a key of
  // `languages` — the source needs a pattern like every other language.
  sourceLanguage: "en",

  // Where each language's version of a document lives, one pattern each. A
  // document is identified by its `{document}` slug: the three files below
  // with slug "getting-started" are one document in three languages, and any
  // pattern shape works — per-language directories, suffixes, or a mix.
  languages: {
    en: "docs/{document}.md",
    fr: "docs/fr/{document}.md",
    vi: "docs/vi/{document}.md",
  },

  // Generated, vendored, or deliberately untranslated — excluded from the
  // source set, so their translations are never judged. Matching nothing is
  // fine.
  ignore: ["docs/changelog/**"],

  // Prose, pointed at rather than embedded. `instruction` applies to every
  // pair; `language-instructions` applies to one language's pairs. Both
  // are optional, and these paths are the defaults. A language's convention
  // path is tried whether or not it is listed — a listed entry exists to point
  // somewhere else.
  instructions: {
    instruction: ".github/action-agents/harmonise/instruction.md",
    "language-instructions": {
      // fr: ".github/action-agents/harmonise/fr-instruction.md",
    },
  },
}
```

### Validation, all of it at startup

- **no file, or a file with no language besides the source, is a red refusal**
  — an empty policy leaves `triage` classification to do and leaves `harmonise`
  nothing at all, and a silent green here would be green-on-nothing;
- `sourceLanguage` — or the `source-language` input, which overrides it — must
  be a key of `languages`; the input naming a language the file does not
  declare is refused;
- every pattern must contain `{document}` exactly once and no other
  placeholder;
- the `documents` input, when set, must match at least one source document —
  narrowing to nothing is a misconfiguration, not an empty schedule.

## The document set

```text
sources    =  the source-language pattern, minus `ignore`, minus the `documents` filter
pairs      =  each source × each other language in the map
```

One pair is one unit of work, and a run's report is built from what happens to
each:

- **a translation that does not exist** is a gap, recorded and reported — never
  created. Writing a whole new translation is a different job from mending a
  drifting one, and if it is ever wanted it arrives as a config key
  (`createMissing`), which the schema takes additively;
- **an orphan translation** — its slug has no source — is recorded, never
  deleted;
- **an empty source, or a document past the cap (64 KiB — a policy choice,
  not an API limit; the contents API reads to 1 MiB)**, skips that pair with a
  reason, and the run continues;
- **every pair skipping** is a red run: work existed and none of it was
  attempted successfully.

## The prompt

One request per pair, assembled in one order:

```text
1  system    built in: the task, the output contract, the repository's name
             and description, the source language and the pair's language
2  custom    the instruction document, if it exists
3  language  this language's instruction, if one exists
4  evidence  the source document and the translation, wrapped as evidence
```

The output contract is JSON — a verdict, a one-line summary of the drift, and
when there is drift the complete rewritten document:

```json
{
  "drift": true,
  "summary": "The v2 flag replaced by v3 in the source; French still says v2.",
  "content": "# Premiers pas\n\n…"
}
```

**The whole document, never a patch.** A line-numbered patch is a model
composing a file format it cannot see — context that drifts by one line fails
silently. A complete replacement cannot be subtly wrong about where it lands,
and the pull request's diff shows the human exactly what changed. The cost is
tokens on large documents, which is why the cap exists and why section-wise
rewriting is a deliberate non-feature of this first version.

An answer whose `content` is byte-identical to the translation it replaces is
treated as no drift — a model that "rewrote" a file into itself proposes
nothing, and no-op files do not go into a commit.

## The pull request

Real runs write one commit to one branch and maintain one pull request:

```text
branch   harmonise/<source-language>            — recreated each run from the
                                                  default branch's head
commit   "harmonise: sync <n> documents with <source-language>"
         one commit, every rewritten translation, built through the Git data
         API — no checkout anywhere
pull     created if absent, updated in place if already open — the marker
         comment's philosophy at pull-request scale: never a second PR for the
         same work
body     action-authored: per-language list of what drifted (the sanitised
         `summary` lines), gaps, skipped pairs and why. No model text beyond
         those lines; no @mention of anyone.
```

All pairs in step → no commit, no branch, no pull request: a green run and a
log line. That is the common case on a schedule, and it is the honest one.

## Failure posture

The same law as `triage`: the provider unreachable after retries, a config
that does not validate, a set narrowed to nothing — red, not green-on-nothing.
A pair that skips does not fail the run; it is recorded in the report, and the
pull request proposes what succeeded while the log names what did not.

## What `harmonise` never does

Edit a source-language document — the source is read-only in every run. Push
to any branch but its own. Merge its own pull request. Delete an orphan
translation. Create a missing one. Mention anyone in the body it writes. The
action's whole write surface is one branch, one commit, one pull request.

## What `harmonise` will need from `core/`

| Module          | Kind     | What `harmonise` needs of it                                                                                                                                                                                         |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.mjs`      | protocol | timeouts, retries, the failure shapes a provider really returns                                                                                                                                                      |
| `chat.mjs`      | protocol | one chat-completions request per pair                                                                                                                                                                                |
| `forge.mjs`     | protocol | read default-branch files, then the Git data API — blob, tree, commit, ref — and create or update a pull request. The largest surface `forge` grows, and all of it unconditional                                     |
| `untrusted.mjs` | ceiling  | the evidence wrapper both documents are framed by                                                                                                                                                                    |
| `sanitise.mjs`  | ceiling  | the `summary` lines that reach the pull-request body — and nothing else. Document content is written verbatim: sanitising prose would corrupt legitimate documents, and the human at the pull request is the control |

No `comment.mjs` — `harmonise` writes no comments; the marker-upsert idea
reappears as the one maintained pull request. And like every action, the
config reader is `harmonise`'s own: `core/` never learns a key's name.
