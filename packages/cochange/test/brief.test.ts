import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { reportPath } from "../src/reports.ts";
import { couplingHistory } from "./support/coupling-scenarios.ts";
import { expectGolden } from "./support/golden.ts";
import { runCochange, runCochangeOnTerminal } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = couplingHistory();
});
afterAll(() => repo.dispose());

const brief = (...args: string[]) => runCochange(repo.path, ["brief", ...args, "--json"]);
const rowsOf = (stdout: string) => JSON.parse(stdout).results as any[];

const invoice = "src/billing/invoice.ts";

test("the briefing for two files matches its golden", async () => {
  const { code, stdout, stderr } = await brief(invoice, "src/app/registry.ts");
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  expectGolden("coupling", "brief", stdout);
});

test("alongside lists the files that usually change with the file, strongest first, with confidence both ways", async () => {
  const [row] = rowsOf((await brief(invoice)).stdout);
  expect(row.alongside.map((a: any) => a.path).sort()).toEqual([
    "src/app/registry.ts",
    "src/billing/invoice.test.ts",
    "src/reporting/summary.ts",
  ]);
  const registry = row.alongside.find((a: any) => a.path === "src/app/registry.ts");
  expect(registry).toMatchObject({ support: 5, distance: 2 });
  expect(registry.confidence).toBeLessThan(registry.reverseConfidence);
  const confidences = row.alongside.map((a: any) => a.confidence);
  expect(confidences).toEqual([...confidences].sort((x: number, y: number) => y - x));
});

test("a file deleted before the end of the window is never named as a partner", async () => {
  const [row] = rowsOf((await brief(invoice, "--partners", "20")).stdout);
  expect(row.alongside.map((a: any) => a.path)).not.toContain("src/scratch/tmp.ts");
});

test("the oversized bulk change counts on neither side of the confidence", async () => {
  const [row] = rowsOf((await brief("src/reporting/summary.ts")).stdout);
  const withInvoice = row.alongside.find((a: any) => a.path === invoice);
  // five shared changes, all before the move, and the summary has 5 + 1 (the move) eligible changes.
  expect(withInvoice).toMatchObject({ support: 5, confidence: 83.3 });
});

test("a path that was renamed away is followed to the file's current path and says what was asked", async () => {
  const [row] = rowsOf((await brief("src/reports/summary.ts")).stdout);
  expect(row).toMatchObject({ path: "src/reporting/summary.ts", requested: "src/reports/summary.ts", exists: true });
  expect(row.frequency).toBeGreaterThan(0);
});

test("a path with no history is a row with a note, not an error", async () => {
  const { code, stdout } = await brief("src/nowhere/new.ts");
  expect(code).toBe(ExitCode.Success);
  const [row] = rowsOf(stdout);
  expect(row).toMatchObject({ path: "src/nowhere/new.ts", exists: false, frequency: 0, lastChanged: null, alongside: [] });
  expect(row.note).toContain("not in the tree");
});

test("./ prefixes and absolute paths inside the repository name the same file", async () => {
  const plain = rowsOf((await brief(invoice)).stdout);
  expect(rowsOf((await brief(`./${invoice}`)).stdout)).toEqual(plain);
  expect(rowsOf((await brief(join(repo.path, invoice))).stdout)).toEqual(plain);
});

test("--partners cuts the list and counts what it left out", async () => {
  const [row] = rowsOf((await brief(invoice, "--partners", "1")).stdout);
  expect(row.alongside).toHaveLength(1);
  expect(row.alongsideNotShown).toBe(2);
});

test("asking for the same file twice gives one row", async () => {
  expect(rowsOf((await brief(invoice, invoice)).stdout)).toHaveLength(1);
});

test("without a path it is a usage error", async () => {
  const { code, stderr } = await runCochange(repo.path, ["brief", "--json"]);
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toContain("at least one file path");
});

test("partners under the degree guideline are listed after those at or above it, and marked", async () => {
  const file = join(repo.path, "code-health.json");
  writeFileSync(file, JSON.stringify({ cochange: { minDegree: 50 } }));
  try {
    const [row] = rowsOf((await brief(invoice)).stdout);
    const marks = row.alongside.map((a: any) => a.aboveGuideline);
    expect(marks).toContain(true);
    expect(marks).toContain(false);
    expect(marks).toEqual([...marks].sort((x: boolean, y: boolean) => Number(y) - Number(x)));
    expect(row.alongside.every((a: any) => a.aboveGuideline === a.degree >= 50)).toBe(true);
  } finally {
    rmSync(file, { force: true });
  }
});

test("a briefing is never stored as a report", async () => {
  await brief(invoice);
  expect(existsSync(reportPath(repo.path, "brief"))).toBe(false);
});

test("each row counts the changes eligible for coupling and the ones left out as oversized", async () => {
  const [row] = rowsOf((await brief(invoice)).stdout);
  expect(row).toMatchObject({ frequency: 28, eligibleChanges: 27, oversizedChanges: 1 });
});

test("with no partner at the support guideline the note gives both counts and names the coupling command", async () => {
  const [row] = rowsOf((await brief("src/bulk/file00.ts")).stdout);
  expect(row).toMatchObject({ frequency: 2, eligibleChanges: 1, oversizedChanges: 1, alongside: [] });
  expect(row.note).toContain("Nothing shares at least 5 changes with it");
  expect(row.note).toContain("Of its 2 changes, 1 was eligible for coupling and 1 was left out as oversized");
  expect(row.note).toContain("cochange coupling --file src/bulk/file00.ts --min-support N");
});

test("on a terminal it prints one row per file", async () => {
  const { stdout } = await runCochangeOnTerminal(repo.path, ["brief", invoice]);
  expect(stdout.split("\n")[0]).toContain("alongside");
  expect(stdout).toContain(invoice);
});
