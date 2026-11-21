import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { withoutMeta } from "@code-health/fixtures/cli-testing";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { calc, compositionHistory } from "./support/composition-scenario.ts";
import { expectGolden } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";

let repo: GitFixture;
let scratch: string;
beforeAll(() => {
  repo = compositionHistory();
  repo.git("config", "user.email", "alice@example.com");
  scratch = mkdtempSync(join(tmpdir(), "risk-evidence-"));
}, 60_000);
afterAll(() => {
  repo.dispose();
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  rmSync(join(repo.path, "code-health.json"), { force: true });
  repo.git("checkout", "--quiet", "main");
});

interface Factor {
  name: string;
  status: string;
  band: string | null;
  value: Record<string, unknown>;
  evidence: Record<string, unknown>[];
  reason: string | null;
  source: string;
  layer: string;
  thresholds: Record<string, unknown>;
}
interface Result {
  code: number;
  stdout: string;
  stderr: string;
  inputs: Record<string, any>;
  impact: { band: string; events: string[] };
  factors: Factor[];
  findings: { id: string; response: string }[];
}

async function risk(...args: string[]): Promise<Result> {
  const { code, stdout, stderr } = await runCochange(repo.path, ["risk", ...args, "--json"]);
  const document = stdout === "" ? undefined : JSON.parse(stdout);
  return { code, stdout, stderr, inputs: document?.inputs, impact: document?.results.impact, factors: document?.results.factors, findings: document?.results.findings };
}
const factor = (result: Result, name: string): Factor => result.factors.find((f) => f.name === name)!;

const evidenceFile = (name: string, document: unknown): string => {
  const file = join(scratch, name);
  writeFileSync(file, JSON.stringify(document));
  return file;
};

const here = dirname(fileURLToPath(import.meta.url));
const complexityDist = join(here, "..", "..", "..", "plugins", "complexity", "dist", "complexity.mjs");

describe("without the sibling plugins", () => {
  test("complexity-delta falls back to the rise in indentation complexity of the touched files", async () => {
    const result = await risk("main..nest");
    const delta = factor(result, "complexity-delta");
    expect(delta).toMatchObject({ status: "ok", layer: "lexical", source: "indentation" });
    expect(delta.value).toMatchObject({ count: 1, files: 1 });
    expect(delta.evidence).toHaveLength(1);
    expect(delta.evidence[0]).toMatchObject({ file: calc });
    expect(Number(delta.evidence[0]!.delta)).toBeGreaterThanOrEqual(10);
    expect(result.findings.map((f) => f.id)).toContain("complexity-delta");
  });

  test("a change that adds no complexity has none", async () => {
    expect(factor(await risk("main..quiet"), "complexity-delta").value).toMatchObject({ count: 0 });
  });

  test("structure-delta and abandoned-touched are unavailable, never low, and say what would supply them", async () => {
    const result = await risk("main..nest");
    expect(factor(result, "structure-delta")).toMatchObject({ status: "unavailable", band: null });
    expect(factor(result, "structure-delta").reason).toMatch(/--evidence/);
    expect(factor(result, "abandoned-touched")).toMatchObject({ status: "unavailable", band: null });
  });
});

