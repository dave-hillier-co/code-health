import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";
import { buildRepo } from "./support/scenarios.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = buildRepo();
});
afterAll(() => repo.dispose());

interface FileRow {
  path: string;
  complexity: number;
  score: number;
  source: string | null;
  profile: string | null;
  functions: number;
  aboveGuideline: number;
  aggregates: Record<string, { sum: number; max: number }> | null;
  keywordComplexity: number | null;
}

async function files(...args: string[]) {
  const run = await runComplexity(repo.path, ["files", "--json", "--limit", "all", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return run;
}

test("lists every code file with file-level metrics and function aggregates, and matches its golden", async () => {
  const { stdout } = await files();
  expectGolden("pricing", "files", stdout);
  const rows = JSON.parse(stdout).results as FileRow[];
  const byPath = new Map(rows.map((row) => [row.path, row]));

  const pricing = byPath.get("src/pricing.ts")!;
  expect(pricing.source).toBe("structural");
  expect(pricing.functions).toBe(2);
  expect(pricing.aggregates!.cognitive).toEqual({ sum: 8, max: 8 });
  expect(pricing.aggregates!.cyclomatic).toEqual({ sum: 6, max: 5 });

  // No adapter and no lexer profile claims a Ruby file or a Markdown document: they are not code, so they are not ranked, and are counted.
  expect(byPath.has("tools/total.rb")).toBe(false);
  expect(byPath.has("notes.md")).toBe(false);
  expect(JSON.parse(stdout).dropped).toEqual({ nonCode: 2 });
  // Go has an adapter: its functions are measured structurally, `for` and `if` counted as in any language.
  const go = byPath.get("src/total.go")!;
  expect(go).toMatchObject({ source: "structural", functions: 1 });
  expect(go.aggregates!.cognitive).toEqual({ sum: 3, max: 3 });
  expect(go.aggregates!.cyclomatic).toEqual({ sum: 3, max: 3 });
});

test("sorts by file complexity and each row's score is that complexity", async () => {
  const rows = JSON.parse((await files()).stdout).results as FileRow[];
  expect(rows.every((row) => row.score === row.complexity)).toBe(true);
  const scores = rows.map((row) => row.score);
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
});

test("a nested function adds to its parent and is not summed again", async () => {
  const nested = buildRepo([
    {
      type: "commit",
      message: "Add a nested function",
      date: "2024-01-02T00:00:00+00:00",
      changes: [
        {
          op: "add",
          path: "src/nested.ts",
          content: "export function outer(a: boolean): number {\n  function inner(b: boolean): number {\n    return b ? 1 : 2;\n  }\n  return a ? inner(a) : 0;\n}\n",
        },
      ],
    },
  ]);
  try {
    const run = await runComplexity(nested.path, ["files", "--json", "--limit", "all", "src"]);
    const row = (JSON.parse(run.stdout).results as FileRow[]).find((entry) => entry.path === "src/nested.ts")!;
    // outer: inner's ternary at nesting 1 adds +2, and its own ternary +1. inner on its own is 1. Only outer is summed.
    expect(row.functions).toBe(2);
    expect(row.aggregates!.cognitive).toEqual({ sum: 3, max: 3 });
  } finally {
    nested.dispose();
  }
});

test("the stored report is what the cochange plugin reads: a path and a numeric complexity per file", async () => {
  await files();
  const document = JSON.parse(readFileSync(join(repo.path, ".cache", "code-health", "reports", "complexity.files.json"), "utf8"));
  expect(document).toMatchObject({ tool: "complexity", command: "files", repo: { dirty: false } });
  expect(typeof document.config).toBe("string");
  for (const row of document.results as FileRow[]) {
    expect(typeof row.path).toBe("string");
    expect(typeof row.complexity).toBe("number");
  }
  expect(document.results).toHaveLength(6);
});
