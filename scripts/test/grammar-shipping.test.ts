import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { runtimeSpec, shippedGrammarSpecs } from "@code-health/parse/grammars";
import { bundledPlugins, grammarsPath, pluginParses } from "../bundle.mjs";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A parsing plugin ships the grammar of every supported adapter and loads only the ones the analysed
 * repository has files for. Shipping is checked on the committed `dist/grammars`, loading on a copy of a
 * bundle that has lost the grammars the repository does not need.
 */
const shipped = [...new Set([...shippedGrammarSpecs().map((spec) => spec.file), runtimeSpec.file])].sort();

test("every parsing plugin ships the grammar of every supported adapter, with the runtime, and nothing else", async () => {
  const parsing: string[] = [];
  for (const plugin of bundledPlugins(root)) if (await pluginParses(plugin, root)) parsing.push(plugin);
  expect(parsing.length).toBeGreaterThan(0);
  for (const plugin of parsing) expect(readdirSync(grammarsPath(plugin, root)).sort(), plugin).toEqual(shipped);
});

let installed: string;
const repos: GitFixture[] = [];
beforeAll(() => {
  installed = mkdtempSync(join(tmpdir(), "grammar-shipping-"));
  cpSync(join(root, "plugins", "complexity", "dist"), join(installed, "dist"), { recursive: true });
  // The repositories below have TypeScript and no JavaScript, so a bundle that loads only what it finds does not need these.
  for (const file of ["tree-sitter-javascript.wasm"]) rmSync(join(installed, "dist", "grammars", file));
});
afterAll(() => {
  rmSync(installed, { recursive: true, force: true });
  for (const repo of repos) repo.dispose();
});

function repository(path: string): GitFixture {
  const repo = GitFixture.build([{ type: "commit", message: "one", date: "2024-01-01T00:00:00Z", changes: [{ op: "add", path, content: "export const a = (x: number) => x + 1;\n" }] }]);
  repos.push(repo);
  return repo;
}

function analyse(cwd: string) {
  const result = spawnSync(process.execPath, [join(installed, "dist", "complexity.mjs"), "analyse", "--json"], { cwd, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

test("a bundle analyses a repository without loading the grammars the repository has no files for", () => {
  expect(analyse(repository("src/a.ts").path)).toMatchObject({ status: 0, stderr: "" });
});

test("and asks for a grammar only when the repository has a file that needs it", () => {
  const result = analyse(repository("src/a.js").path);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("tree-sitter-javascript.wasm");
});
