import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { loadConfig } from "@code-health/cli-kit/config";
import { treeFromRef } from "@code-health/parse/source-tree";
import { fileSamples } from "../src/backtest.ts";
import { complexityConfig, readSettings } from "../src/config.ts";
import { followedUnits } from "../src/function-history.ts";
import { measureTree } from "../src/measure.ts";
import { runComplexity } from "./support/run.ts";

/** A Rust file whose unit tests sit in a `#[cfg(test)]` module of the same file. */
const lib = [
  "pub fn double(x: i32) -> i32 {",
  "    if x > 0 {",
  "        x * 2",
  "    } else {",
  "        0",
  "    }",
  "}",
  "",
  "#[cfg(all(test, feature = \"api\"))]",
  "mod tests {",
  "    use super::*;",
  "",
  "    fn helper(x: i32) -> i32 {",
  "        if x > 1 {",
  "            if x > 2 {",
  "                return double(x);",
  "            }",
  "        }",
  "        0",
  "    }",
  "",
  "    #[test]",
  "    fn doubles() {",
  "        assert_eq!(helper(3), 6);",
  "    }",
  "}",
  "",
].join("\n");

let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Add a file with its unit tests inline",
      date: "2024-01-01T00:00:00+00:00",
      changes: [{ op: "add", path: "src/lib.rs", content: lib }],
    },
  ]);
});
afterAll(() => repo.dispose());

async function json(...args: string[]) {
  const run = await runComplexity(repo.path, [...args, "--json"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return JSON.parse(run.stdout);
}

test("analyse counts every function of a module that requires cfg(test) as a test, helpers included", async () => {
  const document = await json("analyse", "--limit", "all", "--include-tests");
  const roles = Object.fromEntries((document.results as { unit: string; role: string }[]).map((row) => [row.unit, row.role]));
  expect(roles).toEqual({ double: "production", "tests.helper": "test", "tests.doubles": "test" });
});

test("files counts the inline test module's lines and functions apart from the file's own", async () => {
  const document = await json("files", "--limit", "all");
  const row = (document.results as Record<string, unknown>[]).find((candidate) => candidate.path === "src/lib.rs")!;
  expect(row).toMatchObject({ role: "production", lineCount: 26, codeLines: 7, testCodeLines: 16, functions: 1, testFunctions: 2, aboveGuideline: 0 });
  expect((row.aggregates as Record<string, { sum: number }>).cyclomatic!.sum).toBe(2);
});

test("report xray lists the file's production functions and counts its test functions apart", async () => {
  const run = await runComplexity(repo.path, ["report", "xray", "src/lib.rs", "--slots"]);
  expect(run.code).toBe(ExitCode.Success);
  expect(run.stdout).not.toContain("tests.helper");
  expect(run.stdout).toContain("Test functions left out");
});

test("the backtest measures the file by its production code: its code lines, and in function mode its production functions", async () => {
  const settings = readSettings(loadConfig(repo.path, complexityConfig));
  const tree = await treeFromRef(repo.path, "HEAD");
  const auto = await measureTree(tree, { settings, layer: "auto" });
  expect(fileSamples(auto.files, settings)).toMatchObject([{ path: "src/lib.rs", codeLines: 7, functions: 1, cyclomaticSum: 2 }]);
  const structural = await measureTree(tree, { settings, layer: "structural" });
  expect(followedUnits(structural.files.find((file) => file.path === "src/lib.rs")!).map((unit) => [unit.name, unit.values.length])).toEqual([["double", 7]]);
});
