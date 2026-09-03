// Raw HTTP through the Headers constructor, outside the seam.
export const buildHeaders = () => new Headers({ accept: "application/vnd.github+json" });
