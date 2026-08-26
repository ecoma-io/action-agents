/**
 * The glob dialect every pattern a consumer writes speaks, per
 * `docs/development/configuration.md`: `*` matches within one path segment,
 * a double star matches across segments, `!` at an entry's head negates it,
 * entries apply in order and the last match wins, and braces do not expand.
 *
 * This is `core/` on the doctrine's own test, honoured the way its own header
 * promised: the matcher was duplicated into `triage` and then `harmonise`,
 * and promotion was deferred until a third caller appeared — `review`'s
 * ignore set and rule includes are that third caller. The dialect is part of
 * the configuration surface every action reads, which makes it protocol: one
 * matcher here means a consumer writes patterns once and every action speaks
 * them identically.
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
      if (!last) {
        // A double star mid-pattern matches zero or more whole segments —
        // the optional slash lives inside the group so it can match none.
        regex += "(?:.*/)?";
        continue;
      }
      // A trailing double star names everything UNDER the prefix, the
      // separating slash included and required: `a/**` is a claim about a's
      // contents, never about a sibling like `ax` or about `a` itself.
      regex += index > 0 ? "/.*" : ".*";
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
