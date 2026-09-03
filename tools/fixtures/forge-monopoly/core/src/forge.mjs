// The allowed file in miniature: GitHub writes live here.
export function createForge(config) {
  const http = config.http;
  return {
    async whoami() {
      return http.request("/user");
    },
    async createComment(number, body) {
      return http.request("/issues/" + number + "/comments", {
        method: "POST",
        body,
      });
    },
  };
}
