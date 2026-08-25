/**
 * The glob dialect every pattern a consumer writes speaks, per
 * `docs/development/configuration.md`: `*` matches within one path segment,
 * a double star matches across segments, `!` at an entry's head negates it,
 * entries apply in order and the last match wins, and braces do not expand.
 *
 * It lives in `triage/` rather than `core/` on the doctrine's own test: a
 * matcher speaks no protocol from outside this repository and enforces no
 * ceiling, so it belongs to the action that needed it — duplicated into the
 * second action when one needs it, promoted once a third caller appears.
 * `triage`'s `size.exclude` is its first consumer.
 *
 * A pattern matches the whole path — there is no implicit any-depth the way
 * gitignore has one. `pnpm-lock.yaml` names one file at the root; the same
 * name under a double star and a slash names it anywhere; a lone double
 * star matches everything. (A double star followed by a slash cannot be
 * written inside a block comment — it closes the comment — so this
 * paragraph spells it out instead.)
 */

/**
 * @param {string} pattern one pattern, no leading `!`
 * @returns {RegExp}
 */
function compile(pattern) {
  const segments = pattern.split("/");
  let regex = "^";
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index] ?? "";
    const last = index === segments.length - 1;
    if (segment === "**") {
      // A double star mid-pattern matches zero or more whole segments —
      // the optional slash lives inside the group so it can match none. A
      // trailing double star matches whatever remains.
      regex += last ? ".*" : "(?:.*/)?";
      continue;
    }
    regex += segment
      .split("*")
      .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    if (!last && segments[index + 1] !== "**") regex += "/";
  }
  return new RegExp(`${regex}$`);
}

/**
 * Whether `path` matches the patterns, last match winning.
 *
 * @param {string[]} patterns entries in order; a leading `!` negates
 * @param {string} path the path to test
 * @returns {boolean}
 */
export function matchGlob(patterns, path) {
  let matched = false;
  for (const entry of patterns) {
    if (entry === "") continue;
    const negated = entry.startsWith("!");
    const pattern = negated ? entry.slice(1) : entry;
    if (compile(pattern).test(path)) matched = !negated;
  }
  return matched;
}
