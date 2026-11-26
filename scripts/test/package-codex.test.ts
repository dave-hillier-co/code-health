import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { parse } from "yaml";
import { codexInstructions, codexSkills, packageAllCodex, packageCodex, toolRuntimeFiles } from "../package-codex.mjs";
import { distantHelpers } from "../../packages/locality/test/support/scenarios.ts";
import { manifestsRepository } from "../../packages/structure/test/packaging/support/scenarios.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const temporary = mkdtempSync(join(tmpdir(), "codex package "));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
const suite = join(temporary, "relocated suite");
beforeAll(() => {
  const built = join(temporary, "suite build");
  packageAllCodex(built, root);
  renameSync(built, suite);
});

test.each(Object.entries(codexSkills))("%s installs independently with portable instructions and its complete runtime", (name, metadata) => {
  const skill = join(suite, name);
  const instructions = readFileSync(join(skill, "SKILL.md"), "utf8");
  const frontmatter = parse(instructions.split("---")[1]!);
  expect(frontmatter.name).toBe(name);
  expect(frontmatter.description.length).toBeGreaterThan(0);
  expect(frontmatter.description.length).toBeLessThanOrEqual(1024);
  expect(frontmatter["allowed-tools"]).toBeUndefined();
  expect(parse(readFileSync(join(skill, "agents", "openai.yaml"), "utf8")).interface.display_name).toBe(metadata.title);
  expect(instructions).toContain("Codex session effort and coupled-change completeness are unavailable");
  const documents = ["SKILL.md", ...readdirSync(join(skill, "references")).map((file) => `references/${file}`)];
  for (const file of documents) {
    const text = readFileSync(join(skill, file), "utf8");
    expect(text, file).not.toMatch(/CLAUDE_PLUGIN_ROOT|~\/\.claude|allowed-tools:/);
    // Resolve Markdown links relative to their own document, including nested reference links.
    for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      const target = match[1]!;
      if (/^(https?:|#)/.test(target)) continue;
      expect(existsSync(join(dirname(join(skill, file)), target)), `${file}: ${target}`).toBe(true);
    }
  }
  // The plugin's dist holds every tool's bundle; a standalone skill carries its own tool's and no other's.
  const original = join(root, "plugins", "code-health", "dist");
  const installed = join(skill, "scripts", "dist");
  const files = readdirSync(installed, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  for (const file of files) {
    const path = join(file.parentPath, file.name).slice(installed.length + 1);
    expect(readFileSync(join(installed, path)).equals(readFileSync(join(original, path))), path).toBe(true);
  }
  const top = readdirSync(installed);
  expect(top).toEqual(expect.arrayContaining([`${metadata.tool}.mjs`, "THIRD_PARTY_NOTICES.md", "grammars"]));
  expect(top.filter((name) => !name.startsWith("chunk-") && name.endsWith(".mjs"))).toEqual([`${metadata.tool}.mjs`]);
  expect(readdirSync(join(installed, "grammars")).sort()).toEqual(readdirSync(join(original, "grammars")).sort());
});

const smokeCommands: Record<string, string[][]> = {
  "change-risk": [["risk", "HEAD~1..HEAD"]],
  identities: [["identities", "check"]],
  abandonment: [["abandonment", "current"]],
  complexity: [["analyse"], ["report", "xray", "src/shared/utils/money.ts", "--slots"]],
  locality: [["analyse"], ["move", "src/shared/utils/money.ts"]],
  structure: [["cycles"], ["report", "structure", "--slots"]],
  packaging: [["packages", "list"], ["packages", "candidates"]],
};

test.each(Object.entries(smokeCommands))("%s runs after standalone installation without changing source or HEAD", (name, commands) => {
  const repo = name === "packaging" ? manifestsRepository() : distantHelpers();
  try {
    const head = repo.git("rev-parse", "HEAD");
    const plugin = codexSkills[name as keyof typeof codexSkills].tool;
    // Copy only this skill, so siblings cannot satisfy a missing dependency.
    const installed = join(temporary, `standalone ${name}`);
    cpSync(join(suite, name), installed, { recursive: true });
    const run = (args: string[]) => spawnSync(process.execPath, [join(installed, "scripts", `${plugin}.mjs`), ...args, "--json"], { cwd: repo.path, encoding: "utf8", timeout: 60_000 });
    for (const args of commands) {
      const result = run(args);
      expect(result.status, result.stderr).toBe(0);
      const document = JSON.parse(result.stdout);
      if (args[0] === "report") {
        expect(document.stamp).toBeTruthy();
        expect(document.slots.length).toBeGreaterThan(0);
      } else {
        expect(document.command).toBe(args[0]);
        if (args[0] === "move") expect(document).toMatchObject({ applied: false, mode: "dry-run", refusals: [] });
        if (["analyse", "cycles"].includes(args[0]!) || (args[0] === "packages" && args[1] === "list")) expect(document.results.length).toBeGreaterThan(0);
      }
    }
    expect(repo.git("rev-parse", "HEAD")).toBe(head);
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(existsSync(join(installed, ".cache"))).toBe(false);
  } finally {
    repo.dispose();
  }
}, 120_000);

test("the installed locality mover leaves an authorised move staged without making a commit", () => {
  const repo = distantHelpers();
  try {
    const head = repo.git("rev-parse", "HEAD");
    const result = spawnSync(process.execPath, [join(suite, "locality", "scripts", "locality.mjs"), "move", "src/shared/utils/money.ts", "--apply", "--no-commit", "--json"], { cwd: repo.path, encoding: "utf8", timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ applied: true, commit: null, refusals: [] });
    expect(repo.git("rev-parse", "HEAD")).toBe(head);
    expect(repo.git("diff", "--cached", "--name-only")).not.toBe("");
    expect(repo.git("diff", "--name-only")).toBe("");
  } finally {
    repo.dispose();
  }
}, 120_000);

test("the CLI packages just a selected skill and refuses unknown skills or existing output", () => {
  const output = join(temporary, "selected packaging");
  const result = spawnSync(process.execPath, [join(root, "scripts/package-codex.mjs"), "--skill", "packaging", output], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(output, "SKILL.md"), "utf8")).toContain("name: packaging");
  expect(existsSync(join(output, "scripts", "structure.mjs"))).toBe(true);
  expect(() => packageCodex(output, root, "packaging")).toThrow("already exists");
  expect(() => packageAllCodex(suite, root)).toThrow("already exists");
  expect(() => packageCodex(join(temporary, "unknown"), root, "unknown")).toThrow("Unknown Codex skill");
  expect(existsSync(join(temporary, "unknown"))).toBe(false);
});

test("a relocated standalone skill analyses a repository without its source checkout", () => {
  const built = join(temporary, "built");
  packageCodex(built, root);
  const installed = join(temporary, "installed skill");
  cpSync(built, installed, { recursive: true });
  rmSync(built, { recursive: true });
  const instructions = readFileSync(join(installed, "SKILL.md"), "utf8");
  const frontmatter = parse(instructions.split("---")[1]!);
  expect(frontmatter.name).toBe("cochange");
  expect(frontmatter.description).toBeTruthy();
  expect(frontmatter.description.length).toBeLessThanOrEqual(1024);
  expect(frontmatter["allowed-tools"]).toBeUndefined();
  expect(instructions).not.toContain("CLAUDE_PLUGIN_ROOT");
  expect(instructions).toContain("completeness are unavailable");
  for (const match of instructions.matchAll(/\]\((references\/[^)#]+)(?:#[^)]*)?\)/g)) {
    expect(existsSync(join(installed, match[1]!))).toBe(true);
  }
  expect(readdirSync(join(installed, "scripts", "dist")).sort()).toEqual(toolRuntimeFiles("cochange", root));
  expect(readdirSync(join(installed, "schemas")).sort()).toEqual(readdirSync(join(root, "plugins", "code-health", "schemas", "cochange")).sort());
  expect(existsSync(join(installed, "LICENSE"))).toBe(true);
  expect(existsSync(join(installed, "scripts", "dist", "THIRD_PARTY_NOTICES.md"))).toBe(true);
  expect(() => packageCodex(installed, root)).toThrow("already exists");

  const repo = join(temporary, "target repo");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "example.ts"), "export const answer = 42;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "Initial example");
  const head = git("rev-parse", "HEAD");
  for (const args of [["hotspots"], ["brief", "example.ts"], ["report", "hotspots", "--slots"]]) {
    const result = spawnSync(process.execPath, [join(installed, "scripts", "cochange.mjs"), ...args, "--json"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    const document = JSON.parse(result.stdout);
    if (args[0] === "report") {
      expect(document.slots.length).toBeGreaterThan(0);
      expect(document.stamp).toBeTruthy();
    } else {
      expect(document.command).toBe(args[0]);
      expect(document.results).toEqual(expect.arrayContaining([expect.objectContaining({ path: "example.ts" })]));
    }
  }
  expect(existsSync(join(repo, ".cache", "code-health", "history.sqlite"))).toBe(true);
  expect(existsSync(join(installed, ".cache"))).toBe(false);
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(git("status", "--porcelain")).toBe("");
}, 120_000);

test("changed source instructions cannot silently retain a host-specific workflow", () => {
  const source = readFileSync(join(root, "plugins/code-health/skills/cochange/SKILL.md"), "utf8");
  expect(() => codexInstructions(source.replace("To ask how often agents finish a coupled change,", "Changed transcript workflow:"))).toThrow("Expected one match");
});
