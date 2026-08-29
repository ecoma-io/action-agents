# path-traversal fixtures

Evidence that an attacker-controlled path (PR file list, tree root, symlink)
never resolves outside the intended workspace or into `.git`, and that the
error surface a model can see never carries OS error text or runner-side
absolute paths.

| Fixture                         | Attack                                                                                                | Bounded capability                                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `symlink-maze.test.mjs`         | mid-chain symlink into nested `.git`, symlink to outside root, `a→b→a` cycle, final-component symlink | every resolution touching `.git`, the outside, or a loop is a typed `WorkspaceRefusal`; nothing outside is ever handed to a read                                                                                                   |
| `dotgit-ladder.test.mjs`        | `x/.git`, `x/./.git`, `x/../.git`, `.git`, `.Git`, `a/b/.git/HEAD`                                    | every `.git` spelling refused case-insensitively; absent variant is typed `MissingPathError`; `.github` carve-out and `src/foo.ts` baseline still resolve and read                                                                 |
| `leakless-errors.test.mjs`      | ENOTDIR / ELOOP / over-long parents, absolute-path inputs                                             | caller receives the typed safe refusal/absence; messages contain only what was asked for — no OS code, no `too many symbolic links`, no resolved absolute path                                                                     |
| `collect-files-bounds.test.mjs` | hundreds of files, real `.git` dirs, symlink cycle, outside link                                      | crawl terminates, `.git` pruned at every level, symlinks skipped (cycles cannot re-enter), every member resolves inside the root, listing capped at `MAX_LIST_ENTRIES` (or injected cap) with the cut marked, members byte-ordered |

All fixtures import the real production modules (`#core/workspace.mjs`,
`review/src/tools.mjs`, `#core/order.mjs`) and build real temp trees under
`os.tmpdir()`, cleaned up in `after()`. Deterministic and offline.

```bash
node --test security/fixtures/path-traversal/
```
