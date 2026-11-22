import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Step } from "@code-health/fixtures/git-fixture";
import { runComplexity } from "./support/run.ts";

/** A function whose cognitive complexity is 3 (an `if` inside a `for`), under a name that makes each copy distinct. */
const complex = (name: string, revision: number) =>
  `export function ${name}(items: number[]): number {\n  let total = ${revision};\n  for (const item of items) {\n    if (item > 0) {\n      total += item;\n    }\n  }\n  return total;\n}\n`;

const simple = (revision: number) => `export function plain(x: number): number {\n  return x + ${revision};\n}\n`;

function history(): Step[] {
  const steps: Step[] = [
    {
      type: "commit",
      message: "Add everything long ago",
      date: "2020-01-01T09:00:00+00:00",
      changes: [
        { op: "add", path: "src/frozen.ts", content: complex("frozen", 0) },
        { op: "add", path: "src/busy.ts", content: complex("busy", 0) },
        { op: "add", path: "src/quiet.ts", content: complex("quiet", 0) },
        { op: "add", path: "src/plain.ts", content: simple(0) },
      ],
    },
  ];
  for (let week = 1; week <= 6; week++) {
    steps.push({
      type: "commit",
      message: `Change busy ${week}`,
      date: `2024-0${week}-10T09:00:00+00:00`,
      changes: [
        { op: "modify", path: "src/busy.ts", content: complex("busy", week) },
        ...(week <= 3 ? [{ op: "modify" as const, path: "src/plain.ts", content: simple(week) }] : []),
      ],
    });
  }
  steps.push({
    type: "commit",
    message: "Change quiet once",
    date: "2024-06-20T09:00:00+00:00",
    changes: [{ op: "modify", path: "src/quiet.ts", content: complex("quiet", 1) }],
  });
  return steps;
}

let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build(history());
});
afterAll(() => repo.dispose());

interface Row {
  path: string;
  score: number;
  cognitive?: number;
  complexityScore: number | null;
  changeWeightedScore: number | null;
  fileRevisions: number | null;
  changeWeight: number | null;
}

async function analyse(...args: string[]) {
  const run = await runComplexity(repo.path, ["analyse", "--json", "--limit", "all", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return JSON.parse(run.stdout) as { ranking: { by: string; changeWeighted: boolean; changeWeightsAvailable: boolean; window: { months: number } | null }; results: Row[] };
}

describe("ranking by cognitive complexity, the default", () => {
  test("sorts by cognitive complexity alone, so code that has not changed in the window is not pushed down", async () => {
    const { results, ranking } = await analyse();
    expect(ranking).toMatchObject({ by: "cognitive", sortedBy: ["cognitive", "nesting", "cyclomatic", "length", "path"], changeWeighted: false, changeWeightsAvailable: true });
    // The three equally complex functions tie and sort by path, and the simpler function follows whatever its file's history.
    expect(results.map((row) => row.path)).toEqual(["src/busy.ts", "src/frozen.ts", "src/quiet.ts", "src/plain.ts"]);
    for (const row of results) expect(row.score).toBe(row.cognitive);
    expect(results.find((row) => row.path === "src/frozen.ts")).toMatchObject({ fileRevisions: 0, changeWeight: 0, changeWeightedScore: 0 });
  });

  test("--by with an unknown value is a usage error", async () => {
    const run = await runComplexity(repo.path, ["analyse", "--json", "--by", "hotspot"]);
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toMatch(/--by must be one of cognitive, max-percentile, change-weighted, cyclomatic, nesting, parameters, length, keyword, bumps/);
  });
});

describe("ranking by the highest percentile, with --by max-percentile", () => {
  test("sorts by complexityScore, and the score is that percentile", async () => {
    const { results, ranking } = await analyse("--by", "max-percentile");
    expect(ranking).toMatchObject({ by: "max-percentile", sortedBy: ["max percentile", "cognitive", "nesting", "cyclomatic", "length", "path"] });
    for (const row of results) expect(row.score).toBe(row.complexityScore);
    expect(results.map((row) => row.path)).toEqual(["src/busy.ts", "src/frozen.ts", "src/quiet.ts", "src/plain.ts"]);
  });
});

describe("change-weighted ranking, with --by change-weighted", () => {
  test("equally complex functions rank by how often their file changes, and code that has not changed in the window ranks last", async () => {
    const { results, ranking } = await analyse("--by", "change-weighted");
    expect(ranking).toMatchObject({ by: "change-weighted", changeWeighted: true, changeWeightsAvailable: true });
    expect(ranking.window).toMatchObject({ months: 12 });
    const complexRows = results.filter((row) => row.path !== "src/plain.ts");
    expect(complexRows.map((row) => row.path)).toEqual(["src/busy.ts", "src/quiet.ts", "src/frozen.ts"]);
    expect(results.find((row) => row.path === "src/frozen.ts")).toMatchObject({ fileRevisions: 0, changeWeight: 0, score: 0 });
  });

  test("each row says how often its file changed, its weight, and the complexity percentile before weighting", async () => {
    const { results } = await analyse();
    const busy = results.find((row) => row.path === "src/busy.ts")!;
    expect(busy.fileRevisions).toBe(6);
    const quiet = results.find((row) => row.path === "src/quiet.ts")!;
    expect(busy.changeWeight!).toBeGreaterThan(quiet.changeWeight!);
    expect(quiet.changeWeight!).toBeGreaterThan(0);
    expect(busy.complexityScore).toBeGreaterThan(0);
    expect(busy.changeWeightedScore).toBeCloseTo(busy.complexityScore! * busy.changeWeight!, 3);
    expect(quiet.fileRevisions).toBe(1);
    const weighted = await analyse("--by", "change-weighted");
    expect(weighted.results.find((row) => row.path === "src/busy.ts")!.score).toBeCloseTo(busy.complexityScore! * busy.changeWeight!, 3);
  });

  test("with complexity.changeWeighting off the ranking is by percentile alone", async () => {
    const off = GitFixture.build(history());
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${off.path}/code-health.json`, JSON.stringify({ complexity: { changeWeighting: false } }));
      const run = await runComplexity(off.path, ["analyse", "--json", "--limit", "all"]);
      const document = JSON.parse(run.stdout);
      expect(document.ranking).toMatchObject({ changeWeighted: false, changeWeightsAvailable: false });
      expect(document.results.every((row: Row) => row.fileRevisions === null && row.changeWeight === null && row.changeWeightedScore === null)).toBe(true);
      const refused = await runComplexity(off.path, ["analyse", "--json", "--by", "change-weighted"]);
      expect(refused.code).toBe(ExitCode.Usage);
      expect(refused.stderr).toMatch(/needs change frequency/);
    } finally {
      off.dispose();
    }
  });
});
