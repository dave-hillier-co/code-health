import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { withoutMeta } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";
import { buildRepo } from "./support/scenarios.ts";

const repo: GitFixture = buildRepo();
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  rmSync(join(repo.path, "code-health.json"), { force: true });
  repo.git("checkout", "--quiet", "--", ".");
});

const reportsDir = () => join(repo.path, ".cache", "code-health", "reports");
const run = async (...args: string[]) => {
  const result = await runComplexity(repo.path, [...args, "--json", "--limit", "all"]);
  expect(result.stderr).toBe("");
  return result.stdout;
};
const cacheOf = (stdout: string) => JSON.parse(stdout).inputs.resultsCache as { report: string; head: string; config: string }[] | undefined;

test.each([
  ["files", ["files"]],
  ["analyse", ["analyse"]],
  ["explain", ["explain", "src/pricing.ts#price"]],
])("%s prints the stored result the second time, says so in inputs, and the answer is the same", async (name, args) => {
  const cold = await run(...args);
  expect(cacheOf(cold)).toBeUndefined();
  const warm = await run(...args);
  expect(cacheOf(warm)).toEqual([{ report: `complexity.${name}`, head: repo.git("rev-parse", "HEAD"), config: JSON.parse(cold).config }]);
  expect(withoutMeta(warm)).toBe(withoutMeta(cold));
});

test("--no-cache computes again and stores the new result", async () => {
  await run("files");
  writeFileSync(join(reportsDir(), "complexity.files.json"), "not json");
  expect(cacheOf(await run("files", "--no-cache"))).toBeUndefined();
  expect(cacheOf(await run("files"))).toHaveLength(1);
});

test("a run over a path or one layer has its own stored result, and the plain report keeps its name", async () => {
  await run("files");
  const narrow = await run("files", "src");
  expect(cacheOf(narrow)).toBeUndefined();
  expect(cacheOf(await run("files", "src"))).toHaveLength(1);
  expect(cacheOf(await run("files", "--layer", "lexical"))).toBeUndefined();
  expect(readdirSync(reportsDir()).filter((file) => file.startsWith("complexity.files"))).toHaveLength(3);
  expect(JSON.parse(readFileSync(join(reportsDir(), "complexity.files.json"), "utf8")).inputs.paths).toEqual([]);
});

test("a new commit recomputes, and an edited file on disk is measured from its content with nothing stored", async () => {
  await run("files");
  const before = Object.fromEntries(JSON.parse(await run("files")).results.map((row: { path: string; complexity: number }) => [row.path, row.complexity]));
  writeFileSync(join(repo.path, "src/label.ts"), "export function label(n: string): string {\n  if (n) {\n    if (n.length > 1) return n;\n  }\n  return '';\n}\n");
  const edited = JSON.parse(await run("files"));
  expect(edited.inputs.tree).toBe("working-tree");
  expect(edited.inputs.resultsCache).toBeUndefined();
  const rows = Object.fromEntries(edited.results.map((row: { path: string; complexity: number }) => [row.path, row.complexity]));
  expect(rows["src/label.ts"]).toBeGreaterThan(before["src/label.ts"]!);
  expect(rows["src/pricing.ts"]).toBe(before["src/pricing.ts"]);
  expect(edited.meta.report.stored).toBe(false);

  repo.git("add", "--all");
  repo.git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "Nest label");
  const committed = await run("files");
  expect(cacheOf(committed)).toBeUndefined();
  expect(JSON.parse(committed).repo.head).toBe(repo.git("rev-parse", "HEAD"));
  expect(cacheOf(await run("files"))).toHaveLength(1);
});

test("explain is stored by the file's content, so an edit is broken down again", async () => {
  await run("explain", "src/pricing.ts#price");
  const original = readFileSync(join(repo.path, "src/pricing.ts"), "utf8");
  writeFileSync(join(repo.path, "src/pricing.ts"), original.replace("total += item * 0.8;", "total += item * 0.8;\n      total += 1;"));
  const edited = await run("explain", "src/pricing.ts#price");
  expect(cacheOf(edited)).toBeUndefined();
  expect(cacheOf(await run("explain", "src/pricing.ts#price"))).toHaveLength(1);
  writeFileSync(join(repo.path, "src/pricing.ts"), original);
  expect(cacheOf(await run("explain", "src/pricing.ts#price"))).toHaveLength(1);
});

test("a stored result keeps saying how many files were left out", async () => {
  const cold = JSON.parse(await run("files"));
  const warm = JSON.parse(await run("files"));
  expect(warm.inputs.resultsCache).toHaveLength(1);
  expect(warm.dropped).toEqual(cold.dropped);
  expect(warm.omittedByBuiltinExcludes).toEqual(cold.omittedByBuiltinExcludes);
});