describe("evidence from complexity diff", () => {
  const diff = (range: string): string => {
    const stdout = execFileSync(process.execPath, [complexityDist, "diff", range, "--json"], { cwd: repo.path, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    return evidenceFile("complexity.json", JSON.parse(stdout));
  };

  test.runIf(existsSync(complexityDist))("the real plugin's diff is folded in as complexity-delta, with the units it named", async () => {
    const file = diff("main..nest");
    const result = await risk("main..nest", "--evidence", file);
    const delta = factor(result, "complexity-delta");
    expect(delta).toMatchObject({ status: "ok", layer: "structural", source: "complexity diff" });
    expect(delta.value).toMatchObject({ count: 1 });
    expect(delta.evidence[0]).toMatchObject({ unit: `${calc}#classify`, change: "added" });
    expect(result.inputs.evidence).toEqual([{ tool: "complexity", command: "diff", hash: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
    expect(result.findings.find((f) => f.id === "complexity-delta")!.response).toBe("Run `complexity explain` on the named units and simplify before merge.");
  });

  test.runIf(existsSync(complexityDist))("a diff of a change that adds nothing hard to read counts none", async () => {
    const result = await risk("main..quiet", "--evidence", diff("main..quiet"));
    expect(factor(result, "complexity-delta").value).toMatchObject({ count: 0 });
  });

  test("a diff made against another base is refused, since it describes another change", async () => {
    const file = evidenceFile("other.json", {
      tool: "complexity",
      command: "diff",
      inputs: { base: { rev: "main", sha: "0".repeat(40) }, head: null, against: "working-tree" },
      results: [],
    });
    const result = await risk("main..nest", "--evidence", file);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toMatch(/starts at/);
  });
});

describe("evidence from structure check", () => {
  const check = (results: unknown[], base?: string) =>
    evidenceFile("structure.json", { tool: "structure", command: "check", inputs: base ? { base: "main", baseSha: base } : {}, results });

  test("new cycles and layer violations become structure-delta, an event that raises the impact band", async () => {
    const without = await risk("main..quiet");
    const base = repo.git("merge-base", "main", "quiet");
    const file = check([{ kind: "cycle", id: "cycle:file:a.ts" }, { kind: "layer-violation", id: "layer:ui.ts to db.ts" }], base);
    const result = await risk("main..quiet", "--evidence", file);
    const delta = factor(result, "structure-delta");
    expect(delta).toMatchObject({ status: "ok", layer: "structural", source: "structure check", value: { count: 2 } });
    expect(result.impact.events).toEqual(["structure-delta"]);
    expect(without.impact.events).toEqual([]);
    expect(result.findings.find((f) => f.id === "structure-delta")!.response).toBe("Review the new dependency with the structure skill before it lands.");
  });

  test("a check that finds nothing is a count of zero, not unavailable", async () => {
    const result = await risk("main..quiet", "--evidence", check([]));
    expect(factor(result, "structure-delta")).toMatchObject({ status: "ok", band: "low", value: { count: 0 } });
  });

  test("both results can be passed together, and the output is the same however they are ordered", async () => {
    const a = evidenceFile("a.json", { tool: "structure", command: "check", inputs: {}, results: [] });
    const b = evidenceFile("b.json", { tool: "complexity", command: "diff", inputs: {}, results: [], unsupportedFiles: 0 });
    const first = await risk("main..quiet", "--evidence", a, "--evidence", b);
    // Named in the order given, so the order is part of the input; the factors do not depend on it.
    const second = await risk("main..quiet", "--evidence", b, "--evidence", a);
    expect(first.factors).toEqual(second.factors);
    expect(first.inputs.evidence.map((s: { tool: string }) => s.tool)).toEqual(["structure", "complexity"]);
  });

  test("the output is byte for byte the same for the same evidence", async () => {
    const file = check([{ kind: "cycle", id: "a<->b" }]);
    const one = await risk("main..quiet", "--evidence", file);
    const two = await risk("main..quiet", "--evidence", file);
    expect(withoutMeta(one.stdout)).toBe(withoutMeta(two.stdout));
    expect(one.stdout).not.toContain(scratch);
  });
});

describe("bad evidence is a usage error and never silently dropped", () => {
  test("a file that is not there, is not JSON, or is not evidence this command reads", async () => {
    expect((await risk("main..quiet", "--evidence", join(scratch, "missing.json"))).code).toBe(ExitCode.Usage);
    const text = join(scratch, "text.json");
    writeFileSync(text, "not json");
    expect((await risk("main..quiet", "--evidence", text)).code).toBe(ExitCode.Usage);
    const other = evidenceFile("hotspots.json", { tool: "cochange", command: "hotspots", results: [] });
    const refused = await risk("main..quiet", "--evidence", other);
    expect(refused.code).toBe(ExitCode.Usage);
    expect(refused.stderr).toMatch(/not evidence this command reads/);
  });

  test("the same kind of result twice", async () => {
    const a = evidenceFile("c1.json", { tool: "structure", command: "check", inputs: {}, results: [] });
    expect((await risk("main..quiet", "--evidence", a, "--evidence", a)).code).toBe(ExitCode.Usage);
  });
});

describe("locality's report", () => {
  const writeReport = (head: string, fanIns: Record<string, number>, filler = 20, dirty = false) => {
    const dir = join(repo.path, ".cache", "code-health", "reports");
    mkdirSync(dir, { recursive: true });
    const rows = [
      ...Object.entries(fanIns).map(([path, fanIn]) => ({ path, fanIn })),
      ...Array.from({ length: filler }, (_, i) => ({ path: `src/other/f${i}.ts`, fanIn: 1 + (i % 3) })),
    ];
    writeFileSync(join(dir, "locality.analyse.json"), JSON.stringify({ tool: "locality", command: "analyse", repo: { head, dirty }, config: "0123456789abcdef", results: rows }));
  };

  test("its fan-in is placed against every unit's, and the higher of that and the co-change band is the band", async () => {
    repo.git("checkout", "--quiet", "nest");
    writeReport(repo.git("rev-parse", "HEAD"), { [calc]: 40 });
    const result = await risk();
    const blast = factor(result, "blast-radius");
    expect(blast.value).toMatchObject({ files: 0, fanIn: 40 });
    expect(blast.band).toBe("high");
    expect(blast.source).toBe("co-change and locality report");
    expect(blast.evidence).toEqual([{ file: calc, fanIn: 40, from: "locality" }]);
    expect(result.inputs.locality).toEqual({ report: "locality.analyse", head: repo.git("rev-parse", "HEAD"), config: "0123456789abcdef" });
  });

  test("a report stamped with another commit is not used, so the factor stays as history gives it", async () => {
    repo.git("checkout", "--quiet", "nest");
    writeReport("0".repeat(40), { [calc]: 40 });
    const result = await risk();
    expect(factor(result, "blast-radius").value).not.toHaveProperty("fanIn");
    expect(result.inputs.locality).toBeNull();
  });

  test("a report taken on a dirty tree is not used either", async () => {
    repo.git("checkout", "--quiet", "nest");
    writeReport(repo.git("rev-parse", "HEAD"), { [calc]: 40 }, 20, true);
    expect(factor(await risk(), "blast-radius").value).not.toHaveProperty("fanIn");
  });

  test("a small report cannot place a fan-in, and leaves the co-change band alone", async () => {
    repo.git("checkout", "--quiet", "nest");
    writeReport(repo.git("rev-parse", "HEAD"), { [calc]: 40 }, 3);
    const blast = factor(await risk(), "blast-radius");
    expect(blast.value).toMatchObject({ fanIn: 40 });
    expect(blast.thresholds.fanIn).toBeNull();
    expect(blast.band).toBe("low");
  });
});

test("a branch with a structure check passed in, byte for byte", async () => {
  const file = evidenceFile("structure.json", { tool: "structure", command: "check", inputs: {}, results: [{ kind: "cycle", id: "a-b" }] });
  const { stdout } = await runCochange(repo.path, ["risk", "main..nest", "--evidence", file]);
  expectGolden("composition", "risk.structure", stdout);
});
