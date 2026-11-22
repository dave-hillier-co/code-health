import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { levelOf, type Level } from "../src/risk/level.ts";
import type { PlacementBand } from "../src/risk/placement.ts";
import { reportPath } from "../src/reports.ts";
import { riskHistory, invoiceTest, login, summary, tax } from "./support/risk-scenario.ts";
import { runCochange } from "./support/run.ts";

describe("the level table", () => {
  const table: [string, PlacementBand, Level][] = [
    ["low", "close", "routine"],
    ["low", "mixed", "routine"],
    ["low", "unknown", "routine"],
    ["low", "distant", "attention"],
    ["moderate", "close", "routine"],
    ["moderate", "mixed", "attention"],
    ["moderate", "unknown", "attention"],
    ["moderate", "distant", "elevated"],
    ["high", "close", "attention"],
    ["high", "mixed", "elevated"],
    ["high", "unknown", "elevated"],
    ["high", "distant", "elevated"],
  ];
  test.each(table)("impact %s with placement %s is %s", (impact, placement, level) => {
    expect(levelOf(impact as "low", placement)).toBe(level);
  });

  test("an impact that could not be placed has no level, never a guess", () => {
    expect(levelOf("unavailable", "close")).toBeNull();
  });
});

let repo: GitFixture;
beforeAll(() => {
  repo = riskHistory();
  repo.git("config", "user.email", "alice@example.com");
  repo.git("config", "user.name", "Alice");
}, 60_000);
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, "code-health.json"), { force: true });
  rmSync(join(repo.path, ".cache", "code-health", "reports"), { recursive: true, force: true });
  repo.git("checkout", "--quiet", "main");
});

interface Finding {
  id: string;
  factor: string | null;
  step: string;
  response: string;
  redFlag: string | null;
  evidence: Record<string, unknown>[];
  fromPlacement: boolean;
}
interface LevelOut {
  status: string;
  value: string | null;
  impact: string;
  placement: string;
  reason: string | null;
  backtest: { head: string; separation: { status: string }; commitsAgo: number | null } | null;
}

async function risk(...args: string[]) {
  const { code, stdout, stderr } = await runCochange(repo.path, ["risk", ...args, "--json"]);
  const document = stdout === "" ? undefined : JSON.parse(stdout);
  return { code, stderr, results: document?.results as { level: LevelOut; findings: Finding[]; impact: { band: string } } };
}

const storedFile = () => reportPath(repo.path, "risk-backtest");

/** Runs the backtest, then rewrites its stored verdict, standing in for a repository where the levels do separate. */
async function storeVerdict(status: "separates" | "does-not-separate" | "insufficient"): Promise<void> {
  await runCochange(repo.path, ["risk", "backtest"]);
  const document = JSON.parse(readFileSync(storedFile(), "utf8"));
  document.results.separation = { status, reason: `set by the test to ${status}` };
  writeFileSync(storedFile(), JSON.stringify(document));
}

describe("the level is shown only when a backtest has shown that the levels separate", () => {
  test("with no stored backtest there is no level, and the reason says a level needs a stored backtest", async () => {
    const { results } = await risk("main..missing");
    expect(results.level).toMatchObject({ status: "unavailable", value: null, backtest: null });
    expect(results.level.reason).toMatch(/only where a stored backtest/);
    // The bands, findings and responses stand alone.
    expect(results.impact.band).not.toBe("unavailable");
    expect(results.findings.length).toBeGreaterThan(0);
  });

  test("a backtest in which the levels do not separate leaves the level withheld, with the backtest's reason", async () => {
    await storeVerdict("does-not-separate");
    const { results } = await risk("main..missing");
    expect(results.level).toMatchObject({ status: "withheld", value: null });
    expect(results.level.reason).toMatch(/do not separate/);
    expect(results.level.backtest?.separation.status).toBe("does-not-separate");
  });

  test("a backtest without enough evidence leaves it withheld too", async () => {
    await storeVerdict("insufficient");
    const { results } = await risk("main..missing");
    expect(results.level.status).toBe("withheld");
    expect(results.level.reason).toMatch(/cannot yet be shown/);
  });

  test("once the levels separate the level is shown, from impact and placement, with the backtest beside it", async () => {
    await storeVerdict("separates");
    const { results } = await risk("main..missing");
    // Alice has nine changes, fewer than the ten that make an identity known, so her placement is unknown: moderate with unknown is attention.
    expect(results.impact.band).toBe("moderate");
    expect(results.level).toMatchObject({ status: "shown", value: "attention", impact: "moderate", placement: "unknown" });
    expect(results.level.backtest).toMatchObject({ head: repo.git("rev-parse", "main"), separation: { status: "separates" }, commitsAgo: 1 });
  });

  test("a sensitive path raises the impact band and, through it, the level", async () => {
    await storeVerdict("separates");
    const { results } = await risk("main..auth");
    expect(results.impact.band).toBe("moderate");
    expect(results.level.impact).toBe("moderate");
  });

  test("when placement is withheld the level uses unknown, and says so", async () => {
    await storeVerdict("separates");
    const { results } = await risk("main..bulk");
    expect(results.level.placement).toBe("unknown");
  });

  test("a backtest made with another configuration is not reused: its verdict is about a different model", async () => {
    await storeVerdict("separates");
    writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"risk":{"countHigh":4}}}\n');
    const { results } = await risk("main..missing");
    expect(results.level).toMatchObject({ status: "unavailable", backtest: null });
  });

  test("the level is never written down", async () => {
    await storeVerdict("separates");
    repo.git("checkout", "--quiet", "missing");
    const { results } = await risk();
    expect(results.level.status).toBe("shown");
    const text = readFileSync(reportPath(repo.path, "risk"), "utf8");
    expect(text).not.toMatch(/"level"|attention|routine|elevated|placement/);
  });
});

