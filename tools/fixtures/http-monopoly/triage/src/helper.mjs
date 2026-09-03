// The import-rule canary: a production module reaching into a test module.
import { ok } from "./stub.test.mjs";
export const ready = () => ok(true);
