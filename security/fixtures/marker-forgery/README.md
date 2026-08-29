# marker-forgery — the impersonation-proof surface

Fixtures proving the doctrine's "an action can be impersonated by nobody,
not even by content it renders": model text and thread content cannot forge
an action's marker, notify anyone, open an HTML container, or write under
another action's identity.

| File                           | Attack → bounded outcome                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marker-forgery.test.mjs`      | A model embeds the action's own marker syntax, closes the container early, and a human quotes the bot's marker → exactly one marker block survives (the upsert's own), the forged text is inert, and every human comment is byte-identical. |
| `mention-defang.test.mjs`      | Findings carry `@everyone`, `@org/team`, `@user`, `@@double`, hyphenated names → no string GitHub would notify on survives any render path (ZWSP-broken).                                                                                   |
| `container-injection.test.mjs` | `<details>/<summary>/<img onerror>/<script>` and `javascript:` links → no tag-shaped `<` survives, so no container opens and no handler can attach; the review comment's own collapse stays the only container.                             |
| `cross-action-marker.test.mjs` | Text or comments carrying another action's marker (`<!-- action-agents:review:… -->`) → the action writes only under its own namespace, and foreign markers are untrusted text left byte-identical.                                         |

All fixtures import the real production modules (`core/src/sanitise.mjs`,
`core/src/comment.mjs`, `triage/src/index.mjs`, `review/src/render.mjs`)
and drive them with minimal in-file fakes. Deterministic and offline.
