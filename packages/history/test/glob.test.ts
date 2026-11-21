import { expect, test } from "vitest";
import { compileGlobs } from "../src/glob.ts";

test("slashless patterns match a segment at any depth", () => {
  const match = compileGlobs(["*.min.js", "node_modules"]);
  expect(match("app.min.js")).toBe(true);
  expect(match("web/static/app.min.js")).toBe(true);
  expect(match("web/node_modules/x/index.js")).toBe(true);
  expect(match("web/app.js")).toBe(false);
});

test("patterns with a slash are anchored and cover descendants", () => {
  const match = compileGlobs(["dist/**", "/docs/generated", "src/**/*.gen.ts"]);
  expect(match("dist/a/b.js")).toBe(true);
  expect(match("packages/dist/a.js")).toBe(false);
  expect(match("docs/generated/x.md")).toBe(true);
  expect(match("src/a/b/c.gen.ts")).toBe(true);
  expect(match("src/c.gen.ts")).toBe(true);
  expect(match("src/c.ts")).toBe(false);
});

test("braces, question marks and classes", () => {
  const match = compileGlobs(["*.{png,jpg}", "file?.txt", "[ab].c"]);
  expect(match("a/b.png")).toBe(true);
  expect(match("b.jpg")).toBe(true);
  expect(match("b.gif")).toBe(false);
  expect(match("file1.txt")).toBe(true);
  expect(match("file12.txt")).toBe(false);
  expect(match("a.c")).toBe(true);
  expect(match("c.c")).toBe(false);
});

test("an empty pattern list matches nothing", () => {
  expect(compileGlobs([])("anything")).toBe(false);
});

test("an unbalanced brace is a literal, not a crash", () => {
  const match = compileGlobs(["a{b", "c}d"]);
  expect(match("a{b")).toBe(true);
  expect(match("c}d")).toBe(true);
  expect(match("ab")).toBe(false);
});
