import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { runInProcess } from "@code-health/fixtures/cli-testing";
import { cli } from "../../packages/cochange/src/cli.ts";

vi.setConfig({ testTimeout: 120_000 });

const evals = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "cochange", "evals");
const cases = readdirSync(evals, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
// The identities, abandonment and risk cases have their own scaffolds, which build different repositories.
const scaffolded = cases.filter((name) => !name.startsWith("identities-") && !name.startsWith("abandonment-") && !name.startsWith("risk-")).filter((name) => parse(readFileSync(join(evals, name, "case.yaml"), "utf8")).context?.scaffold_script);

const made: string[] = [];
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** What `claude plugin eval --scaffold` does with a case's script: run it in an empty working directory. */
function scaffold(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cochange-eval-"));
  made.push(dir);
  execFileSync("bash", [join(evals, name, "scaffold.sh")], { cwd: dir, stdio: "pipe" });
  return dir;
}

const run = async (cwd: string, ...argv: string[]) => JSON.parse((await runInProcess(cli, cwd, [...argv, "--json"])).stdout);

test("every behaviour case builds its repository, and they all build the same one", () => {
  expect(scaffolded.length).toBeGreaterThanOrEqual(4);
  const scripts = new Set(scaffolded.map((name) => readFileSync(join(evals, name, "scaffold.sh"), "utf8")));
  expect(scripts.size).toBe(1);
  const heads = scaffolded.map((name) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: scaffold(name), encoding: "utf8" }).trim());
  expect(new Set(heads).size).toBe(1);
});

test("the scaffolded history gives the answers the cases' graders look for", async () => {
  const repo = scaffold(scaffolded[0]!);

  const { results: briefing } = await run(repo, "brief", "src/billing/invoice.ts");
  expect(briefing[0].recommendation).toBe("hotspot");
  const partners = Object.fromEntries(briefing[0].alongside.map((a: { path: string; support: number }) => [a.path, a.support]));
  expect(partners).toEqual({ "src/billing/invoice.test.ts": 8, "src/app/registry.ts": 6, "src/reports/summary.ts": 6 });

  const { results: pairs } = await run(repo, "coupling", "--file", "src/billing/invoice.ts");
  const summary = pairs.find((row: { with: string }) => row.with === "src/reports/summary.ts");
  expect(summary).toMatchObject({ support: 6, findings: expect.arrayContaining(["distant-coupling", "asymmetric-coupling"]) });
  expect(summary.confidence).toBeLessThan(summary.reverseConfidence);

  const { results: ranked } = await run(repo, "hotspots", "--limit", "1");
  expect(ranked[0]).toMatchObject({ path: "src/billing/invoice.ts", recommendation: "hotspot" });
});
