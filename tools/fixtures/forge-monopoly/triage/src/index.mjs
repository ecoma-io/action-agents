// The forge monopoly's canary: a write issued outside the forge.
export const run = (http) => http.request("/labels", { method: "POST" });
