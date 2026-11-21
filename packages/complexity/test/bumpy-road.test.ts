import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadConfig } from "@code-health/cli-kit/config";
import { treeFromDirectory } from "@code-health/parse/source-tree";
import { complexityConfig, readSettings } from "../src/config.ts";
import { measureTree, type UnitRecord } from "../src/measure.ts";

/**
 * The bumpy road, computed from the syntax tree: a bump is the body of a control structure that sits directly in
 * the function (a branch of an `if`, a loop's body), or a whole `switch` or `try` there. Structures nested inside a
 * bump are part of it. A body that fits on the line that opens it is not a bump.
 */
const files: Record<string, string> = {
  "tangled.ts": [
    "export function tangled(a: number, b: number): number {",
    "  if (a < 0) return 0;",
    "  let total = 0;",
    "  if (a > 0) {",
    "    total += 1;",
    "  } else {",
    "    total -= 1;",
    "  }",
    "  for (const x of [a, b]) {",
    "    if (x) {",
    "      total += x;",
    "    }",
    "  }",
    "  switch (a) {",
    "    case 1:",
    "      total++;",
    "      break;",
    "    default:",
    "      total--;",
    "  }",
    "  return total;",
    "}",
    "",
    "export function flat(a: number): number {",
    "  if (a < 0) return 0;",
    "  if (a > 100) { return 100; }",
    "  return a;",
    "}",
    "",
    "export function deep(a: number, b: number): number {",
    "  if (a) {",
    "    while (b) {",
    "      if (a > b) {",
    "        for (const c of [a]) {",
    "          b -= c;",
    "        }",
    "      }",
    "    }",
    "  }",
    "  if (b) {",
    "    a++;",
    "  }",
    "  return a;",
    "}",
    "",
  ].join("\n"),
  "tangled.py": [
    "def tangled(a, b):",
    "    total = 0",
    "    if a > 0:",
    "        total += 1",
    "    elif a < -5:",
    "        total -= 5",
    "    else:",
    "        total -= 1",
    "    for x in (a, b):",
    "        if x:",
    "            total += x",
    "    return total",
    "",
  ].join("\n"),
  "Tangled.cs": [
    "class Tangled {",
    "    int Run(int a, int b) {",
    "        int total = 0;",
    "        if (a > 0) {",
    "            total += 1;",
    "        } else {",
    "            total -= 1;",
    "        }",
    "        foreach (var x in new[] { a, b }) {",
    "            total += x;",
    "        }",
    "        try {",
    "            total++;",
    "        } catch (System.Exception) {",
    "            total--;",
    "        }",
    "        return total;",
    "    }",
    "}",
    "",
  ].join("\n"),
};

let directory: string;
let units: Map<string, UnitRecord>;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "bumpy-road-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), text);
  }
  const settings = readSettings(loadConfig(directory, complexityConfig));
  const measurement = await measureTree(await treeFromDirectory(directory), { settings, layer: "structural" });
  units = new Map(measurement.files.flatMap((file) => file.units).map((unit) => [unit.id, unit]));
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const bumpsOf = (name: string) => {
  const unit = units.get(name)!;
  return { bumps: unit.values.bumps, depth: unit.bumpDepth, size: unit.bumpSize, bumpy: unit.bumpyRoad };
};

describe("structural bumps", () => {
  test("count the branches, loops and switches directly in a function, and take the deepest level and largest size", () => {
    // if body, else body, for body, switch: four. The deepest line is the inner `if` body, three levels in.
    // The switch is the largest at five lines.
    expect(bumpsOf("tangled.ts#tangled")).toEqual({ bumps: 4, depth: 3, size: 5, bumpy: true });
  });

  test("leave out bodies that fit on the line that opens them", () => {
    expect(bumpsOf("tangled.ts#flat")).toEqual({ bumps: 0, depth: 0, size: 0, bumpy: false });
  });

  test("count a structure nested in a bump as part of that bump", () => {
    // Two top-level `if` bodies. The nest inside the first only deepens it: nesting 4, so the deepest bump is 5.
    expect(bumpsOf("tangled.ts#deep")).toEqual({ bumps: 2, depth: 5, size: 7, bumpy: true });
  });

  test("follow the same rule in an indentation language, counting each elif and else body", () => {
    const python = [...units.values()].filter((unit) => unit.path === "tangled.py");
    expect(python.map((unit) => [unit.values.bumps, unit.bumpDepth, unit.bumpSize, unit.bumpyRoad])).toEqual([[4, 3, 2, true]]);
  });

  test("follow the same rule in a braced language, counting try as one bump", () => {
    const csharp = [...units.values()].filter((unit) => unit.path === "Tangled.cs");
    expect(csharp.map((unit) => [unit.values.bumps, unit.bumpDepth, unit.bumpSize, unit.bumpyRoad])).toEqual([[4, 2, 3, true]]);
  });
});

describe("the bumpy road thresholds", () => {
  const measureWith = async (thresholds: object) => {
    writeFileSync(join(directory, "code-health.json"), JSON.stringify({ complexity: { thresholds } }));
    const settings = readSettings(loadConfig(directory, complexityConfig));
    const measurement = await measureTree(await treeFromDirectory(directory), { settings, layer: "structural" });
    rmSync(join(directory, "code-health.json"));
    return Object.fromEntries(measurement.files.flatMap((file) => file.units).map((unit) => [unit.id, unit.bumpyRoad]));
  };

  test("are configurable: the bump count, and the deeper-bump count against thresholds.nesting", async () => {
    expect(await measureWith({ bumps: 5 })).toMatchObject({ "tangled.ts#tangled": false, "tangled.ts#deep": true });
    expect(await measureWith({ bumps: 5, nesting: 5 })).toMatchObject({ "tangled.ts#tangled": false, "tangled.ts#deep": false });
    expect(await measureWith({ bumps: 2 })).toMatchObject({ "tangled.ts#flat": false, "tangled.ts#deep": true });
    expect(await measureWith({ deepBumps: 3, bumps: 5 })).toMatchObject({ "tangled.ts#deep": false });
  });

  test("reject a value that is not a count", async () => {
    await expect(measureWith({ bumps: 0 })).rejects.toThrow(/thresholds.bumps/);
  });
});
