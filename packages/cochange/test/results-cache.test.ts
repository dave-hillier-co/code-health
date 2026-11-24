import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { reportPath } from "../src/reports.ts";
import { couplingHistory } from "./support/coupling-scenarios.ts";
import { withoutMeta } from "./support/golden.ts";
import { runCochange, runCochangeOnTerminal } from "./support/run.ts";

const main = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");

const repo: GitFixture = couplingHistory();
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
  rmSync(join(repo.path, "code-health.json"), { force: true });
  repo.git("checkout", "--quiet", "--", ".");
});

const invoice = "src/billing/invoice.ts";
const run = async (...args: string[]) => {
  const result = await runCochange(repo.path, [...args, "--json", "--limit", "all"]);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(ExitCode.Success);
  return result.stdout;
};
const cacheOf = (stdout: string) => JSON.parse(stdout).inputs.resultsCache as { report: string; head: string; config: string }[] | undefined;
const reports = () => readdirSync(join(repo.path, ".cache", "code-health", "reports")).sort();

test("the second run of an analysis prints the stored result and says so in inputs, and the answer is the same", async () => {
  const cold = await run("hotspots");
  expect(cacheOf(cold)).toBeUndefined();
  const warm = await run("hotspots");
  expect(cacheOf(warm)).toEqual([{ report: "cochange.hotspots", head: repo.git("rev-parse", "HEAD"), config: JSON.parse(cold).config }]);
  expect(withoutMeta(warm)).toBe(withoutMeta(cold));
  expect(JSON.parse(warm).meta.report).toEqual({ stored: true });
});

test("a warm run reads no history", async () => {
  const cold = await run("coupling");
  rmSync(join(repo.path, ".cache", "code-health", "history.sqlite"));
  const warm = await run("coupling", "--no-refresh");
  expect(cacheOf(warm)).toHaveLength(1);
  expect(withoutMeta(warm)).toBe(withoutMeta(cold));
});

test("--no-cache computes again, stores the new result, and a later run reads it", async () => {
  const first = await run("hotspots");
  writeFileSync(reportPath(repo.path, "hotspots"), "not json");
  const forced = await run("hotspots", "--no-cache");
  expect(cacheOf(forced)).toBeUndefined();
  expect(withoutMeta(forced)).toBe(withoutMeta(first));
  expect(cacheOf(await run("hotspots"))).toHaveLength(1);
});

test("a stored result written by different code is not read, and the result stored in its place is", async () => {
  await run("hotspots");
  const file = reportPath(repo.path, "hotspots");
  const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  expect(typeof stored.codeIdentity).toBe("string");
  writeFileSync(file, JSON.stringify({ ...stored, codeIdentity: "another-build" }));
  expect(cacheOf(await run("hotspots"))).toBeUndefined();
  expect(JSON.parse(readFileSync(file, "utf8")).codeIdentity).toBe(stored.codeIdentity);
  expect(cacheOf(await run("hotspots"))).toHaveLength(1);
});

test("a stored result with no code identity is not read", async () => {
  await run("hotspots");
  const file = reportPath(repo.path, "hotspots");
  const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete stored.codeIdentity;
  writeFileSync(file, JSON.stringify(stored));
  expect(cacheOf(await run("hotspots"))).toBeUndefined();
});

test("a stored result that is not whole is computed again", async () => {
  await run("hotspots");
  writeFileSync(reportPath(repo.path, "hotspots"), '{"tool":"cochange"');
  expect(cacheOf(await run("hotspots"))).toBeUndefined();
  expect(cacheOf(await run("hotspots"))).toHaveLength(1);
});

test("a new commit recomputes once, from history refreshed incrementally, and the result after it is stored", async () => {
  await run("hotspots");
  repo.commit({ message: "Touch the invoice", date: "2024-06-02T09:00:00+00:00", changes: [{ op: "modify", path: invoice, content: "export const invoice = 99;\n" }] });
  const changed = await run("hotspots");
  expect(cacheOf(changed)).toBeUndefined();
  const rows = JSON.parse(changed).results as { path: string; frequency: number }[];
  const before = JSON.parse(await run("hotspots", "--no-cache")).results as typeof rows;
  expect(rows).toEqual(before);
  expect(cacheOf(await run("hotspots"))).toEqual([expect.objectContaining({ head: repo.git("rev-parse", "HEAD") })]);
});

