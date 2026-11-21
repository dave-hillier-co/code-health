import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { body } from "./support/risk-scenario.ts";
import { backtestHistory, bob, dateOf, prepare, type Prepared } from "./support/backtest-scenario.ts";
import { expectGolden } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";
import { outcomesOf, scoreMainline, separationOf, type BandRow, type ScoredChange } from "../src/risk/backtest.ts";
import { readStoredBacktest } from "../src/risk/stored-backtest.ts";
import { bandAgainst, cutoffsOf } from "../src/risk/bands.ts";
import { chronologicalPass } from "../src/risk/history-pass.ts";
import { baselineScores, makeBander } from "../src/risk/scoring.ts";
import { reportPath } from "../src/reports.ts";

let repo: GitFixture;
let revertedSha: string;
let prepared: Prepared;
beforeAll(async () => {
  ({ repo, revertedSha } = backtestHistory());
  prepared = await prepare(repo.path);
}, 60_000);
afterAll(() => repo.dispose());

const score = (p: Prepared, since?: number): ScoredChange[] =>
  scoreMainline(p.mainline.changes, p.context, { windowMonths: p.windowMonths, maxChangesetSize: p.maxChangesetSize, since });

/** What a change was scored, without the change itself, for comparing two runs. */
const verdict = (s: ScoredChange) => ({
  id: s.change.id,
  bands: [...s.bands],
  impact: s.impact,
  placement: s.placement,
  level: s.level,
  baseline: s.baseline,
});

