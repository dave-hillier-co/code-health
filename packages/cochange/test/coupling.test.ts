import { expect, test } from "vitest";
import { compareBytes, confidenceOf, countCoupling, degreeOf, partnersOf, type CouplingChange, type PairCount } from "../src/coupling.ts";

/** Deterministic pseudo random numbers, so a failing history can be regenerated from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(seed: number): { changes: CouplingChange[]; universe: string[] } {
  const next = random(seed);
  const universe = Array.from({ length: 4 + Math.floor(next() * 10) }, (_, i) => `d${i % 4}/e${i % 3}/f${i}.ts`);
  const changes = Array.from({ length: Math.floor(next() * 60) }, () => {
    const size = 1 + Math.floor(next() * 6);
    // Sampling with replacement also produces duplicates within a change.
    const files = Array.from({ length: size }, () => universe[Math.floor(next() * universe.length)]!);
    return { files, oversized: next() < 0.15 };
  });
  return { changes, universe };
}

/** The definition, applied literally to every pair of files with no shared state between pairs. */
function naive(changes: CouplingChange[], universe: string[], minSupport: number, minDegree: number): PairCount[] {
  const eligible = changes.filter((c) => !c.oversized).map((c) => new Set(c.files));
  const touching = (...paths: string[]) => eligible.filter((set) => paths.every((p) => set.has(p))).length;
  const found: PairCount[] = [];
  for (const x of universe) {
    for (const y of universe) {
      if (compareBytes(x, y) >= 0) continue;
      const support = touching(x, y);
      const changesA = touching(x);
      const changesB = touching(y);
      if (support === 0) continue;
      // degree as a fraction: support / ((nA + nB) / 2) >= minDegree / 100
      const degreeReached = support / ((changesA + changesB) / 2) >= minDegree / 100 - 1e-12;
      if (support >= minSupport && degreeReached) found.push({ a: x, b: y, support, changesA, changesB });
    }
  }
  return found.sort((p, q) => compareBytes(p.a, q.a) || compareBytes(p.b, q.b));
}

test("pair counts match the literal definition on 300 generated histories", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const { changes, universe } = generate(seed);
    const minSupport = 1 + (seed % 4);
    const minDegree = [0, 10, 25, 50, 75][seed % 5]!;
    const counts = countCoupling(changes, { minSupport, minDegree });
    expect(counts.pairs, `seed ${seed}`).toEqual(naive(changes, universe, minSupport, minDegree));
    expect(counts.oversizedChanges, `seed ${seed}`).toBe(changes.filter((c) => c.oversized).length);
    expect(counts.eligibleChanges, `seed ${seed}`).toBe(changes.filter((c) => !c.oversized).length);
  }
});

test("partnersOf agrees with the counts of every pair that includes the file, on 300 generated histories", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const { changes, universe } = generate(seed);
    const all = countCoupling(changes, { minSupport: 1, minDegree: 0 });
    for (const focus of universe) {
      const expected = all.pairs
        .filter((pair) => pair.a === focus || pair.b === focus)
        .map((pair) =>
          pair.a === focus
            ? { path: pair.b, support: pair.support, changesFocus: pair.changesA, changesPartner: pair.changesB }
            : { path: pair.a, support: pair.support, changesFocus: pair.changesB, changesPartner: pair.changesA },
        )
        .sort((x, y) => compareBytes(x.path, y.path));
      const found = partnersOf(changes, focus);
      expect(found.partners, `seed ${seed} ${focus}`).toEqual(expected);
      expect(found.changesFocus, `seed ${seed} ${focus}`).toBe(
        changes.filter((c) => !c.oversized && c.files.includes(focus)).length,
      );
    }
  }
});

test("partnersOf reports zero changes for a file nothing touched", () => {
  expect(partnersOf([{ files: ["a.ts", "b.ts"], oversized: false }], "c.ts")).toEqual({ changesFocus: 0, partners: [] });
});

test("degree and confidence follow the spec formulas", () => {
  const pair = { a: "a", b: "b", support: 6, changesA: 6, changesB: 18 };
  expect(degreeOf(pair)).toBe(50);
  expect(confidenceOf(pair.support, pair.changesA)).toBe(100);
  expect(confidenceOf(pair.support, pair.changesB)).toBeCloseTo(33.333, 3);
});

test("an oversized change counts on neither side of the ratio", () => {
  const small = (files: string[]): CouplingChange => ({ files, oversized: false });
  const history = [small(["a", "b"]), small(["a", "b"]), { files: ["a", "b", "c"], oversized: true }];
  const [pair] = countCoupling(history, { minSupport: 1, minDegree: 0 }).pairs;
  expect(pair).toEqual({ a: "a", b: "b", support: 2, changesA: 2, changesB: 2 });
});

test("a pair exactly at the degree threshold is kept", () => {
  const history = [
    { files: ["a", "b"], oversized: false },
    { files: ["c", "d"], oversized: false },
  ];
  expect(countCoupling(history, { minSupport: 1, minDegree: 100 }).pairs).toHaveLength(2);
});

test("pairs sort in UTF-8 byte order, with the smaller path first", () => {
  const history = [{ files: ["b", "\u{1F600}", "～"], oversized: false }];
  const { pairs } = countCoupling(history, { minSupport: 1, minDegree: 0 });
  expect(pairs.map((p) => [p.a, p.b])).toEqual([
    ["b", "～"],
    ["b", "\u{1F600}"],
    ["～", "\u{1F600}"],
  ]);
});