test("a changed config is a different result", async () => {
  await run("coupling");
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"minSupport":3}}\n');
  const changed = await run("coupling");
  expect(cacheOf(changed)).toBeUndefined();
  expect(JSON.parse(changed).inputs.minSupport).toBe(3);
  expect(cacheOf(await run("coupling"))).toHaveLength(1);
});

test("uncommitted edits do not change a history result, so it is stored and read from a dirty tree", async () => {
  const clean = await run("coupling");
  writeFileSync(join(repo.path, invoice), "export const invoice = 'edited';\n");
  const dirty = await run("coupling");
  expect(JSON.parse(dirty).repo.dirty).toBe(true);
  expect(cacheOf(dirty)).toHaveLength(1);
  expect(JSON.parse(dirty).results).toEqual(JSON.parse(clean).results);
});

test("each stated input has its own stored result: the plain report keeps the name other plugins read", async () => {
  await run("coupling");
  await run("coupling", "--min-support", "3");
  await run("coupling", "--since", "2024-01-01");
  expect(reports().filter((name) => name.startsWith("cochange.coupling"))).toHaveLength(3);
  expect(JSON.parse(readFileSync(reportPath(repo.path, "coupling"), "utf8")).inputs.minSupport).toBe(5);
  const again = await run("coupling", "--min-support", "3");
  expect(cacheOf(again)).toHaveLength(1);
  expect(JSON.parse(again).inputs.minSupport).toBe(3);
  const since = JSON.parse(await run("coupling", "--since", "2024-01-01"));
  expect(since.window.since).toBe("2024-01-01T00:00:00.000Z");
});

test("a change to the identity files is a different result", async () => {
  await run("hotspots");
  mkdirSync(join(repo.path, ".code-health", "local"), { recursive: true });
  writeFileSync(join(repo.path, ".code-health", "local", "mailmap"), "Alice <alice@example.com>\n");
  const changed = await run("hotspots");
  expect(cacheOf(changed)).toBeUndefined();
  expect(JSON.parse(changed).inputs.identityInputs.localMailmap).toMatch(/^[0-9a-f]{16}$/);
  expect(cacheOf(await run("hotspots"))).toHaveLength(1);
});

test("a table run prints a stored result as the run that computed it did", async () => {
  const table = async () => (await runCochangeOnTerminal(repo.path, ["hotspots"])).stdout;
  const cold = await table();
  expect(await table()).toBe(cold);
});

test("brief names the three stored results it read, and prints what a run from history printed", async () => {
  const cold = await run("brief", invoice, "src/app/registry.ts");
  expect(cacheOf(cold)).toBeUndefined();
  expect(reports()).toEqual(expect.arrayContaining(["cochange.coupling.json", "cochange.hotspots.json", "cochange.units.json"]));
  const warm = await run("brief", invoice, "src/app/registry.ts");
  expect(cacheOf(warm)?.map((input) => input.report)).toEqual(["cochange.units", "cochange.coupling", "cochange.hotspots"]);
  expect(withoutMeta(warm)).toBe(withoutMeta(cold));
});

test("brief reads no history when the results are stored, and one run of another command stores what it needs", async () => {
  await run("hotspots");
  await run("coupling");
  // Hotspots and coupling alone are not enough: the per-file activity is stored by the first brief.
  expect(cacheOf(await run("brief", invoice))).toBeUndefined();
  rmSync(join(repo.path, ".cache", "code-health", "history.sqlite"));
  const warm = await run("brief", invoice, "--no-refresh");
  expect(cacheOf(warm)).toHaveLength(3);
});

