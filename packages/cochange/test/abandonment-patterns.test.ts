import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { busFactorOf } from "../src/abandonment/patterns.ts";
import { expectGolden } from "./support/golden.ts";
import { runCochange, runCochangeOnTerminal } from "./support/run.ts";
import { auth, deps, engine, knowledgeHistory, lexer, log, parser, routes, view } from "./support/knowledge-scenario.ts";

vi.setConfig({ testTimeout: 120_000 });

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;
const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "code-health", "schemas", "cochange");
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, "common.schema.json"), "utf8")));
const validate = ajv.compile(JSON.parse(readFileSync(join(schemaDir, "abandonment.schema.json"), "utf8")));

let repo: GitFixture;
beforeAll(() => {
  repo = knowledgeHistory();
});
afterAll(() => repo.dispose());

function configure(knowledge: Record<string, unknown> = {}): void {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true, ...knowledge } } }));
}
beforeEach(() => {
  rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
  configure();
});

const patterns = async (...args: string[]) => {
  const { code, stdout, stderr } = await runCochange(repo.path, ["abandonment", "patterns", "--limit", "all", ...args]);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  return JSON.parse(stdout);
};
const patternOf = (document: { results: { path: string; pattern: string | null }[] }) => Object.fromEntries(document.results.map((r) => [r.path, r.pattern]));

test("the patterns refuse when the repository switches the analysis off, like the rest of it", async () => {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: false } } }));
  const { code, stdout, stderr } = await runCochange(repo.path, ["abandonment", "patterns"]);
  expect(code).toBe(ExitCode.Usage);
  expect(stdout).toBe("");
  expect(stderr).toContain("cochange.knowledge.enabled");
});

test("every file with a blame is labelled: a single owner, a single-owner hotspot, inconclusive for the bot's file, and none for the rest", async () => {
  const document = await patterns();
  expect(patternOf(document)).toEqual({
    [auth]: "single-owner-hotspot",
    [view]: "single-owner",
    [log]: "single-owner",
    [deps]: "inconclusive",
    [routes]: null,
    [engine]: null,
    [lexer]: null,
    [parser]: null,
  });
  // Auth is all Ann's and changes every ten days, so it is a single owner and a hotspot. The routes are shared by Ann and Bob.
  expect(document.results[0]).toMatchObject({ path: auth, patterns: ["single-owner-hotspot", "single-owner"], hotspot: true, activeAuthors: 1, topActiveShare: 1, busFactor: 1, basis: "blame" });
  expect(document.results.find((r: { path: string }) => r.path === routes)).toMatchObject({ activeAuthors: 2, topActiveShare: 0.5, busFactor: 2 });
  // The bot wrote half of the dependency file, which is the inconclusive share.
  expect(document.results.find((r: { path: string }) => r.path === deps)).toMatchObject({ unreliableShare: 0.5, patterns: ["inconclusive"] });
  expect(document.summary).toMatchObject({ files: 8, none: 4, hotspotFiles: 2 });
  expect(document.summary.counts).toEqual([
    { pattern: "single-owner-hotspot", primary: 1, matching: 1 },
    { pattern: "former-contributors-complex", primary: 0, matching: 0 },
    { pattern: "single-owner", primary: 2, matching: 3 },
    { pattern: "many-active-developers", primary: 0, matching: 0 },
    { pattern: "inconclusive", primary: 1, matching: 1 },
  ]);
  expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
});

test("rows come in pattern order, then by hotspot percentile, so the default listing starts with the single-owner hotspots", async () => {
  const document = await patterns();
  expect(document.results.map((r: { path: string }) => r.path)).toEqual([auth, view, log, deps, routes, engine, lexer, parser]);
  const firstTwo = await runCochange(repo.path, ["abandonment", "patterns", "--limit", "2"]);
  expect(JSON.parse(firstTwo.stdout).results.map((r: { path: string }) => r.path)).toEqual([auth, view]);
});

