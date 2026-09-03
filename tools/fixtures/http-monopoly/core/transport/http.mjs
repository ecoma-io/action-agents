// The allowed zone: raw HTTP is the transport seam's whole job.
export function request(url, init) {
  return fetch(url, init);
}