test("brief follows a path that was renamed away from history, then reads it as a file in the tree", async () => {
  const [row] = JSON.parse(await run("brief", "src/reports/summary.ts")).results;
  expect(row).toMatchObject({ path: "src/reporting/summary.ts", requested: "src/reports/summary.ts" });
  const again = await run("brief", "src/reporting/summary.ts");
  expect(cacheOf(again)).toHaveLength(3);
});

test("a briefing is the same from a dirty tree, and for a file edited in it", async () => {
  const clean = await run("brief", invoice);
  writeFileSync(join(repo.path, invoice), "export const invoice = 'edited';\n");
  const dirty = await run("brief", invoice);
  expect(cacheOf(dirty)).toHaveLength(3);
  expect(JSON.parse(dirty).results).toEqual(JSON.parse(clean).results);
});

test("brief --no-cache recomputes all three", async () => {
  await run("brief", invoice);
  expect(cacheOf(await run("brief", invoice, "--no-cache"))).toBeUndefined();
});

test("a stored result keeps saying how many files were left out", async () => {
  repo.apply([{ type: "commit", message: "Add notes", date: "2024-06-03T09:00:00+00:00", changes: [{ op: "add", path: "notes/readme.md", content: "# Notes\n" }, { op: "modify", path: invoice, content: "export const invoice = 100;\n" }] }]);
  const cold = JSON.parse(await run("hotspots"));
  expect(cold.dropped.nonCode).toBeGreaterThan(0);
  const warm = JSON.parse(await run("hotspots"));
  expect(warm.inputs.resultsCache).toHaveLength(1);
  expect(warm.dropped).toEqual(cold.dropped);
});

test("commands running at once leave whole stored results and each print the same answer", async () => {
  const child = (...args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const process = spawn(globalThis.process.execPath, [main, ...args, "--json", "--limit", "all", "--no-cache"], { cwd: repo.path });
      let out = "";
      process.stdout.on("data", (chunk) => (out += chunk));
      process.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    });
  await run("refresh");
  const outputs = await Promise.all([child("hotspots"), child("hotspots"), child("coupling"), child("coupling"), child("brief", invoice), child("brief", invoice)]);
  expect(withoutMeta(outputs[0]!)).toBe(withoutMeta(outputs[1]!));
  expect(withoutMeta(outputs[2]!)).toBe(withoutMeta(outputs[3]!));
  expect(withoutMeta(outputs[4]!)).toBe(withoutMeta(outputs[5]!));
  for (const name of reports()) if (name.endsWith(".json")) expect(() => JSON.parse(readFileSync(join(repo.path, ".cache", "code-health", "reports", name), "utf8"))).not.toThrow();
  expect(reports().filter((name) => name.endsWith(".tmp"))).toEqual([]);
  expect(cacheOf(await run("hotspots"))).toHaveLength(1);
  expect(existsSync(reportPath(repo.path, "units"))).toBe(true);
});

test("a repository with a complexity report for the commit reads its stored hotspots, and so does the briefing", async () => {
  const head = repo.git("rev-parse", "HEAD");
  const directory = join(repo.path, ".cache", "code-health", "reports");
  mkdirSync(directory, { recursive: true });
  const report = { schemaVersion: 1, tool: "complexity", command: "files", repo: { head, dirty: false }, config: "0".repeat(16), results: [{ path: invoice, complexity: 12 }] };
  writeFileSync(join(directory, "complexity.files.json"), JSON.stringify(report));

  const cold = await run("hotspots");
  expect(JSON.parse(cold).inputs.complexityReport).toEqual({ report: "complexity.files", head, config: "0".repeat(16) });
  // The stored inputs are written with sorted keys. A run that builds the same inputs in another order must still read them.
  expect(cacheOf(await run("hotspots"))).toHaveLength(1);

  const first = await run("brief", invoice);
  expect(cacheOf(first)).toBeUndefined();
  const warm = JSON.parse(await run("brief", invoice));
  expect(warm.inputs.resultsCache.map((input: { report: string }) => input.report)).toEqual(["cochange.units", "cochange.coupling", "cochange.hotspots"]);
  // A run that was answered from the stored results does not say it stored nothing.
  expect(warm.meta.report).toBeUndefined();
});
