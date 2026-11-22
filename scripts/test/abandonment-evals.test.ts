import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { runInProcess } from "@code-health/fixtures/cli-testing";
import { cli } from "../../packages/cochange/src/cli.ts";

vi.setConfig({ testTimeout: 120_000 });

const evals = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "cochange", "evals");
const made: string[] = [];
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** What `claude plugin eval --scaffold` does with a case's script: run it in an empty working directory. */
function scaffold(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "abandonment-eval-"));
  made.push(dir);
  execFileSync("sh", [join(evals, script)], { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  return dir;
}
const head = (dir: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
const run = async (dir: string, ...argv: string[]) => runInProcess(cli, dir, [...argv, "--json", "--limit", "all"]);

const cases = readdirSync(evals, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith("abandonment-"))
  .map((e) => ({ name: e.name, ...parse(readFileSync(join(evals, e.name, "case.yaml"), "utf8")) }));

test("the abandonment scaffolds build the same repository every time, from pinned dates", () => {
  expect(head(scaffold("abandonment-scaffold.sh"))).toBe(head(scaffold("abandonment-scaffold.sh")));
  expect(head(scaffold("abandonment-off-scaffold.sh"))).toBe(head(scaffold("abandonment-scaffold.sh")));
});

test("every scaffold a case names exists, and the cases share the two scaffolds rather than copy them", () => {
  const scaffolded = cases.filter((c) => c.context?.scaffold_script);
  expect(scaffolded.length).toBeGreaterThan(0);
  for (const c of scaffolded) expect(existsSync(join(evals, c.name, c.context.scaffold_script as string))).toBe(true);
  expect([...new Set(scaffolded.map((c) => c.context.scaffold_script as string))].sort()).toEqual(["../abandonment-off-scaffold.sh", "../abandonment-scaffold.sh"]);
});

test("the scaffold gives the answers the cases' graders look for", async () => {
  const dir = scaffold("abandonment-scaffold.sh");

  const current = JSON.parse((await run(dir, "abandonment", "current")).stdout);
  expect(current.results.filter((r: { abandoned: boolean }) => r.abandoned).map((r: { path: string }) => r.path).sort()).toEqual(["src/core/engine.ts", "src/core/parser.ts", "src/gen/deps.ts"]);
  expect(current.developers).toEqual({ active: 3, inactive: 2 });

  const simulated = JSON.parse((await run(dir, "abandonment", "simulate", "--trials", "300")).stdout);
  expect(simulated.results.population).toEqual({ activeDevelopers: 3, files: 8, peopleLines: 75 });
  expect(simulated.results.loss.lines.baseline).toBe(32);
  const files = Object.fromEntries(simulated.results.files.map((f: { path: string; findings: string[] }) => [f.path, f.findings]));
  expect(files["src/api/auth.ts"]).toEqual(["at-risk-hot"]);
  expect(files["src/core/engine.ts"]).toEqual(["abandoned", "no-successor"]);

  const successors = JSON.parse((await run(dir, "successors", "src/api/auth.ts", "--names")).stdout);
  expect(successors.results[0].successors.map((s: { developer: string }) => s.developer)).toEqual(["Ann Active <ann@example.com>", "Bob Builder <bob@example.com>"]);
});

test("the off scaffold has not opted in, so the analysis refuses until the repository does", async () => {
  const dir = scaffold("abandonment-off-scaffold.sh");
  expect(existsSync(join(dir, "code-health.json"))).toBe(false);
  const result = await run(dir, "abandonment", "current");
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("cochange.knowledge.enabled");
});
