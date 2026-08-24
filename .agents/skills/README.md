# Vendored agent skills — do not edit

The `arch-*/SKILL.md` files here are byte-identical copies of the
`@ecoma-io/archkeep` release this repository pins. This directory is one of
two: the same files are committed in the other one too, because the three
supported agents do not scan the same directory —

| Host        | `.claude/skills/` | `.agents/skills/` |
| ----------- | ------------------ | ------------------ |
| Claude Code | reads              | does not read      |
| Codex       | does not read      | reads              |
| opencode    | reads              | reads              |

— so neither one alone reaches Claude Code and Codex both.

`pnpm check-skills` fails on any difference between the two trees, on any
difference from the pinned release, and on a dependency bump that left them
behind. Editing a file here is that failure, not a fix: the text belongs to
`https://github.com/ecoma-io/archkeep`, and a change made here is lost at the
next sync.

Both this file and the copies beside it are written by
`scripts/sync-skills.mjs`, which is the only sanctioned way either changes.
The reasoning — why copies rather than a symlink, why committed rather than
generated at install time — is in `scripts/check-skills.mjs`.