describe("findings and responses", () => {
  test("a change that misses its coupled files leads with completeness, then tests, each with the spec's response", async () => {
    const { results } = await risk("main..missing");
    expect(results.findings.map((f) => [f.id, f.step])).toEqual([
      ["missing-co-change", "complete"],
      ["test-evidence", "test"],
    ]);
    const missing = results.findings[0]!;
    expect(missing.response).toBe("Open the named files and decide, for each, whether it needs changing. Record the ones deliberately left alone.");
    expect(missing.redFlag).toBe("Information leakage");
    expect(missing.evidence.map((e) => e.file)).toEqual([invoiceTest, tax]);
    expect(results.findings[1]!.response).toBe("Add or update the tests that usually change with these files, or say why not.");
  });

  test("a complete change has no completeness finding", async () => {
    const { results } = await risk("main..complete");
    expect(results.findings.map((f) => f.id)).not.toContain("missing-co-change");
  });

  test("a move together with an edit is to be split, moves first", async () => {
    const { results } = await risk("main..mixed");
    const finding = results.findings.find((f) => f.id === "mixed-purpose")!;
    expect(finding.step).toBe("split");
    expect(finding.response).toBe("Split the change: moves and renames first, as their own commits or their own merge request.");
  });

  test("a change high on size or spread is to be split along its components", async () => {
    const { results } = await risk("main..bulk");
    const ids = results.findings.map((f) => f.id);
    expect(ids).toContain("size");
    expect(ids).toContain("spread");
    expect(results.findings.find((f) => f.id === "size")!.response).toBe("Split along the components touched, when they can merge independently.");
  });

  test("a sensitive path is an event and a finding", async () => {
    const { results } = await risk("main..auth");
    expect(results.findings.map((f) => f.id)).toEqual(["sensitive-paths"]);
    expect(results.findings[0]!.evidence).toEqual([{ file: login }]);
  });

  test("a coupling between files that never changed together is to be confirmed, and may be the start of information leakage", async () => {
    writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"risk":{"novelDistance":2}}}\n');
    const { results } = await risk("main..novel");
    const finding = results.findings.find((f) => f.id === "novel-coupling")!;
    expect(finding.response).toMatch(/Confirm the new dependency is intended/);
    expect(finding.redFlag).toBe("Information leakage");
    expect(finding.evidence).toEqual([{ a: login, b: summary, distance: 2 }]);
  });

  test("findings are ordered by what to do first: complete, split, test, simplify, check, review", async () => {
    writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"risk":{"countModerate":1}}}\n');
    const { results } = await risk("main..bulk");
    const steps = results.findings.map((f) => f.step);
    expect(steps).toEqual([...steps].sort((a, b) => ["complete", "split", "test", "simplify", "check", "review"].indexOf(a) - ["complete", "split", "test", "simplify", "check", "review"].indexOf(b)));
  });

  test("a factor that is unavailable raises no finding", async () => {
    const { results } = await risk("main..complete");
    expect(results.findings.map((f) => f.factor)).not.toContain("defect-history");
  });

  test("each finding has a rule that cochange explain describes", async () => {
    const { code, stdout } = await runCochange(repo.path, ["explain", "risk-missing-co-change"]);
    expect(code).toBe(ExitCode.Success);
    expect(stdout).toMatch(/Usually information leakage/);
    expect(stdout).toMatch(/Suggested response: Open the named files/);
  });

  test("advice, not a gate: every level exits 0", async () => {
    for (const branch of ["complete", "missing", "mixed", "bulk", "auth"]) expect((await risk(`main..${branch}`)).code).toBe(ExitCode.Success);
  });
});
