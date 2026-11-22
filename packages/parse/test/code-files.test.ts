import { expect, test } from "vitest";
import { isCodePath } from "../src/code-files.ts";

test.each(["src/a.ts", "a/B.cs", "pkg/x.go", "lib/y.cpp", "z.py", "k.kt", "r.rs", "J.java"])("%s is code", (path) => {
  expect(isCodePath(path)).toBe(true);
});

test.each(["package-lock.json", "yarn.lock", "go.sum", "CHANGELOG.md", "README.md", "data/x.json", "ci.yml", "logo.png", "model.safetensors", "scene.gltf", "a.golden", "Makefile"])(
  "%s is not code",
  (path) => {
    expect(isCodePath(path)).toBe(false);
  },
);

test("an extension that config maps to a lexer profile is claimed", () => {
  expect(isCodePath("shader.zig")).toBe(false);
  expect(isCodePath("shader.zig", { zig: "rust" })).toBe(true);
});
