// One line per lexer profile that has a structural adapter, named for the profile. UPDATE_AGREEMENT=1 adds the line
// and writes agreement-rates/<profile>.ts. See CONTRIBUTING.md, "Adding a language".
export { recorded as typescript } from "./agreement-rates/typescript.ts";
export { recorded as csharp } from "./agreement-rates/csharp.ts";
export { recorded as cpp } from "./agreement-rates/cpp.ts";
export { recorded as python } from "./agreement-rates/python.ts";
export { recorded as go } from "./agreement-rates/go.ts";
