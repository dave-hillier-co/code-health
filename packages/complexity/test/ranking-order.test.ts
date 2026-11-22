import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { runComplexity } from "./support/run.ts";

/** A switch of many cases: long, with a high cyclomatic complexity, and a cognitive complexity of 1. */
const keywords = `export function isKeyword(word: string): boolean {
  switch (word) {
${Array.from({ length: 40 }, (_, index) => `    case "word${index}":`).join("\n")}
      return true;
    default:
      return false;
  }
}
`;

/** Nested branches: cognitive 6 (if 1, for 2, if 3), nesting 3. */
const tangled = `export function tangled(items: number[], limit: number): number {
  let total = 0;
  if (limit > 0) {
    for (const item of items) {
      if (item > limit) {
        total += item;
      }
    }
  }
  return total;
}
`;

/** Another function with cognitive 1: one branch, no nesting. */
const branching = `export function clamp(value: number, limit: number): number {
  if (value > limit) {
    return limit;
  }
  return value;
}
`;

const wide = `export function wide(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number): number {
  return a + b + c + d + e + f + g + h;
}
`;

/** Helper code that sits under a production folder. It is as simple as `wide`, so the two tie on every metric but path. */
const harness = `export function harness(value: number, limit: number): number {
  return value + limit;
}
`;

/** A test function more tangled than anything in production. */
const tangledTest = `export function exercise(items: number[], limit: number): number {
  let total = 0;
  for (const item of items) {
    if (item > limit) {
      for (const inner of items) {
        if (inner > item) {
          total += inner;
        }
      }
    }
  }
  return total;
}
`;

let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Base",
      date: "2024-01-01T00:00:00+00:00",
      changes: [
        { op: "add", path: "src/keywords.ts", content: keywords },
        { op: "add", path: "src/tangled.ts", content: tangled },
        { op: "add", path: "src/branching.ts", content: branching },
        { op: "add", path: "src/wide.ts", content: wide },
        { op: "add", path: "test/exercise.test.ts", content: tangledTest },
        { op: "add", path: "src/support/harness.ts", content: harness },
      ],
    },
  ]);
});
afterAll(() => repo.dispose());

interface Row {
  path: string;
  unit: string;
  role: "production" | "test";
  score: number;
  cognitive: number;
  nesting: number;
  cyclomatic: number;
  length: number;
  percentiles: Record<string, number>;
}

interface Document {
  inputs: { by: string; includeTests: boolean };
  ranking: { by: string; sortedBy: string[] };
  tests?: { count: number; listed: number; omitted: number; rows: Row[] };
  results: Row[];
}

async function analyse(...args: string[]): Promise<Document> {
  const run = await runComplexity(repo.path, ["analyse", "--json", "--limit", "all", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return JSON.parse(run.stdout) as Document;
}

describe("the default order", () => {
  test("is cognitive complexity, then nesting, cyclomatic and length, so a long switch does not outrank a tangled function", async () => {
    const { results, ranking } = await analyse();
    expect(ranking).toMatchObject({ by: "cognitive", sortedBy: ["cognitive", "nesting", "cyclomatic", "length", "path"] });
    const units = results.map((row) => row.unit);
    expect(units[0]).toBe("tangled");
    // The switch and the branch have cognitive 1 and nesting 1 and 1: the switch has the higher cyclomatic complexity. The helper and the wide function tie on everything but path.
    expect(units.slice(1)).toEqual(["isKeyword", "clamp", "harness", "wide"]);
    const keyword = results.find((row) => row.unit === "isKeyword")!;
    expect(keyword.cognitive).toBe(1);
    expect(keyword.cyclomatic).toBeGreaterThan(40);
  });

  test("breaks a tie by nesting, then cyclomatic, then length, then path, and the other metrics stay as columns with percentiles", async () => {
    const { results } = await analyse();
    const keys = results.map((row) => [-row.cognitive, -row.nesting, -row.cyclomatic, -row.length]);
    const sorted = [...keys].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]! || a[3]! - b[3]!);
    expect(keys).toEqual(sorted);
    for (const row of results) expect(Object.keys(row.percentiles)).toEqual(expect.arrayContaining(["cognitive", "cyclomatic", "nesting", "length", "parameters"]));
  });

  test("--by max-percentile ranks the outlier of any single metric first, and names it in the order", async () => {
    const { results, ranking } = await analyse("--by", "max-percentile");
    expect(ranking.sortedBy).toEqual(["max percentile", "cognitive", "nesting", "cyclomatic", "length", "path"]);
    // Each of the switch and the wide function is the top of one metric, the tangled function of two.
    expect(results[0]!.unit).not.toBe("clamp");
    expect(results.map((row) => row.unit)).not.toEqual((await analyse()).results.map((row) => row.unit));
  });

  test("--by a metric name sorts on that metric's value, highest first", async () => {
    const byParameters = await analyse("--by", "parameters");
    expect(byParameters.results[0]!.unit).toBe("wide");
    expect(byParameters.ranking.sortedBy).toEqual(["parameters", "cognitive", "nesting", "cyclomatic", "length", "path"]);
    const byCyclomatic = await analyse("--by", "cyclomatic");
    expect(byCyclomatic.results[0]!.unit).toBe("isKeyword");
    const byLength = await analyse("--by", "length");
    expect(byLength.results[0]!.unit).toBe("isKeyword");
  });

  test("the table says which sort was used", async () => {
    const run = await runComplexity(repo.path, ["analyse", "--limit", "all"], true);
    expect(run.stdout).toContain("Notice: sorted by cognitive, then nesting, then cyclomatic, then length, then path.");
  });
});

