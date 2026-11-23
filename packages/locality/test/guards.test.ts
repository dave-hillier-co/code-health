import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { reportPath } from "../src/reports.ts";
import { expectGolden } from "./support/golden.ts";
import { runLocality } from "./support/run.ts";
import { distantHelpers, guardedUnits } from "./support/scenarios.ts";

let helpers: GitFixture;
let guarded: GitFixture;
beforeAll(() => {
  helpers = distantHelpers();
  guarded = guardedUnits();
});
afterAll(() => {
  helpers.dispose();
  guarded.dispose();
});
beforeEach(() => {
  for (const repo of [helpers, guarded]) {
    rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
    repo.git("checkout", "--quiet", "--", ".");
  }
});

type Row = { path: string; recommendation: string; rule: string; visibility: string; target: string };

async function analyse(repo: GitFixture) {
  const { code, stdout, stderr } = await runLocality(repo.path, ["analyse", "--limit", "all"]);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = JSON.parse(stdout);
  return { stdout, document, row: (path: string) => (document.results as Row[]).find((r) => r.path === path) };
}

test("a file a published package names as its entry point is reviewed, not moved", async () => {
  const { row, stdout } = await analyse(guarded);
  expect(row("src/shared/api.ts")).toMatchObject({ recommendation: "review", rule: "package-entry", visibility: "package-entry" });
  expectGolden("guarded", "analyse", stdout);
});

test("a function used as a value makes its callsite counts unreliable, so it is reviewed", async () => {
  const { row } = await analyse(guarded);
  expect(row("src/shared/helper.ts")).toMatchObject({ recommendation: "review", rule: "other-references" });
});

test("excluded files take no part in the analysis", async () => {
  const { document } = await analyse(guarded);
  expect(document.summary.files).toBe(3);
  expect(JSON.stringify(document)).not.toContain("src/generated");
});

test("without configured entry points, entries are the files nothing imports", async () => {
  writeFileSync(join(helpers.path, "code-health.json"), "{}");
  const { document } = await analyse(helpers);
  expect(document.inputs.entrySource).toBe("detected");
  expect(document.inputs.entries).toEqual(
    expect.arrayContaining(["src/main.ts", "src/legacy/dead.ts"]),
  );
  expect(document.unreachable).toEqual([]);
});

test("fixed points stay where they are, and nothing moves into them", async () => {
  writeFileSync(
    join(helpers.path, "code-health.json"),
    JSON.stringify({ entryPoints: ["src/main.ts"], locality: { fixedPoints: ["src/shared/utils/**", "src/orders/**"] } }),
  );
  const { row, document } = await analyse(helpers);
  expect(row("src/shared/utils/money.ts")).toMatchObject({ recommendation: "keep", rule: "fixed-point" });
  // src/shared/cycle would move to src/orders, a fixed folder: it settles for the next best place, which is the folder src, a grouping folder, so it is not moved.
  expect(row("src/shared/cycle/a.ts")).toBeUndefined();
  expect(document.omitted).toContainEqual(expect.objectContaining({ path: "src/shared/cycle/a.ts", reason: "no usable target: target is a grouping folder", target: "src" }));
});

test("the minimum distance decides what is reported", async () => {
  writeFileSync(
    join(helpers.path, "code-health.json"),
    JSON.stringify({ entryPoints: ["src/main.ts"], locality: { minDistance: 4 } }),
  );
  const { document } = await analyse(helpers);
  const moves = (document.results as Row[]).filter((r) => r.recommendation === "move" || r.recommendation === "inline");
  expect(moves.map((r) => r.path)).not.toContain("src/shared/utils/slug.ts");
});

test("a dirty tree is analysed at HEAD but stores no report", async () => {
  writeFileSync(join(helpers.path, "src/main.ts"), "export const changed = 1;\n");
  const { code } = await runLocality(helpers.path, ["analyse"]);
  expect(code).toBe(ExitCode.Success);
  const { existsSync } = await import("node:fs");
  expect(existsSync(reportPath(helpers.path, "analyse"))).toBe(false);
});

test("an unknown --recommendation is a usage error", async () => {
  const { code, stderr } = await runLocality(helpers.path, ["analyse", "--recommendation", "delete"]);
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toMatch(/--recommendation must be one of/);
});
