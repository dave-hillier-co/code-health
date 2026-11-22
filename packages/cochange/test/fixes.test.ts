import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { expectGolden } from "./support/golden.ts";
import { runCochange, runCochangeOnTerminal } from "./support/run.ts";

const alice: Identity = { name: "Alice", email: "alice@example.com" };

const edit = (path: string, version: number) => ({ op: "modify" as const, path, content: `export const v = ${version};\n` });
const add = (path: string) => ({ op: "add" as const, path, content: "export const v = 0;\n" });

const commit = (message: string, date: string, ...changes: ReturnType<typeof edit>[]): Step => ({ type: "commit", message, date, author: alice, changes });

/**
 * Ending 2024-06-15. `billing` is fixed three times (once with a body only), reverted once, and its oldest fix is outside
 * the recent window. `web` is never fixed. `bot` commits are excluded as noise. Eleven logical changes in all.
 */
function fixHistory(): GitFixture {
  return GitFixture.build([
    { type: "commit", message: "Add modules", date: "2023-09-01T09:00:00Z", author: alice, changes: [add("src/billing/invoice.ts"), add("src/billing/tax.ts"), add("src/web/page.ts")] },
    commit("Fix rounding of totals", "2023-10-10T09:00:00Z", edit("src/billing/invoice.ts", 1)),
    commit("Tune the page", "2023-11-10T09:00:00Z", edit("src/web/page.ts", 1)),
    commit("Support credit notes", "2024-01-10T09:00:00Z", edit("src/billing/invoice.ts", 2), edit("src/billing/tax.ts", 1)),
    commit("Fix tax on credit notes", "2024-02-10T09:00:00Z", edit("src/billing/tax.ts", 2), edit("src/billing/invoice.ts", 3)),
    commit("Tweak the page", "2024-03-10T09:00:00Z", edit("src/web/page.ts", 2)),
    commit("Revert \"Fix tax on credit notes\"", "2024-04-10T09:00:00Z", edit("src/billing/tax.ts", 3)),
    commit("Bug: tax is negative", "2024-05-10T09:00:00Z", edit("src/billing/tax.ts", 4)),
    commit("Restyle the page", "2024-05-20T09:00:00Z", edit("src/web/page.ts", 3)),
    commit("Add discounts", "2024-06-01T09:00:00Z", edit("src/billing/invoice.ts", 4)),
    commit("Fix the page title", "2024-06-15T09:00:00Z", edit("src/web/page.ts", 4)),
  ]);
}

let repo: GitFixture;
beforeAll(() => {
  repo = fixHistory();
});
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  rmSync(join(repo.path, "code-health.json"), { force: true });
});

const fixes = (...args: string[]) => runCochange(repo.path, ["fixes", ...args]);
const json = (stdout: string) => JSON.parse(stdout);
const config = (document: unknown) => writeFileSync(join(repo.path, "code-health.json"), JSON.stringify(document));
type Row = { path: string; fixes: number; revisions: number; fixShare: number | null; recentFixes: number; lastFix: string | null; reverts: number; evidence: { commits: { subject: string; pattern: string; sha: string; date: string }[]; omitted: number } };
const byPath = (document: { results: Row[] }, path: string) => document.results.find((row) => row.path === path)!;