describe("test code", () => {
  test("is counted apart: the rows are production code, and the tests section says how many it left out and lists the first", async () => {
    const document = await analyse();
    expect(document.results.every((row) => row.role === "production")).toBe(true);
    expect(document.results.map((row) => row.path).sort()).toEqual(["src/branching.ts", "src/keywords.ts", "src/support/harness.ts", "src/tangled.ts", "src/wide.ts"].sort());
    expect(document.tests).toMatchObject({ count: 1, listed: 1, omitted: 0 });
    expect(document.tests!.rows[0]).toMatchObject({ path: "test/exercise.test.ts", unit: "exercise", role: "test" });
  });

  test("--include-tests puts them in the one list, each with its role, in the same order", async () => {
    const document = await analyse("--include-tests");
    expect(document.inputs.includeTests).toBe(true);
    expect(document.tests).toBeUndefined();
    expect(document.results.find((row) => row.unit === "exercise")!.role).toBe("test");
    // The test is the most tangled function and ranks first once it is in the list.
    expect(document.results[0]!.unit).toBe("exercise");
  });

  test("testPatterns lays globs over the language conventions: a match is a test, and an entry with ! is production", async () => {
    writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ testPatterns: ["src/support/**", "!test/exercise.test.ts"] }));
    try {
      const document = await analyse("--include-tests");
      const roles = Object.fromEntries(document.results.map((row) => [row.unit, row.role]));
      expect(roles).toMatchObject({ harness: "test", exercise: "production", tangled: "production" });
    } finally {
      rmSync(join(repo.path, "code-health.json"), { force: true });
    }
  });
});

describe("files, fixes and depth set tests apart the same way", () => {
  test("files lists production files and counts the test files in dropped.tests, and --include-tests lists them with a role", async () => {
    const plain = JSON.parse((await runComplexity(repo.path, ["files", "--json", "--limit", "all"])).stdout);
    expect(plain.results.every((row: { role: string }) => row.role === "production")).toBe(true);
    expect(plain.dropped).toEqual({ tests: 1 });
    const merged = JSON.parse((await runComplexity(repo.path, ["files", "--json", "--limit", "all", "--include-tests"])).stdout);
    expect(merged.dropped).toBeUndefined();
    expect(merged.results.find((row: { path: string }) => row.path === "test/exercise.test.ts").role).toBe("test");
  });

  test("depth lists exported production units and counts the tests", async () => {
    const plain = JSON.parse((await runComplexity(repo.path, ["depth", "--json", "--limit", "all"])).stdout);
    expect(plain.results.every((row: { role: string }) => row.role === "production")).toBe(true);
    expect(plain.tests.count).toBeGreaterThan(0);
    const merged = JSON.parse((await runComplexity(repo.path, ["depth", "--json", "--limit", "all", "--include-tests"])).stdout);
    expect(merged.results.some((row: { role: string }) => row.role === "test")).toBe(true);
  });
});

describe("fixes", () => {
  const fixed = (name: string, revision: number) => `export function ${name}(items: number[]): number {\n  let total = ${revision};\n  for (const item of items) {\n    if (item > 0) {\n      total += item;\n    }\n  }\n  return total;\n}\n`;

  test("lists production functions with fixes, counts the test functions, and --include-tests lists them with a role", async () => {
    const fixRepo = GitFixture.build([
      {
        type: "commit",
        message: "Add both",
        date: "2024-01-01T00:00:00+00:00",
        changes: [
          { op: "add", path: "src/orders.ts", content: fixed("orders", 0) },
          { op: "add", path: "test/orders.test.ts", content: fixed("checkOrders", 0) },
        ],
      },
      {
        type: "commit",
        message: "fix: stop counting negative items",
        date: "2024-02-01T00:00:00+00:00",
        changes: [
          { op: "modify", path: "src/orders.ts", content: fixed("orders", 1) },
          { op: "modify", path: "test/orders.test.ts", content: fixed("checkOrders", 1) },
        ],
      },
    ]);
    try {
      const plain = JSON.parse((await runComplexity(fixRepo.path, ["fixes", "--json", "--limit", "all"])).stdout);
      expect((plain.results as { unit: string; role: string }[]).map((row) => [row.unit, row.role])).toEqual([["orders", "production"]]);
      expect(plain.tests).toMatchObject({ count: 1 });
      expect(plain.tests.rows[0]).toMatchObject({ unit: "checkOrders", role: "test" });
      const merged = JSON.parse((await runComplexity(fixRepo.path, ["fixes", "--json", "--limit", "all", "--include-tests"])).stdout);
      expect((merged.results as { unit: string; role: string }[]).map((row) => row.role).sort()).toEqual(["production", "test"]);
      expect(merged.tests).toBeUndefined();
    } finally {
      fixRepo.dispose();
    }
  });
});

describe("test code inside a production file", () => {
  test("a Rust cfg(test) module and a #[test] function are tests, the rest of the file is production", async () => {
    const rust = GitFixture.build([
      {
        type: "commit",
        message: "Base",
        date: "2024-01-01T00:00:00+00:00",
        changes: [
          {
            op: "add",
            path: "src/lib.rs",
            content: "pub fn double(x: i32) -> i32 {\n    x * 2\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    fn helper() -> i32 {\n        double(2)\n    }\n\n    #[test]\n    fn doubles() {\n        assert_eq!(helper(), 4);\n    }\n}\n\n#[test]\nfn outside() {}\n",
          },
        ],
      },
    ]);
    try {
      const run = await runComplexity(rust.path, ["analyse", "--json", "--limit", "all", "--include-tests"]);
      const roles = Object.fromEntries((JSON.parse(run.stdout).results as Row[]).map((row) => [row.unit, row.role]));
      expect(roles).toMatchObject({ double: "production", "tests.helper": "test", "tests.doubles": "test", outside: "test" });
    } finally {
      rust.dispose();
    }
  });
});
