import a from "./lib";
import b from "./anon";
import C from "./classy";
import v from "./value";

export const all = [a(), b(), new C(), v];