test("files are sorted by fix count with share, recent fixes, last fix, reverts and the matching commits", async () => {
  const { code, stdout, stderr } = await fixes();
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = json(stdout);
  expect(document.results.map((row: Row) => row.path)).toEqual(["src/billing/invoice.ts", "src/billing/tax.ts", "src/web/page.ts"]);
  const tax = byPath(document, "src/billing/tax.ts");
  expect(tax).toMatchObject({ fixes: 2, revisions: 5, fixShare: 0.4, recentFixes: 1, lastFix: "2024-05-10T09:00:00.000Z", reverts: 1 });
  expect(tax.evidence.commits.map((c) => c.subject)).toEqual(["Bug: tax is negative", "Fix tax on credit notes"]);
  expect(tax.evidence.commits[0]).toMatchObject({ date: "2024-05-10T09:00:00.000Z" });
  expect(tax.evidence.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
  expect(tax.evidence.omitted).toBe(0);
  expect(byPath(document, "src/billing/invoice.ts")).toMatchObject({ fixes: 2, revisions: 5, reverts: 0 });
  expect(byPath(document, "src/web/page.ts")).toMatchObject({ fixes: 1, revisions: 5 });
  expectGolden("fixes", "fixes", stdout);
});

test("a revert is its own column and is not a fix", async () => {
  const document = json((await fixes()).stdout);
  const subjects = byPath(document, "src/billing/tax.ts").evidence.commits.map((c) => c.subject);
  expect(subjects).not.toContain('Revert "Fix tax on credit notes"');
  expect(byPath(document, "src/billing/tax.ts").reverts).toBe(1);
});

test("the evidence limit keeps the newest commits and counts the rest", async () => {
  const document = json((await fixes("--evidence", "1")).stdout);
  const tax = byPath(document, "src/billing/tax.ts");
  expect(tax.evidence.commits).toHaveLength(1);
  expect(tax.evidence.omitted).toBe(1);
  expect(document.inputs.evidenceLimit).toBe(1);
  expect((await fixes("--evidence", "x")).code).toBe(ExitCode.Usage);
});

test("components are sorted the same way, counting a change once per component", async () => {
  config({ components: { billing: ["src/billing/**"], web: ["src/web/**"] } });
  const document = json((await fixes("--by", "component")).stdout);
  expect(document.results.map((row: Row) => row.path)).toEqual(["billing", "web"]);
  // Fix tax on credit notes touches two billing files and counts once.
  expect(byPath(document, "billing")).toMatchObject({ fixes: 3, revisions: 7, reverts: 1 });
  expect(byPath(document, "web")).toMatchObject({ fixes: 1, revisions: 5 });
});

test("the convention check reads the forms of the landed titles, with the share beside them, and prints no Notice when a form is used", async () => {
  const document = json((await fixes()).stdout);
  expect(document.fixConvention).toMatchObject({ landedChanges: 11, fixes: 4, followsConvention: true, note: null, forms: { conventionalCommits: 0, fixVerb: 3, issueReference: 0 } });
  expect(document.fixConvention.share).toBeCloseTo(4 / 11, 3);
  const table = await runCochangeOnTerminal(repo.path, ["fixes"]);
  expect(table.stdout).not.toContain("probably do not follow a convention");
});

test("history.fixPatterns changes what counts, and reverts follow history.revertPatterns", async () => {
  config({ history: { fixPatterns: ["\\bTune\\b"] } });
  const document = json((await fixes()).stdout);
  expect(document.results[0]).toMatchObject({ path: "src/web/page.ts", fixes: 1 });
  expect(byPath(document, "src/billing/tax.ts").fixes).toBe(0);
});

test("history.fixExcludePatterns counts a matched fix as excluded, with the excluding pattern, and not as a fix", async () => {
  config({ history: { fixExcludePatterns: ["\\bpage title\\b"] } });
  const document = json((await fixes()).stdout);
  expect(document.fixConvention.fixes).toBe(3);
  expect(byPath(document, "src/web/page.ts").fixes).toBe(0);
  expect(document.fixesExcluded).toMatchObject({ fixes: 1, byPattern: [{ pattern: "\\bpage title\\b", count: 1 }], omitted: 0 });
  expect(document.fixesExcluded.commits[0]).toMatchObject({ subject: "Fix the page title", pattern: "\\bpage title\\b" });
  const table = await runCochangeOnTerminal(repo.path, ["fixes"]);
  expect(table.stdout).toContain("Notice: 1 changes matched a fix pattern and were left out");
});

test("hotspots carries fixes and fixShare beside frequency", async () => {
  const document = json((await runCochange(repo.path, ["hotspots"])).stdout);
  const tax = document.results.find((row: { path: string }) => row.path === "src/billing/tax.ts");
  expect(tax).toMatchObject({ frequency: 5, fixes: 2, fixShare: 0.4 });
  expect(document.fixConvention.fixes).toBe(4);
});

test("brief gives the fix count of each file asked about", async () => {
  const document = json((await runCochange(repo.path, ["brief", "src/billing/tax.ts", "src/web/page.ts"])).stdout);
  expect(document.results.map((row: { path: string; fixes: number; fixShare: number }) => [row.path, row.fixes, row.fixShare])).toEqual([
    ["src/billing/tax.ts", 2, 0.4],
    ["src/web/page.ts", 1, 0.2],
  ]);
});

test("fixes output, as printed with meta, matches its schema, and stray fields do not", async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "cochange", "schemas");
  const ajv = new Ajv2020Module.default({ strict: true, allErrors: true });
  addFormatsModule.default(ajv);
  for (const name of ["common", "fixes"]) ajv.addSchema(JSON.parse(readFileSync(join(dir, `${name}.schema.json`), "utf8")));
  const validate = ajv.getSchema("fixes.schema.json")!;
  config({ components: { billing: ["src/billing/**"] } });
  for (const args of [[], ["--evidence", "0"], ["--by", "component"]]) {
    const document = json((await fixes(...args, "--limit", "all")).stdout);
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  }
  const document = json((await fixes()).stdout);
  document.results[0].evidence.surprise = 1;
  expect(validate(document)).toBe(false);
});
