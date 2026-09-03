// The seam may issue any verb.
export function createHttp() {
  return {
    request(url, init) {
      return fetch(url, { ...init, method: init.method ?? "GET" });
    },
  };
}
