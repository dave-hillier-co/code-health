import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden, withoutMeta } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";
import { buildRepo } from "./support/scenarios.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = buildRepo();
});
afterAll(() => repo.dispose());

const reportFile = (name: string) => join(repo.path, ".cache", "code-health", "reports", `complexity.${name}.json`);

interface Row {
  path: string;
  unit: string;
  cognitive?: number;
  cyclomatic?: number;
  nesting?: number;
  parameters?: number;
  score: number;
  dominant: string | null;
  source: string;
  labels: string[];
}

async function analyse(...args: string[]) {
  const run = await runComplexity(repo.path, ["analyse", "--json", "--limit", "all", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return run;
}

describe("analyse", () => {
  test("ranks functions with the hand-counted metrics and matches its golden", async () => {
    const { stdout } = await analyse();
    expectGolden("pricing", "analyse", stdout);
    const rows = (JSON.parse(stdout).results as Row[]).filter((row) => row.path === "src/pricing.ts");
    const price = rows.find((row) => row.unit === "price")!;
    expect([price.cognitive, price.cyclomatic, price.nesting, price.parameters]).toEqual([8, 5, 2, 1]);
    expect(price.source).toBe("structural");
    expect((price as Row & { optionCount: number }).optionCount).toBe(0);
    expect(price.dominant).not.toBeNull();
  });

  test("puts the most complex function first, and tests are ranked among themselves", async () => {
    const rows = JSON.parse((await analyse()).stdout).results as (Row & { test: boolean; id: string })[];
    expect(rows[0]!.id).toBe("src/pricing.ts#price");
    const testRow = rows.find((row) => row.path === "test/pricing.test.ts")!;
    expect(testRow.test).toBe(true);
  });

  test("selects metrics with --metrics and ranks on them alone", async () => {
    const { stdout } = await analyse("--metrics", "cognitive");
    expectGolden("pricing", "analyse.cognitive", stdout);
    const row = (JSON.parse(stdout).results as Row[])[0]!;
    expect(row.cyclomatic).toBeUndefined();
    expect(row.dominant).toBe("cognitive");
  });

  test("measures with the lexical layer when asked and reports the agreement that released it", async () => {
    const { stdout } = await analyse("--layer", "lexical", "src/pricing.ts");
    expectGolden("pricing", "analyse.lexical", stdout);
    const document = JSON.parse(stdout);
    expect(document.results.every((row: Row) => row.source === "lexical")).toBe(true);
    expect(document.agreement.typescript.exactRate).toBeGreaterThanOrEqual(0.9);
  });

  test("a configured agreement bar the recorded rate misses withholds the lexical metrics and says why", async () => {
    writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ complexity: { agreementBar: 1 } }));
    try {
      const document = JSON.parse((await analyse("--layer", "lexical")).stdout);
      // TypeScript's recorded rate is below a bar of 1, so none of its functions are measured lexically. Another language may clear it.
      expect((document.results as Row[]).some((row) => row.path.endsWith(".ts"))).toBe(false);
      expect(document.agreement.typescript).toBeUndefined();
      expect(Object.keys(document.skipped)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^per-function metrics: typescript agreement 0\.\d+ is below the bar 1$/)]),
      );
    } finally {
      rmSync(join(repo.path, "code-health.json"), { force: true });
    }
  });

  test("restricts the rows to the paths given, while ranking against the whole repository", async () => {
    const everything = JSON.parse((await analyse()).stdout).results as Row[];
    const only = JSON.parse((await analyse("src/label.ts")).stdout).results as Row[];
    expect(only.map((row) => row.unit)).toEqual(["label"]);
    expect(only[0]!.score).toBe(everything.find((row) => row.path === "src/label.ts")!.score);
  });

  test("labels units over a threshold", async () => {
    writeFileSync(
      join(repo.path, "code-health.json"),
      JSON.stringify({ complexity: { thresholds: { cognitive: { warn: 5, high: 7 }, cyclomatic: { warn: 10, high: 20 } } } }),
    );
    try {
      const rows = JSON.parse((await analyse()).stdout).results as Row[];
      expect(rows.find((row) => row.unit === "price")!.labels).toEqual(["cognitive-high"]);
      expect(rows.find((row) => row.unit === "label")!.labels).toEqual([]);
    } finally {
      rmSync(join(repo.path, "code-health.json"), { force: true });
    }
  });

  test("rejects an unknown metric and an unknown layer", async () => {
    const metric = await runComplexity(repo.path, ["analyse", "--metrics", "bogus"]);
    expect(metric.code).toBe(ExitCode.Usage);
    expect(metric.stderr).toContain("unknown metric bogus");
    const layer = await runComplexity(repo.path, ["analyse", "--layer", "bogus"]);
    expect(layer.code).toBe(ExitCode.Usage);
  });

  test("is deterministic, byte for byte once meta is removed", async () => {
    expect(withoutMeta((await analyse()).stdout)).toBe(withoutMeta((await analyse()).stdout));
  });
});

