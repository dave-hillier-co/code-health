import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { allowedToolFor, checkSkills } from "../check-skills.mjs";
import { syncRedFlags } from "../sync-red-flags.mjs";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-"));
  mkdirSync(join(root, "shared"));
  writeFileSync(join(root, "shared", "red-flags.md"), "# Red flags\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const good = (plugin: string, skill: string) =>
  [
    "---",
    `name: ${skill}`,
    "description: Use before refactoring, to see what usually changes together.",
    `allowed-tools: ${allowedToolFor(plugin)}`,
    "---",
    "",
    "# Skill",
    "",
    "See [red flags](references/red-flags.md).",
    "",
  ].join("\n");

function skill(plugin: string, name: string, text: string) {
  const dir = join(root, "plugins", plugin, "skills", name);
  mkdirSync(dir, { recursive: true });
  // The CLIs a skill may pre-approve are the packages with a CLI source: here, one named for the plugin.
  mkdirSync(join(root, "packages", plugin, "src"), { recursive: true });
  writeFileSync(join(root, "packages", plugin, "src", "main.ts"), "");
  writeFileSync(join(dir, "SKILL.md"), text);
  syncRedFlags(root);
  return dir;
}

test("a skill that follows the conventions has no problems", () => {
  skill("p", "briefing", good("p", "briefing"));
  expect(checkSkills(root)).toEqual({ skills: 1, problems: [] });
});

test("allowed-tools may be written as a list", () => {
  skill("p", "briefing", good("p", "briefing").replace(/allowed-tools: .*/, `allowed-tools:\n  - ${allowedToolFor("p")}`));
  expect(checkSkills(root).problems).toEqual([]);
});

test("SKILL.md over 500 lines is reported", () => {
  skill("p", "long", good("p", "long") + "line\n".repeat(500));
  expect(checkSkills(root).problems).toEqual([expect.stringContaining("limit is 500")]);
});

test("exactly 500 lines is allowed", () => {
  const text = good("p", "edge");
  const filler = 500 - text.split("\n").length + 1;
  skill("p", "edge", text + "line\n".repeat(filler));
  expect(checkSkills(root).problems).toEqual([]);
});

test("a name that differs from the folder, a missing description and no frontmatter are reported", () => {
  skill("p", "one", good("p", "other"));
  skill("p", "two", good("p", "two").replace(/description: .*\n/, ""));
  skill("p", "three", "# No frontmatter\n");
  const problems = checkSkills(root).problems.join("\n");
  expect(problems).toContain('plugins/p/skills/one/SKILL.md: name must be "one"');
  expect(problems).toContain("plugins/p/skills/two/SKILL.md: description is required");
  expect(problems).toContain("plugins/p/skills/three/SKILL.md has no YAML frontmatter");
});

test("allowed-tools must be one of the plugin's CLIs and nothing broader", () => {
  skill("p", "wide", good("p", "wide").replace(/allowed-tools: .*/, "allowed-tools: Bash"));
  skill("p", "other", good("p", "other").replace(/allowed-tools: .*/, `allowed-tools: ${allowedToolFor("q")}`));
  skill("p", "extra", good("p", "extra").replace(/allowed-tools: .*/, `allowed-tools: ${allowedToolFor("p")} Read`));
  skill("p", "absent", good("p", "absent").replace(/allowed-tools: .*\n/, ""));
  const problems = checkSkills(root).problems;
  expect(problems).toHaveLength(4);
  expect(problems.every((p) => p.includes("allowed-tools must be exactly"))).toBe(true);
});

test("the generated red-flags reference must exist, and references hold Markdown only", () => {
  const dir = skill("p", "briefing", good("p", "briefing"));
  rmSync(join(dir, "references", "red-flags.md"));
  writeFileSync(join(dir, "references", "notes.txt"), "x");
  const problems = checkSkills(root).problems.join("\n");
  expect(problems).toContain("references/red-flags.md is missing");
  expect(problems).toContain("references/notes.txt: references holds Markdown files only");
});

test("a link to a reference that does not exist is reported", () => {
  skill("p", "briefing", good("p", "briefing") + "\nSee [more](references/missing.md).\n");
  expect(checkSkills(root).problems).toEqual([expect.stringContaining("references/missing.md, which does not exist")]);
});
