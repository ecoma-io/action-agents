// A production module opening its own socket: the invariant's whole point.
export function bad() {
  return fetch("https://api.github.com/x");
}
