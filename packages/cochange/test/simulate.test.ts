import { expect, test } from "vitest";
import type { Developer, FileKnowledge, KnowledgeModel } from "../src/abandonment/knowledge-model.ts";
import { distributionOf, probabilityOver, simulate, trialRng, type Selection } from "../src/abandonment/simulate.ts";

/**
 * The scenario of `knowledge-scenario.ts` as a model, so its numbers can be checked by hand:
 * Ann (0), Bob (1) and Eve (2) are active, Cy (3) and Di (4) have left.
 * 75 lines held by people, 32 by people who have left.
 */
const developers: Developer[] = [
  { key: "ann", active: true },
  { key: "bob", active: true },
  { key: "eve", active: true },
  { key: "cy", active: false },
  { key: "di", active: false },
];
const file = (path: string, ...holders: [number, number][]): FileKnowledge => ({
  path,
  people: holders.reduce((sum, [, lines]) => sum + lines, 0),
  nonPerson: 0,
  unattributed: 0,
  holders: holders.map(([dev, lines]) => ({ dev, lines })).sort((a, b) => a.dev - b.dev),
});
const model: KnowledgeModel = {
  asOf: 0,
  developers,
  missing: [],
  files: [
    file("src/api/auth.ts", [0, 10]),
    file("src/api/routes.ts", [0, 5], [1, 5]),
    file("src/core/engine.ts", [3, 10]),
    file("src/core/lexer.ts", [4, 8], [1, 2]),
    file("src/core/parser.ts", [3, 9], [0, 1]),
    file("src/gen/deps.ts", [4, 5]),
    file("src/ui/view.ts", [2, 10]),
    file("src/util/log.ts", [1, 10]),
  ],
};
const ACTIVE_LINES = 16 + 17 + 10;

const run = (selection: Selection, more: { trials?: number; seed?: number } = {}) =>
  simulate(model, { selection, trials: more.trials ?? 2000, seed: more.seed ?? 7, alphas: [95, 99], thresholdPercent: 90 });
const rate = (percent: number): Selection => ({ mode: "rate", rate: percent / 100, periods: 1 });

test("the loss of a series: mean, nearest-rank percentile, tail ratio and the mean of the tail, by hand", () => {
  const series = Array.from({ length: 100 }, (_, i) => i + 1);
  const { expected, atRisk } = distributionOf(series, [95, 99]);
  expect(expected).toBe(50.5);
  expect(atRisk[0]).toEqual({ alpha: 95, kar: 95, tailRatio: 95 / 50.5, expectedTailLoss: 97.5 });
  expect(atRisk[1]).toEqual({ alpha: 99, kar: 99, tailRatio: 99 / 50.5, expectedTailLoss: 99.5 });
});

test("the tail includes every trial tied at knowledge at risk, and nothing expected means no ratio", () => {
  expect(distributionOf([0, 0, 0, 10], [50]).atRisk[0]).toMatchObject({ kar: 0, expectedTailLoss: 2.5 });
  expect(distributionOf([0, 0, 0, 0], [95]).atRisk[0]).toMatchObject({ kar: 0, tailRatio: null, expectedTailLoss: 0 });
});