test("complex code by former contributors needs the file to be at the complexity guideline, and people who have left to hold the lines", async () => {
  // Every file in the fixture is equally flat, so they share the middle percentile: 50 reaches it and the default 75 does not.
  expect(patternOf(await patterns())[engine]).toBeNull();
  configure({ complexityPercentile: 50 });
  const document = await patterns();
  expect(patternOf(document)).toMatchObject({ [engine]: "former-contributors-complex", [parser]: "former-contributors-complex", [lexer]: "former-contributors-complex", [routes]: null, [auth]: "single-owner-hotspot" });
  expect(document.results.find((r: { path: string }) => r.path === engine)).toMatchObject({ formerShare: 1, activeAuthors: 0, busFactor: null });
  // Raising the share of former holders above what the lexer has (80 percent) takes it out, and it is still listed.
  configure({ complexityPercentile: 50, formerContributorShare: 85 });
  const stricter = await patterns();
  expect(patternOf(stricter)[lexer]).toBeNull();
  expect(patternOf(stricter)[parser]).toBe("former-contributors-complex");
  expect(stricter.results).toHaveLength(8);
});

test("many active developers needs enough of them each holding a meaningful share", async () => {
  configure({ manyActiveAuthors: 2, meaningfulShare: 50 });
  const document = await patterns();
  // The routes are Ann's and Bob's, five lines each: two developers with half the lines.
  expect(patternOf(document)[routes]).toBe("many-active-developers");
  expect(patternOf(document)[auth]).toBe("single-owner-hotspot");
  configure({ manyActiveAuthors: 2, meaningfulShare: 51 });
  expect(patternOf(await patterns())[routes]).toBeNull();
});

test("the single owner share is a guideline on exact arithmetic", async () => {
  // Ann and Bob hold half of the routes each, and Ann one line in ten of the parser, where Cy, who left, holds nine.
  configure({ singleOwnerShare: 100 });
  expect(patternOf(await patterns())[view]).toBe("single-owner");
  configure({ singleOwnerShare: 50 });
  const document = await patterns();
  expect(patternOf(document)[routes]).toBe("single-owner-hotspot");
  expect(patternOf(document)[parser]).toBeNull();
});

test("settings with nonsense values are refused", async () => {
  configure({ singleOwnerShare: 0 });
  const { code, stderr } = await runCochange(repo.path, ["abandonment", "patterns"]);
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toContain("singleOwnerShare");
});

test("the bus factor is the fewest active developers holding the share of lines", () => {
  expect(busFactorOf([60, 30, 10], 100, 80)).toBe(2);
  expect(busFactorOf([60, 30, 10], 100, 60)).toBe(1);
  expect(busFactorOf([60, 30, 10], 100, 100)).toBe(3);
  // Active developers holding less than the share together have no bus factor.
  expect(busFactorOf([30, 20], 100, 80)).toBeNull();
  expect(busFactorOf([], 100, 80)).toBeNull();
  expect(busFactorOf([5], 0, 80)).toBeNull();
});

test("the output has developers as counts and shares and never a name or an address", async () => {
  const { stdout } = await runCochange(repo.path, ["abandonment", "patterns", "--limit", "all"]);
  for (const hidden of ["example.com", "Ann", "Bob", "Cy", "Di ", "Eve", "dependabot[bot]"]) expect(stdout).not.toContain(hidden);
  expectGolden("abandonment", "abandonment.patterns", stdout);
});

test("the table lists every file and says where the patterns come from", async () => {
  const table = await runCochangeOnTerminal(repo.path, ["abandonment", "patterns", "--limit", "all"]);
  expect(table.code).toBe(ExitCode.Success);
  expect(table.stdout).toContain("single-owner-hotspot");
  for (const file of [auth, view, log, deps, routes, engine, lexer, parser]) expect(table.stdout).toContain(file);
});

test("a stored complexity report for this commit supplies the complexity and is named in the inputs", async () => {
  const head = repo.git("rev-parse", "HEAD").trim();
  const dir = join(repo.path, ".cache", "code-health", "reports");
  mkdirSync(dir, { recursive: true });
  const rows = [engine, parser, lexer, routes, auth, log, view, deps].map((path, i) => ({ path, complexity: i < 3 ? 100 : 1 }));
  writeFileSync(join(dir, "complexity.files.json"), JSON.stringify({ schemaVersion: 1, tool: "complexity", command: "files", repo: { head, dirty: false }, config: "1".repeat(16), results: rows }));
  try {
    const document = await patterns();
    expect(document.complexitySource).toBe("complexity-report");
    expect(document.inputs.complexityReport).toEqual({ report: "complexity.files", head, config: "1".repeat(16) });
    // The three complex files are the top of the percentile, and their authors have left.
    expect(patternOf(document)).toMatchObject({ [engine]: "former-contributors-complex", [parser]: "former-contributors-complex", [lexer]: "former-contributors-complex" });
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  } finally {
    rmSync(join(repo.path, ".cache", "code-health", "reports"), { recursive: true, force: true });
  }
});
