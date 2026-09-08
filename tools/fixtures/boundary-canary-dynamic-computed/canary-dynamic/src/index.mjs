// The blind spot this fixture exists to hold PINNED: a dynamic import over a
// computed specifier — a template literal, not a string literal — so no
// resolver can ever see the target. Archkeep names the site in
// `coverage.blindSpots`, flagged `dynamic: true`, and still passes the tree:
// an unresolvable dynamic site is the refusal lane's documented declared
// limit, not a silent hole. The measured pair this file must keep producing —
// exit 0, verdict "pass", `coverage.complete: true`, exactly one dynamic
// blind spot naming this file and line — is asserted by
// `tools/check-arch-canary-extended.mjs`; the file carries no other edge of
// any kind, so the blind spot is the only thing a run has to report.

/**
 * Loads a sibling module by a name known only at runtime. The specifier is a
 * computed template literal on purpose: it has no static form for a resolver
 * to read, which is exactly what makes the site a declared dynamic blind
 * spot rather than a judged edge or an unresolvable literal.
 *
 * @param {string} part the sibling module's name, without extension
 * @returns {Promise<unknown>} whatever the loaded module exports
 */
export async function loadPart(part) {
  return await import(`./${part}.mjs`);
}
