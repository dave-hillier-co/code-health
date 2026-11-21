// One line per lexer profile that has a structural adapter, named for the profile. UPDATE_AGREEMENT=1 adds the line
// and writes agreement-rates/<profile>.ts. See CONTRIBUTING.md, "Adding a language".
export { recorded as typescript } from "./agreement-rates/typescript.ts";
export { recorded as java } from "./agreement-rates/java.ts";
export { recorded as kotlin } from "./agreement-rates/kotlin.ts";
