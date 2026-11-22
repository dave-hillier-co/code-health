import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { couplingHistory } from "./support/coupling-scenarios.ts";
import { runCochangeOnTerminal } from "./support/run.ts";
import { indentedHistory, steadyHistory } from "./support/scenarios.ts";

let coupled: GitFixture;
let indented: GitFixture;
let steady: GitFixture;
beforeAll(() => {
  coupled = couplingHistory();
  indented = indentedHistory();
  steady = steadyHistory();
});
afterAll(() => {
  coupled.dispose();
  indented.dispose();
  steady.dispose();
});

const lines = (text: string) => text.trimEnd().split("\n");

test("coupling prints an aligned table with its columns in order, not JSON", async () => {
  const { code, stdout, stderr } = await runCochangeOnTerminal(coupled.path, ["coupling"]);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const [header, first, ...rest] = lines(stdout);
  expect(header!.split(/\s+/)).toEqual(["path", "with", "degree", "aboveGuideline", "confidence", "reverseConfidence", "support", "distance", "findings"]);
  expect(first).toMatch(/^src\/billing\/invoice\.test\.ts\s+src\/billing\/invoice\.ts\s+\d/);
  expect(rest.length).toBeGreaterThan(0);
  expect(stdout).not.toContain("{");
});

test("--limit cuts the table and says how many rows were left out", async () => {
  const { stdout } = await runCochangeOnTerminal(coupled.path, ["coupling", "--limit", "2"]);
  const printed = lines(stdout);
  expect(printed).toHaveLength(4);
  expect(printed[3]).toMatch(/^\d+ more not shown \(use --limit N or --limit all\)$/);
});

test("--fields projects the columns of the table", async () => {
  const { stdout } = await runCochangeOnTerminal(coupled.path, ["coupling", "--fields", "path,support"]);
  expect(lines(stdout)[0]!.split(/\s+/)).toEqual(["path", "support"]);
});

test("hotspots and age print a table with their columns", async () => {
  const hotspots = await runCochangeOnTerminal(indented.path, ["hotspots"]);
  expect(lines(hotspots.stdout)[0]).toMatch(/^path\s+.*frequency/);
  expect(hotspots.stdout).toContain("src/core/engine.ts");
  const age = await runCochangeOnTerminal(indented.path, ["age"]);
  expect(lines(age.stdout)[0]).toMatch(/^path\s/);
  expect(age.stdout).toContain("src/legacy/old.ts");
});

test("a result with no rows says so instead of printing an empty table", async () => {
  const { stdout } = await runCochangeOnTerminal(steady.path, ["coupling"]);
  expect(stdout).toBe("No results.\n");
});

test("spread, whose result is a document and not rows, prints as JSON text", async () => {
  const { stdout } = await runCochangeOnTerminal(steady.path, ["spread"]);
  expect(JSON.parse(stdout)).toMatchObject({ bucket: "month", overall: { logicalChanges: expect.any(Number) } });
});

test("--json on a terminal still prints the document", async () => {
  const { stdout } = await runCochangeOnTerminal(steady.path, ["coupling", "--json"]);
  expect(JSON.parse(stdout).command).toBe("coupling");
});
