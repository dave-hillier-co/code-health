import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden, withoutMeta } from "./support/golden.ts";
import { couplingHistory } from "./support/coupling-scenarios.ts";
import { runCochange } from "./support/run.ts";
import { steadyHistory } from "./support/scenarios.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = couplingHistory();
});
afterAll(() => repo.dispose());

const coupling = (...args: string[]) => runCochange(repo.path, ["coupling", ...args, "--json"]);
const rowsOf = (stdout: string) => JSON.parse(stdout).results as Record<string, any>[];

test("the default listing matches its golden", async () => {
  const { code, stdout, stderr } = await coupling();
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  expectGolden("coupling", "coupling", stdout);
});

test("--file lists the files that change with it, the named file leading each row", async () => {
  const { stdout } = await coupling("--file", "src/billing/invoice.ts");
  expectGolden("coupling", "coupling.file-invoice", stdout);
  const rows = rowsOf(stdout);
  expect(rows.every((row) => row.path === "src/billing/invoice.ts")).toBe(true);
  expect(rows.map((row) => row.with)).toEqual(["src/billing/invoice.test.ts", "src/app/registry.ts", "src/reporting/summary.ts"]);
});

test("--file focused on the other side of a pair flips confidence to match", async () => {
  const [row] = rowsOf((await coupling("--file", "src/app/registry.ts")).stdout);
  expect(row).toMatchObject({ path: "src/app/registry.ts", with: "src/billing/invoice.ts", confidence: 100, reverseConfidence: 18.5 });
  expect(row!.evidence).toMatchObject({ changesPath: 5, changesWith: 27 });
});

test("a pair is followed through a rename: an old path names the file and the new path is reported", async () => {
  const { stdout } = await coupling("--file", "src/reports/summary.ts");
  const [row] = rowsOf(stdout);
  expect(row).toMatchObject({ path: "src/reporting/summary.ts", with: "src/billing/invoice.ts", support: 5 });
  expect(JSON.parse(stdout).inputs.file).toBe("src/reporting/summary.ts");
});

test("the oversized change counts on neither side of the ratio", async () => {
  const rows = rowsOf((await coupling()).stdout);
  const registry = rows.find((row) => row.path === "src/app/registry.ts")!;
  // invoice has 27 eligible changes. Counting the bulk edit would make it 28 and the degree 5 / 16.5.
  expect(registry.evidence).toEqual({ support: 5, changesPath: 5, changesWith: 27, clearsMinimum: true });
  expect(JSON.parse((await coupling()).stdout).population).toEqual({ eligibleChanges: 32, oversizedExcluded: 1 });
});

test("distant-coupling needs distance, so a sibling test is strongly coupled but not a finding", async () => {
  const rows = rowsOf((await coupling()).stdout);
  const sibling = rows.find((row) => row.with === "src/billing/invoice.test.ts" || row.path === "src/billing/invoice.test.ts")!;
  expect(sibling).toMatchObject({ distance: 0, support: 10, findings: [] });
  const distant = rows.filter((row) => row.findings.includes("distant-coupling")).map((row) => [row.path, row.with]);
  expect(distant).toEqual([
    ["src/app/registry.ts", "src/billing/invoice.ts"],
    ["src/billing/invoice.ts", "src/reporting/summary.ts"],
  ]);
});

test("asymmetric-coupling names the file that drags the other along", async () => {
  const rows = rowsOf((await coupling()).stdout);
  const asymmetric = rows.filter((row) => row.findings.includes("asymmetric-coupling"));
  expect(asymmetric.map((row) => row.dependent).sort()).toEqual(["src/app/registry.ts", "src/reporting/summary.ts"]);
  expect(rows.find((row) => row.findings.length === 0)!.dependent).toBeNull();
});

test("a file deleted by the end of history is never reported, though its pair has the support", async () => {
  const text = (await coupling("--min-support", "1", "--limit", "all")).stdout;
  expect(text).not.toContain("src/scratch/tmp.ts");
});

test("lowering --min-support lists weaker pairs without turning them into findings", async () => {
  const rows = rowsOf((await coupling("--min-support", "3", "--limit", "all")).stdout);
  const flags = rows.find((row) => row.path === "lib/flags/off.ts")!;
  expect(flags).toMatchObject({ support: 3, distance: 4, findings: [], evidence: { clearsMinimum: false } });
  expect(rowsOf((await coupling()).stdout).some((row) => row.path === "lib/flags/off.ts")).toBe(false);
});

test("--min-degree removes pairs below it", async () => {
  const rows = rowsOf((await coupling("--min-degree", "50")).stdout);
  expect(rows.map((row) => row.path)).toEqual(["src/billing/invoice.test.ts"]);
});

test("a configured minimum distance changes what is distant", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"minDistance":3}}\n');
  try {
    const rows = rowsOf((await coupling()).stdout);
    expect(rows.some((row) => row.findings.includes("distant-coupling"))).toBe(false);
  } finally {
    rmSync(join(repo.path, "code-health.json"));
  }
});

