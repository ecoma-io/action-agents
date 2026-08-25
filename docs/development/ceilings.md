# Development — the core ceilings

The four modules the security policy's ceilings rest on, their contracts
written before implementation: `untrusted.mjs`, `sanitise.mjs`,
`comment.mjs` and `workspace.mjs`. The first three exist and carry their
tests; `workspace.mjs` waits for `review`, its one consumer. The security
policy at the repository root is the authority, this page is the
architectural half.

## `core/untrusted.mjs` — evidence

One wrapper for every piece of thread, diff or file content that enters any
prompt. The content sits between delimiters the action generates; the delimiter
is random per run, so content cannot predict or forge its own closing delimiter,
and a collision inside the content is escaped deterministically. An evidence
block is capped at 64 KiB and what is cut is marked inside the wrapper, never
silent. The wrapper frames, it does not protect: no ceiling rests on the framing,
and the ceilings that bite are exact match and the sanitiser downstream —
[the doctrine](../doctrine.md) carries the reasoning.

## `core/sanitise.mjs` — comment text

Everything a model wrote that a human reads as comment text passes through here.
Four rules, each testable:

1. **no mention parses** — an `@` followed by an identifier character is broken
   up (a zero-width non-joiner after it), so nothing an action writes can notify
   anyone, on any re-run;
2. **no raw HTML renders** — a tag-shaped sequence outside a code span is
   entity-escaped, so model text carries structure only as Markdown the comment's
   scaffolding already chose;
3. **the comment's own structure cannot be forged** — the marker and the
   scaffolding's structural tokens cannot appear in model text and are removed
   and logged if they do, so injected Markdown cannot close a container early or
   pose as the action's voice;
4. **length caps with visible truncation** — a field cut is marked cut, never
   silently dropped.

Sanitising is lossy on purpose — a finding mangled by these rules is the
intended outcome, and the one deliberate exception is `harmonise`'s document
content, written verbatim for the reason its page carries.

## `core/comment.mjs` — the marker upsert

One comment per action per thread, found by author first, then by exact marker.
The marker is an HTML comment, invisible in rendered Markdown, carrying the
action's name and a run-scoped id; the sanitiser guarantees model text cannot
contain it. If a race or a rename leaves several matches, the newest wins and
the losers are deleted with a log line — the upsert keeps exactly one. Where the
action records a head commit, a comment holding a newer head than this run's
is never overwritten: the older review is abandoned with a log line instead.

## `core/workspace.mjs` — path confinement

Every path a file-reading tool accepts is resolved through `realpath` and must
land inside `GITHUB_WORKSPACE`; absolute paths and escapes are refused, a
symlink that resolves outside is refused by the same test, and `.git` is
refused outright because it holds the credential the checkout was performed with.
One consumer today: `review`.

## The seam

`chat.mjs` and `http.mjs` are protocols, but one ceiling is enforced at their
seam: every request goes to the configured `api-url`, and a redirect that
leaves the configured origin is refused rather than followed — the api-key never
crosses to a second host. The key is masked from the moment it is read.