describe("as of each change", () => {
  test("every change on the main line is one merged change, and scoring walks them oldest first", () => {
    expect(prepared.mainline.changes).toHaveLength(40);
    expect(prepared.mainline.changes.map((c) => c.time)).toEqual([...prepared.mainline.changes.map((c) => c.time)].sort((a, b) => a - b));
    expect(score(prepared).map((s) => s.index)).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  test("a change is compared only with the merged changes before it, so the first has nothing to be compared with", () => {
    const scored = score(prepared);
    expect(scored[0]!.baseline).toBe(0);
    expect(scored[12]!.baseline).toBe(12);
    // With too little to compare it with, a change is unavailable, never low, and has no level.
    for (const early of [scored[0]!, scored[5]!]) {
      expect(early.impact.band).toBe("unavailable");
      expect(early.level).toBeNull();
    }
    expect(scored[12]!.impact.band).not.toBe("unavailable");
  });

  test("no later commit can change an earlier score", async () => {
    const full = score(prepared);
    for (const upTo of [12, 18, 24, 31]) {
      const earlier = prepared.mainline.changes.slice(0, upTo);
      const truncated = scoreMainline(earlier, prepared.context, { windowMonths: prepared.windowMonths, maxChangesetSize: prepared.maxChangesetSize });
      expect(truncated.map(verdict), `the first ${upTo} changes`).toEqual(full.slice(0, upTo).map(verdict));
    }
  });

  test("later commits that make a file hot, add a coupling and fix it still leave earlier scores alone", async () => {
    // After the 40 weekly changes, ten more rewrite the first small file together with a wide one, and fix it.
    const wide = "src/wide/w05.ts";
    const extra = Array.from({ length: 10 }, (_, i) => [
      { op: "modify" as const, path: "src/mod0/a.ts", content: body("src/mod0/a.ts", 10, 100 + i) },
      { op: "modify" as const, path: wide, content: body(wide, 20, 100 + i) },
    ]);
    const { repo: later } = backtestHistory(extra);
    try {
      const prepareLater = await prepare(later.path);
      expect(prepareLater.mainline.changes).toHaveLength(50);
      const before = score(prepared).map(verdict);
      const after = score(prepareLater).slice(0, 40).map(verdict);
      // Change ids are the commits' own SHAs, which the later history shares up to change 39.
      expect(after).toEqual(before);
    } finally {
      later.dispose();
    }
  }, 60_000);

  test("a change from a window not yet reached is unscored when --since asks for later ones, yet it still feeds the history", () => {
    const since = prepared.mainline.changes[30]!.time;
    const windowed = score(prepared, since);
    const full = score(prepared);
    expect(windowed.map((s) => s.index)).toEqual(Array.from({ length: 10 }, (_, i) => 30 + i));
    expect(windowed.map(verdict)).toEqual(full.slice(30).map(verdict));
  });
});

describe("bands over a real baseline", () => {
  test("no more than a quarter of the baseline is moderate or above on any banded factor or on impact, and no more than a tenth is high", () => {
    const { past } = chronologicalPass(prepared.mainline.changes, prepared.context, {
      windowMonths: prepared.windowMonths,
      maxChangesetSize: prepared.maxChangesetSize,
      fixPatterns: [...prepared.risk.fixPatterns, ...prepared.risk.revertPatterns],
    });
    const baseline = past.slice(5).map((p) => p.measurements);
    const bander = makeBander(baseline, prepared.risk);
    const names = baseline[0]!.filter((m) => m.kind === "percentile").map((m) => m.name);
    for (const name of names) {
      const bands = baseline.flatMap((measures) => {
        const m = measures.find((x) => x.name === name)!;
        return m.unavailable === null ? [bander(m).band] : [];
      }).filter((band) => band !== "unavailable");
      expect(bands.filter((b) => b !== "low").length, `${name} moderate or above`).toBeLessThanOrEqual(Math.floor(bands.length / 4));
      expect(bands.filter((b) => b === "high").length, `${name} high`).toBeLessThanOrEqual(Math.floor(bands.length / 10));
    }
    const scores = baselineScores(baseline, prepared.risk);
    const cutoffs = cutoffsOf(scores, prepared.risk.moderatePercentile, prepared.risk.highPercentile)!;
    const impact = scores.map((score) => bandAgainst(score, cutoffs));
    expect(impact.filter((b) => b !== "low").length).toBeLessThanOrEqual(Math.floor(scores.length / 4));
    expect(impact.filter((b) => b === "high").length).toBeLessThanOrEqual(Math.floor(scores.length / 10));
  });

  test("a zero is low on every factor, however the baseline falls", () => {
    const { past } = chronologicalPass(prepared.mainline.changes, prepared.context, {
      windowMonths: prepared.windowMonths,
      maxChangesetSize: prepared.maxChangesetSize,
      fixPatterns: [],
    });
    const baseline = past.slice(0, 30).map((p) => p.measurements);
    const bander = makeBander(baseline, prepared.risk);
    for (const measures of baseline) {
      for (const m of measures) {
        if (m.unavailable === null && Object.values(m.series).every((v) => v === 0)) expect(bander(m).band, m.name).toBe("low");
      }
    }
  });
});

describe("outcomes", () => {
  test("a change is followed by trouble when it is reverted by a later change or a fix touches its files within the window", async () => {
    const outcomes = await outcomesOf(repo.path, prepared.headSha, prepared.mainline.changes, prepared.risk, prepared.headDate);
    const flags = prepared.mainline.changes.map((c) => outcomes.get(c.id)!);
    // Each wide change but the last is fixed the week after: 5, 11, 17, 23, 29.
    expect(flags.flatMap((f, i) => (f.fixed ? [i] : []))).toEqual([5, 11, 17, 23, 29, 35]);
    expect(flags.flatMap((f, i) => (f.reverted ? [i] : []))).toEqual([20]);
    expect(prepared.mainline.changes[20]!.shas).toEqual([revertedSha]);
  });

  test("a change too recent for its follow-up window to have run is censored", async () => {
    const outcomes = await outcomesOf(repo.path, prepared.headSha, prepared.mainline.changes, prepared.risk, prepared.headDate);
    const censored = prepared.mainline.changes.flatMap((c, i) => (outcomes.get(c.id)!.censored ? [i] : []));
    // The head is change 39. Thirty days before it is 4.3 weeks, so changes 35 and later cannot have been followed up yet.
    expect(censored).toEqual([35, 36, 37, 38, 39]);
  });

  test("a fix that comes after the follow-up window does not make a change troubled, and later history leaves every earlier outcome alone", async () => {
    const { repo: later } = backtestHistory();
    try {
      // Change 1 touched src/mod1/a.ts. A fix to it forty weeks on is far outside any 30 day follow-up window.
      later.commit({ message: "Fix the tweak much later", date: dateOf(80), author: bob, changes: [{ op: "modify", path: "src/mod1/a.ts", content: body("src/mod1/a.ts", 10, 99) }] });
      const lateRun = await prepare(later.path);
      const lateOutcomes = await outcomesOf(later.path, lateRun.headSha, lateRun.mainline.changes, lateRun.risk, lateRun.headDate);
      const outcomes = await outcomesOf(repo.path, prepared.headSha, prepared.mainline.changes, prepared.risk, prepared.headDate);
      expect(lateOutcomes.get(lateRun.mainline.changes[1]!.id)).toMatchObject({ fixed: false, reverted: false, censored: false });
      // Changes 0 to 34 had their window closed before either head, so their outcomes are the same in both histories.
      for (let i = 0; i < 35; i++) {
        expect(lateOutcomes.get(lateRun.mainline.changes[i]!.id), `change ${i}`).toEqual(outcomes.get(prepared.mainline.changes[i]!.id));
      }
    } finally {
      later.dispose();
    }
  }, 60_000);

  test("a revert inside the change itself is not trouble for it", async () => {
    const outcomes = await outcomesOf(repo.path, prepared.headSha, prepared.mainline.changes, prepared.risk, prepared.headDate);
    expect(outcomes.get(prepared.mainline.changes[22]!.id)).toMatchObject({ reverted: false });
  });
});

describe("separation", () => {
  const row = (band: string, changes: number, troubled: number, baseRate: number | null = 0.1): BandRow => ({
    band,
    changes,
    troubled,
    rate: changes === 0 ? null : Math.round((troubled / changes) * 10_000) / 10_000,
    baseRate,
  });

  test("levels whose trouble rate rises, above the rate of the same files, separate", () => {
    const result = separationOf([row("routine", 20, 1), row("attention", 10, 3), row("elevated", 6, 4, 0.2)], 8);
    expect(result.status).toBe("separates");
  });

  test("levels whose rate does not rise do not separate", () => {
    expect(separationOf([row("routine", 20, 6), row("attention", 10, 1), row("elevated", 6, 0)], 7).status).toBe("does-not-separate");
  });

  test("a rise that does not beat the rate of the same files does not separate", () => {
    expect(separationOf([row("routine", 20, 2), row("elevated", 10, 4, 0.9)], 6).status).toBe("does-not-separate");
  });

  test("too few troubled changes, or too few changes in a level, is insufficient evidence, not a verdict", () => {
    expect(separationOf([row("routine", 20, 1), row("elevated", 10, 1)], 2).status).toBe("insufficient");
    expect(separationOf([row("routine", 20, 3), row("elevated", 2, 2)], 5).status).toBe("insufficient");
  });
});

describe("the command", () => {
  beforeEach(() => {
    rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
    rmSync(join(repo.path, "code-health.json"), { force: true });
  });

  const backtest = async (...args: string[]) => {
    const { code, stdout, stderr } = await runCochange(repo.path, ["risk", "backtest", ...args, "--json"]);
    return { code, stderr, stdout, document: stdout === "" ? undefined : JSON.parse(stdout) };
  };

  test("it tabulates trouble by level and by factor band, with the follow-up rate of the same files beside each", async () => {
    const { code, document } = await backtest();
    expect(code).toBe(ExitCode.Success);
    const results = document.results;
    expect(results.kind).toBe("backtest");
    expect(results.population).toMatchObject({ mergedChanges: 40, scored: 40, censored: 5 });
    expect(results.outcome).toMatchObject({ followUpDays: 30, fixConvention: true, reverts: 1 });
    expect(results.levels.map((l: BandRow) => l.band)).toEqual(["routine", "attention", "elevated"]);
    expect(results.factors.map((f: { name: string }) => f.name)).toContain("size");
    for (const row of results.levels as BandRow[]) expect(row.baseRate === null || row.baseRate >= 0).toBe(true);
    expect(results.limits.join(" ")).toMatch(/never per person/);
  });

  test("wide changes are high on size and carry the trouble, so the size factor separates here", async () => {
    const { document } = await backtest();
    const size = document.results.factors.find((f: { name: string }) => f.name === "size");
    const high = size.bands.find((b: BandRow) => b.band === "high");
    const low = size.bands.find((b: BandRow) => b.band === "low");
    expect(high.rate).toBeGreaterThan(low.rate);
  });

  test("a whole run on a clean tree is stored, with the verdict a later risk run reads", async () => {
    const { document } = await backtest();
    expect(document.results.stored).toBe(true);
    const config = JSON.parse(readFileSync(reportPath(repo.path, "risk-backtest"), "utf8")).config;
    const stored = readStoredBacktest(repo.path, config);
    expect(stored).toMatchObject({ head: repo.git("rev-parse", "HEAD"), separation: document.results.separation });
    // A different configuration is a different model, so its verdict is not reused.
    expect(readStoredBacktest(repo.path, "0000000000000000")).toBeNull();
  });

  test("a later commit and a later risk run do not alter the verdict that was stored", async () => {
    const stored = (await backtest()).document;
    expect(stored.results.stored).toBe(true);
    const file = reportPath(repo.path, "risk-backtest");
    const config = JSON.parse(readFileSync(file, "utf8")).config;
    const first = readStoredBacktest(repo.path, config);
    const bytes = readFileSync(file, "utf8");
    repo.commit({ message: "Tweak much later", date: dateOf(90), author: bob, changes: [{ op: "modify", path: "src/mod2/a.ts", content: body("src/mod2/a.ts", 10, 77) }] });
    try {
      const run = await runCochange(repo.path, ["risk", "--json"]);
      expect(run.code).toBe(ExitCode.Success);
      // The new commit is after what the backtest scored. The stored verdict is the same, and the run says how far behind it is.
      expect(readFileSync(file, "utf8")).toBe(bytes);
      expect(readStoredBacktest(repo.path, config)).toEqual(first);
      expect(JSON.stringify(JSON.parse(run.stdout).results.level)).toContain(first!.head.slice(0, 7));
    } finally {
      repo.git("reset", "--quiet", "--hard", "HEAD~1");
    }
  }, 60_000);

  test("a run from a date is printed and not stored", async () => {
    const { document } = await backtest("--since", "2024-07-01");
    expect(document.results.stored).toBe(false);
    expect(existsSync(reportPath(repo.path, "risk-backtest"))).toBe(false);
    expect(document.results.population.scored).toBeLessThan(40);
  });

  test("a run on a dirty tree is not stored either", async () => {
    writeFileSync(join(repo.path, "src/mod0/a.ts"), "dirty\n");
    try {
      const { document } = await backtest();
      expect(document.results.stored).toBe(false);
    } finally {
      repo.git("checkout", "--quiet", "--", "src/mod0/a.ts");
    }
  });

  test("a bad date is a usage error", async () => {
    expect((await backtest("--since", "yesterday")).code).toBe(ExitCode.Usage);
  });

  test("no author appears anywhere in the output", async () => {
    const { stdout } = await backtest();
    expect(stdout).not.toMatch(/alice|bob|example\.com/i);
  });

  test("the backtest, byte for byte", async () => {
    const { stdout } = await runCochange(repo.path, ["risk", "backtest"]);
    expectGolden("risk", "risk.backtest", stdout);
  });
});

test("dates of the scenario are a week apart", () => {
  expect(dateOf(1)).toBe("2024-01-08T09:00:00.000Z");
});
