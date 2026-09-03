// The provider POST lives here.
export function createChat(config) {
  return {
    async complete(messages) {
      return config.http.request("/chat/completions", { method: "POST", body: messages });
    },
  };
}
