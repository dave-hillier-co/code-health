import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadConfig } from "@code-health/cli-kit/config";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { treeFromDirectory } from "@code-health/parse/source-tree";
import { complexityConfig, readSettings } from "../src/config.ts";
import { measureTree, type UnitRecord } from "../src/measure.ts";
import { expectGolden } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";

/** Nested functions and lambdas are units in their own right, with `parent` naming the unit they sit in. */
const source = [
  "export function outer(xs: number[]) {",
  "  const named = (x: number) => {",
  "    if (x) { return 1; }",
  "    return 2;",
  "  };",
  "  return xs.map((x) => {",
  "    if (x > 1) { return x; }",
  "    return named(x);",
  "  });",
  "}",
  "",
].join("\n");

let directory: string;
let units: UnitRecord[];
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "nested-units-"));
  writeFileSync(join(directory, "outer.ts"), source);
  const settings = readSettings(loadConfig(directory, complexityConfig));
  units = (await measureTree(await treeFromDirectory(directory), { settings, layer: "structural" })).files.flatMap((file) => file.units);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("nested functions", () => {
  test("are units with parent set when bound to a name, and a callback with no name adds to its enclosing function", () => {
    expect(units.map((unit) => [unit.id, unit.parent ?? null])).toEqual([
      ["outer.ts#outer", null],
      ["outer.ts#outer.named", "outer"],
    ]);
  });

  test("add to the enclosing function's score, one level deeper, and are also measured alone", () => {
    const [outer, named] = units;
    expect(named!.values.cognitive).toBe(1);
    // `named` costs 2 inside outer (its `if` is nested in a function), and the callback's `if` costs 2.
    expect(outer!.values.cognitive).toBe(4);
  });
});

describe("analyse", () => {
  test("reports a nested function's parent and every structural unit's statement count, and matches its golden", async () => {
    const repo = GitFixture.build([
      { type: "commit", message: "Nested", date: "2024-01-01T00:00:00+00:00", changes: [{ op: "add", path: "src/outer.ts", content: source }] },
    ]);
    try {
      const run = await runComplexity(repo.path, ["analyse", "--json", "--limit", "all"]);
      expect(run.stderr).toBe("");
      expectGolden("nested", "analyse", run.stdout);
      const rows = JSON.parse(run.stdout).results as { id: string; parent?: string; statements?: number }[];
      expect(rows.map((row) => [row.id, row.parent ?? null, row.statements]).sort()).toEqual([
        ["src/outer.ts#outer", null, 8],
        ["src/outer.ts#outer.named", "outer", 3],
      ]);
    } finally {
      repo.dispose();
    }
  });
});