test("with probability 0 the loss is what is already abandoned, and with probability 1 everything is", () => {
  const none = run(rate(0));
  expect(none.baseline).toEqual({ files: 3, lines: 32 });
  expect(none.lines.expected).toBe(0);
  expect(none.files.atRisk[1]!.kar).toBe(0);
  expect(none.fileRisks.map((f) => f.probability)).toEqual([0, 0, 1, 0, 1, 1, 0, 0]);

  const all = run(rate(100));
  // Everyone active leaves: their 43 lines go, and so does every file not abandoned yet.
  expect(all.lines.expected).toBe(ACTIVE_LINES);
  expect(all.lines.atRisk[0]!.kar).toBe(ACTIVE_LINES);
  expect(all.files.expected).toBe(5);
  expect(all.fileRisks.map((f) => f.probability)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  expect(all.population).toEqual({ files: 8, peopleLines: 75 });
});

test("the expected loss never falls as the probability rises", () => {
  const expected = [0, 5, 10, 20, 40, 80, 100].map((percent) => run(rate(percent), { trials: 500 }).lines.expected);
  expect(expected).toEqual([...expected].sort((a, b) => a - b));
  const files = [0, 5, 10, 20, 40, 80, 100].map((percent) => run(rate(percent), { trials: 500 }).files.expected);
  expect(files).toEqual([...files].sort((a, b) => a - b));
});

test("the expected increment in lines is the active lines times the probability", () => {
  const result = run(rate(30), { trials: 10_000 });
  expect(result.meanLeaverProbability).toBeCloseTo(0.3, 12);
  expect(result.lines.expected).toBeGreaterThan(ACTIVE_LINES * 0.3 - 0.6);
  expect(result.lines.expected).toBeLessThan(ACTIVE_LINES * 0.3 + 0.6);
});

test("a rate over several periods compounds into one probability per developer", () => {
  expect(probabilityOver(0.1, 4)).toBeCloseTo(1 - 0.9 ** 4, 15);
  const result = run({ mode: "rate", rate: 0.1, periods: 4 }, { trials: 100 });
  expect(result.meanLeaverProbability).toBeCloseTo(1 - 0.9 ** 4, 12);
});

test("a file's probability is that of its holders all leaving: one holder, p, and two holders, p squared", () => {
  const result = run(rate(30), { trials: 10_000 });
  const byPath = Object.fromEntries(result.fileRisks.map((f) => [f.path, f.probability]));
  expect(byPath["src/api/auth.ts"]).toBeGreaterThan(0.27);
  expect(byPath["src/api/auth.ts"]).toBeLessThan(0.33);
  expect(byPath["src/api/routes.ts"]).toBeGreaterThan(0.06);
  expect(byPath["src/api/routes.ts"]).toBeLessThan(0.12);
  // The lexer is 80 percent gone already and is abandoned once its other holder leaves.
  expect(byPath["src/core/lexer.ts"]).toBeGreaterThan(0.27);
  expect(byPath["src/core/lexer.ts"]).toBeLessThan(0.33);
  expect(byPath["src/core/engine.ts"]).toBe(1);
});

test("the same seed gives the same result byte for byte, and another seed does not", () => {
  const a = JSON.stringify(run(rate(30), { seed: 11 }));
  expect(JSON.stringify(run(rate(30), { seed: 11 }))).toBe(a);
  expect(JSON.stringify(run(rate(30), { seed: 12 }))).not.toBe(a);
});

test("a trial's draws depend only on the seed and the trial, so a trial can be replayed alone", () => {
  const first = trialRng(5, 3);
  const again = trialRng(5, 3);
  expect([first(), first(), first()]).toEqual([again(), again(), again()]);
  expect(trialRng(5, 4)()).not.toBe(trialRng(5, 3)());
});

test("k-leavers removes exactly k active developers, sampled uniformly", () => {
  const everyone = run({ mode: "k-leavers", k: 3 }, { trials: 50 });
  expect(everyone.lines.expected).toBe(ACTIVE_LINES);
  expect(everyone.meanLeaverProbability).toBe(1);
  const one = run({ mode: "k-leavers", k: 1 }, { trials: 6000 });
  // Ann alone costs 16 lines and abandons auth; Bob 17 lines, the lexer and the log; Eve 10 lines and the view.
  expect(one.lines.expected).toBeGreaterThan(ACTIVE_LINES / 3 - 0.4);
  expect(one.lines.expected).toBeLessThan(ACTIVE_LINES / 3 + 0.4);
  expect(one.files.expected).toBeGreaterThan(4 / 3 - 0.06);
  expect(one.files.expected).toBeLessThan(4 / 3 + 0.06);
  expect(one.lines.atRisk[1]!.kar).toBe(17);
  expect(one.files.atRisk[1]!.kar).toBe(2);
  const byPath = Object.fromEntries(one.fileRisks.map((f) => [f.path, f.probability]));
  expect(byPath["src/api/routes.ts"]).toBe(0);
});

test("k-leavers refuses a k that cannot be drawn", () => {
  expect(() => run({ mode: "k-leavers", k: 4 })).toThrow(/from 1 to 3/);
  expect(() => run({ mode: "k-leavers", k: 0 })).toThrow(/from 1 to 3/);
});

test("components split the lines, and their expected losses add up to the whole", () => {
  const components = [{ name: "api", matches: (p: string) => p.startsWith("src/api/") }];
  const result = simulate(model, { selection: rate(30), trials: 3000, seed: 3, alphas: [95], thresholdPercent: 90, components });
  const byName = Object.fromEntries(result.componentRisks.map((c) => [c.name, c]));
  expect(Object.keys(byName).sort()).toEqual(["(unassigned)", "api"]);
  expect(byName.api).toMatchObject({ peopleLines: 20, baselineLines: 0 });
  expect(byName["(unassigned)"]).toMatchObject({ peopleLines: 55, baselineLines: 32 });
  const sum = result.componentRisks.reduce((s, c) => s + c.lines.expected, 0);
  expect(sum).toBeCloseTo(result.lines.expected, 9);
});

test("files abandoned in the worst trials are those that go together: tail share is a fraction of the tail", () => {
  const result = run(rate(30), { trials: 4000 });
  for (const f of result.fileRisks) {
    expect(f.tailShare).toBeGreaterThanOrEqual(0);
    expect(f.tailShare).toBeLessThanOrEqual(1);
  }
  const byPath = Object.fromEntries(result.fileRisks.map((f) => [f.path, f.tailShare]));
  // Files that are already abandoned are not part of a scenario's loss.
  expect(byPath["src/core/engine.ts"]).toBe(0);
  // A file with several holders is lost mostly in the bad scenarios: its tail share is above its probability.
  const routes = result.fileRisks.find((f) => f.path === "src/api/routes.ts")!;
  expect(routes.tailShare).toBeGreaterThan(routes.probability);
});

test("historical selection compounds sampled per-period rates", () => {
  const result = run({ mode: "historical", rates: [0, 0.5], periods: 2 }, { trials: 8000 });
  // Probabilities 0, 0.5 and 0.75 with weights 1/4, 1/2 and 1/4.
  expect(result.meanLeaverProbability).toBeGreaterThan(0.4375 - 0.015);
  expect(result.meanLeaverProbability).toBeLessThan(0.4375 + 0.015);
});

test("with one rate to sample, historical is rate", () => {
  const sampled = run({ mode: "historical", rates: [0.2], periods: 3 }, { trials: 500 });
  const fixed = run({ mode: "rate", rate: 0.2, periods: 3 }, { trials: 500 });
  expect(sampled.meanLeaverProbability).toBeCloseTo(fixed.meanLeaverProbability, 12);
});