test("rows are ordered by degree, then path", async () => {
  const rows = rowsOf((await coupling()).stdout);
  expect(rows.map((row) => row.degree)).toEqual([...rows.map((row) => row.degree)].sort((a, b) => b - a));
});

test("output is byte identical between runs apart from meta", async () => {
  const first = await coupling();
  expect((await coupling()).stdout).not.toBe("");
  expect(withoutMeta((await coupling()).stdout)).toBe(withoutMeta(first.stdout));
});

test("a bad option value is a usage error", async () => {
  expect((await coupling("--min-degree", "101")).code).toBe(ExitCode.Usage);
  expect((await coupling("--min-support", "0")).code).toBe(ExitCode.Usage);
  expect((await coupling("--min-support", "x")).code).toBe(ExitCode.Usage);
});

test("a sparse history says so instead of lowering the bar", async () => {
  const young = steadyHistory();
  try {
    const { stdout } = await runCochange(young.path, ["coupling", "--json"]);
    const document = JSON.parse(stdout);
    expect(document.results).toEqual([]);
    expect(document.note).toMatch(/not lowered/);
    expect(document.evidence.grade).toBe("weak");
    expectGolden("steady", "coupling", stdout);
  } finally {
    young.dispose();
  }
});

test("a full run is stored as a report, a filtered run is not", async () => {
  const { existsSync } = await import("node:fs");
  const report = join(repo.path, ".cache", "code-health", "reports", "cochange.coupling.json");
  rmSync(report, { force: true });
  await coupling("--file", "src/billing/invoice.ts");
  expect(existsSync(report)).toBe(false);
  await coupling();
  expect(existsSync(report)).toBe(true);
});

test("explain describes both rules", async () => {
  for (const rule of ["distant-coupling", "asymmetric-coupling"]) {
    const { code, stdout } = await runCochange(repo.path, ["explain", rule]);
    expect(code).toBe(ExitCode.Success);
    expect(stdout).toContain(`${rule}:`);
  }
  expect((await runCochange(repo.path, ["explain", "nonsense"])).code).toBe(ExitCode.Usage);
});

test("the printed output, with meta, matches the coupling schema", async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "cochange", "schemas");
  const ajv = new Ajv2020Module.default({ strict: true, allErrors: true });
  addFormatsModule.default(ajv);
  for (const name of ["common", "coupling"]) ajv.addSchema(JSON.parse(readFileSync(join(dir, `${name}.schema.json`), "utf8")));
  const validate = ajv.getSchema("coupling.schema.json")!;
  for (const args of [[], ["--file", "src/billing/invoice.ts"]]) {
    const ok = validate(JSON.parse((await coupling(...args)).stdout));
    expect(ok ? [] : validate.errors).toEqual([]);
  }
});

test("--file names the file now at that path when the path was reused after a rename", async () => {
  const content = (name: string, version: number) =>
    [...Array.from({ length: 9 }, (_, i) => `export const ${name}Step${i} = ${i};`), `export const ${name} = ${version};`, ""].join("\n");
  const history = GitFixture.build([
    { type: "commit", message: "old a", date: "2024-01-01T09:00:00Z", changes: [
      { op: "add", path: "src/a.ts", content: content("a", 1) },
      { op: "add", path: "lib/x.ts", content: content("x", 1) },
    ] },
    { type: "commit", message: "a and x", date: "2024-01-02T09:00:00Z", changes: [
      { op: "modify", path: "src/a.ts", content: content("a", 2) },
      { op: "modify", path: "lib/x.ts", content: content("x", 2) },
    ] },
    { type: "commit", message: "rename a to b", date: "2024-01-03T09:00:00Z", changes: [{ op: "rename", from: "src/a.ts", path: "src/b.ts" }] },
    { type: "commit", message: "b and x", date: "2024-01-04T09:00:00Z", changes: [
      { op: "modify", path: "src/b.ts", content: content("a", 3) },
      { op: "modify", path: "lib/x.ts", content: content("x", 3) },
    ] },
    { type: "commit", message: "new a", date: "2024-01-05T09:00:00Z", changes: [
      { op: "add", path: "src/a.ts", content: content("newA", 1) },
      { op: "add", path: "app/y.ts", content: content("y", 1) },
    ] },
    { type: "commit", message: "new a and y", date: "2024-01-06T09:00:00Z", changes: [
      { op: "modify", path: "src/a.ts", content: content("newA", 2) },
      { op: "modify", path: "app/y.ts", content: content("y", 2) },
    ] },
  ]);
  try {
    const { stdout } = await runCochange(history.path, ["coupling", "--file", "src/a.ts", "--min-support", "1", "--min-degree", "0", "--json"]);
    const document = JSON.parse(stdout);
    expect(document.inputs.file).toBe("src/a.ts");
    expect(rowsOf(stdout).map((row) => row.with)).toEqual(["app/y.ts"]);
  } finally {
    history.dispose();
  }
});
