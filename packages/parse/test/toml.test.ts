import { expect, test } from "vitest";
import { parseToml } from "../src/toml.ts";

test("reads tables, dotted tables, strings, numbers and booleans", () => {
  const text = [
    "# a comment",
    "[package]",
    'name = "core" # trailing comment',
    "version = '1.2.3'",
    "publish = false",
    "[dependencies.serde]",
    "version = 1",
  ].join("\n");
  expect(parseToml(text)).toEqual({
    package: { name: "core", version: "1.2.3", publish: false },
    dependencies: { serde: { version: 1 } },
  });
});

test("reads arrays across lines, inline tables and arrays of tables", () => {
  const text = [
    "[project]",
    "dependencies = [",
    '  "requests>=2",  # http',
    '  "click",',
    "]",
    'scripts = { run = "pkg:main", other = "pkg:other" }',
    "[[bin]]",
    'name = "a"',
    "[[bin]]",
    'name = "b"',
  ].join("\n");
  expect(parseToml(text)).toEqual({
    project: { dependencies: ["requests>=2", "click"], scripts: { run: "pkg:main", other: "pkg:other" } },
    bin: [{ name: "a" }, { name: "b" }],
  });
});

test("keeps a hash inside a string and reads quoted and dotted keys", () => {
  expect(parseToml('"odd key" = "a # b"\nx.y = 1')).toEqual({ "odd key": "a # b", x: { y: 1 } });
});
