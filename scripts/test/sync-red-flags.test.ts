import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { staleRedFlags, syncRedFlags } from "../sync-red-flags.mjs";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "red-flags-"));
  mkdirSync(join(root, "shared"));
  writeFileSync(join(root, "shared", "red-flags.md"), "# Red flags\n");
  for (const skill of ["a/skills/one", "a/skills/two", "b/skills/three"]) {
    mkdirSync(join(root, "plugins", skill), { recursive: true });
    writeFileSync(join(root, "plugins", skill, "SKILL.md"), "---\n---\n");
  }
  mkdirSync(join(root, "plugins", "c"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const copy = (skill: string) => join(root, "plugins", skill, "references", "red-flags.md");

test("the build copies the shared file into every skill of every plugin", () => {
  expect(syncRedFlags(root)).toHaveLength(3);
  for (const skill of ["a/skills/one", "a/skills/two", "b/skills/three"]) {
    expect(readFileSync(copy(skill), "utf8")).toBe("# Red flags\n");
  }
});

test("missing and edited copies are stale, a synced tree is not", () => {
  expect(staleRedFlags(root)).toHaveLength(3);
  syncRedFlags(root);
  expect(staleRedFlags(root)).toEqual([]);
  writeFileSync(copy("a/skills/two"), "edited\n");
  expect(staleRedFlags(root)).toEqual([copy("a/skills/two")]);
  syncRedFlags(root);
  expect(staleRedFlags(root)).toEqual([]);
});

test("a change to the shared file makes every copy stale", () => {
  syncRedFlags(root);
  writeFileSync(join(root, "shared", "red-flags.md"), "# Changed\n");
  expect(staleRedFlags(root)).toHaveLength(3);
});

test("a plugin without skills has nothing to copy", () => {
  rmSync(join(root, "plugins", "a"), { recursive: true });
  rmSync(join(root, "plugins", "b"), { recursive: true });
  expect(syncRedFlags(root)).toEqual([]);
});