describe("reports", () => {
  test("a whole-repository run on a clean tree stores the report, stamped with HEAD and the config hash", async () => {
    await analyse();
    const document = JSON.parse(readFileSync(reportFile("analyse"), "utf8"));
    expect(document).toMatchObject({ tool: "complexity", command: "analyse", repo: { head: repo.git("rev-parse", "HEAD"), dirty: false } });
    expect(document.meta).toBeUndefined();
    // --limit never cuts what is stored.
    const limited = await runComplexity(repo.path, ["analyse", "--json", "--limit", "1"]);
    expect(JSON.parse(limited.stdout).results).toHaveLength(1);
    expect(JSON.parse(readFileSync(reportFile("analyse"), "utf8")).results.length).toBeGreaterThan(1);
  });

  test("a run over some paths, metrics or one layer is not stored", async () => {
    for (const name of ["analyse", "files"]) writeFileSync(reportFile(name), "stale");
    await analyse("src/label.ts");
    await analyse("--metrics", "cognitive");
    await runComplexity(repo.path, ["files", "--json", "src"]);
    expect(readFileSync(reportFile("analyse"), "utf8")).toBe("stale");
    expect(readFileSync(reportFile("files"), "utf8")).toBe("stale");
  });
});

describe("a dirty tree", () => {
  test("is measured as it stands on disk, and nothing is stored", async () => {
    const clean = repo.git("rev-parse", "HEAD");
    writeFileSync(join(repo.path, "src/label.ts"), "export function label(n: string): string {\n  if (n) {\n    if (n.length > 1) return n;\n  }\n  return '';\n}\n");
    writeFileSync(reportFile("analyse"), "stale");
    try {
      const document = JSON.parse((await analyse()).stdout);
      expect(document.inputs.tree).toBe("working-tree");
      expect(document.repo).toEqual({ head: clean, dirty: true });
      expect(document.results.find((row: Row) => row.unit === "label").cognitive).toBe(3);
      expect(readFileSync(reportFile("analyse"), "utf8")).toBe("stale");
    } finally {
      repo.git("checkout", "--", ".");
    }
    expect(existsSync(join(repo.path, "src/label.ts"))).toBe(true);
  });
});

describe("a new file that is not committed", () => {
  test("is measured too and nothing is stored, although the tracked files are clean", async () => {
    writeFileSync(join(repo.path, "src/fresh.ts"), "export function fresh(a: boolean): number {\n  return a ? 1 : 2;\n}\n");
    writeFileSync(reportFile("analyse"), "stale");
    try {
      const document = JSON.parse((await analyse()).stdout);
      expect(document.repo.dirty).toBe(false);
      expect(document.inputs.tree).toBe("working-tree");
      expect(document.results.map((row: Row) => row.unit)).toContain("fresh");
      expect(readFileSync(reportFile("analyse"), "utf8")).toBe("stale");
    } finally {
      rmSync(join(repo.path, "src/fresh.ts"));
    }
  });
});
