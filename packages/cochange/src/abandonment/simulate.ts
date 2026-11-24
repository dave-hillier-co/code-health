import { componentOf as componentNameOf, type ComponentMatcher } from "../components.ts";
import { goneLinesOf, reachesGuideline, type KnowledgeModel } from "./knowledge-model.ts";

/**
 * Monte Carlo simulation of turnover over a knowledge model.
 *
 * Everything is deterministic. Every trial draws from its own generator, seeded from the
 * run's seed and the trial's number, so the same model, selection and seed give the same
 * numbers, and a trial can be replayed by itself. The simulation samples departures at
 * random. It never models or ranks a person's likelihood of leaving.
 */

export type Selection =
  /** Each active developer leaves independently with probability `1 - (1 - q)^h` for a per-period rate q over h periods. */
  | { mode: "rate"; rate: number; periods: number }
  /** Sample `periods` of the repository's own per-period rates with replacement, compound them into a probability, then apply it as in `rate`. */
  | { mode: "historical"; rates: readonly number[]; periods: number }
  /** Exactly `k` active developers, chosen uniformly. */
  | { mode: "k-leavers"; k: number };

export interface SimulationOptions {
  selection: Selection;
  trials: number;
  seed: number;
  /** Percentiles, ascending, for knowledge at risk. */
  alphas: readonly number[];
  /** Percentage of a file's lines held by people who have left at which it is abandoned. */
  guidelinePercent: number;
  components?: readonly ComponentMatcher[];
}

/** The loss in one measure across trials. */
export interface Distribution {
  /** Mean over trials. */
  expected: number;
  /** One entry per alpha. */
  atRisk: {
    alpha: number;
    /** Knowledge at risk: the alpha percentile of the loss, by nearest rank. */
    kar: number;
    /** kar / expected, or null when nothing is expected to be lost. */
    tailRatio: number | null;
    /** The mean of the losses at or beyond kar. */
    expectedTailLoss: number;
  }[];
}

export interface FileRisk {
  path: string;
  /** Fraction of trials in which the file ends up abandoned. 1 for a file already abandoned. */
  probability: number;
  /** Fraction of the tail trials (see `tailAlpha`) in which the file is abandoned, counting only files that were not already. */
  tailShare: number;
}

export interface ComponentRisk {
  name: string;
  /** Lines the component holds for people, and the part of them already abandoned. */
  peopleLines: number;
  baselineLines: number;
  /** Increment in abandoned lines across trials. */
  lines: Distribution;
}

export interface SimulationResult {
  trials: number;
  seed: number;
  activeDevelopers: number;
  /** The mean probability that an active developer leaves over the horizon, across trials. */
  meanLeaverProbability: number;
  population: { files: number; peopleLines: number };
  /** Already abandoned before any trial: the part of the loss that cannot be prevented any more. */
  baseline: { files: number; lines: number };
  /** The increment over the baseline. */
  files: Distribution;
  lines: Distribution;
  /** The percentile that defines the tail trials for `FileRisk.tailShare`. */
  tailAlpha: number;
  fileRisks: FileRisk[];
  componentRisks: ComponentRisk[];
}

/** mulberry32: a small generator with a 32-bit state. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The generator of one trial: a hash of the seed and the trial number. */
export function trialRng(seed: number, trial: number): () => number {
  let h = (seed ^ Math.imul(trial + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return mulberry32(h >>> 0);
}

/** Probability that someone leaves over `periods` periods when `rate` of the team leaves in each. */
export const probabilityOver = (rate: number, periods: number): number => 1 - Math.pow(1 - rate, periods);

/**
 * The loss distribution of a series: mean, and for each alpha the nearest-rank percentile
 * (the smallest value with at least alpha percent of the trials at or below it), the tail ratio
 * and the mean of the losses at or beyond it.
 */
export function distributionOf(values: ArrayLike<number>, alphas: readonly number[]): Distribution {
  const n = values.length;
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const v of sorted) sum += v;
  const expected = sum / n;
  return {
    expected,
    atRisk: alphas.map((alpha) => {
      const rank = Math.min(n, Math.max(1, Math.ceil((alpha * n) / 100 - 1e-9)));
      const kar = sorted[rank - 1]!;
      let first = rank - 1;
      while (first > 0 && sorted[first - 1]! >= kar) first--;
      let tail = 0;
      for (let i = first; i < n; i++) tail += sorted[i]!;
      return { alpha, kar, tailRatio: expected === 0 ? null : kar / expected, expectedTailLoss: tail / (n - first) };
    }),
  };
}

interface RelevantFile {
  /** Index into the model's files. */
  file: number;
  people: number;
  /** Lines of people who have left already. */
  baseGone: number;
  /** Active holders, by pool index. */
  holders: { pool: number; lines: number }[];
}

interface Compiled {
  /** Developers who can leave: those active at the model's date. */
  poolSize: number;
  /** Lines each pool member holds in all files. */
  poolLines: number[];
  /** Per pool member, lines held in each component. */
  poolComponentLines: [number, number][][];
  /** Files that are not abandoned yet and have an active holder: the only ones a trial can change. */
  relevant: RelevantFile[];
  baseline: { files: number; lines: number; abandonedFiles: Set<number> };
  componentNames: string[];
  componentOfFile: number[];
  componentPeopleLines: number[];
  componentBaselineLines: number[];
}

function compile(model: KnowledgeModel, guidelinePercent: number, components: readonly ComponentMatcher[]): Compiled {
  const pool: number[] = [];
  const poolIndex = new Map<number, number>();
  model.developers.forEach((d, i) => {
    if (d.active) {
      poolIndex.set(i, pool.length);
      pool.push(i);
    }
  });
  const names = [...new Set(model.files.map((f) => componentNameOf(components, f.path)))].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const componentIndex = new Map(names.map((n, i) => [n, i]));
  const componentOfFile = model.files.map((f) => componentIndex.get(componentNameOf(components, f.path))!);
  const poolLines = pool.map(() => 0);
  const byComponent = pool.map(() => new Map<number, number>());
  const componentPeopleLines = names.map(() => 0);
  const componentBaselineLines = names.map(() => 0);
  const relevant: RelevantFile[] = [];
  const abandonedFiles = new Set<number>();
  let baselineLines = 0;

  model.files.forEach((file, fi) => {
    const c = componentOfFile[fi]!;
    const baseGone = goneLinesOf(file, model.developers);
    componentPeopleLines[c]! += file.people;
    componentBaselineLines[c]! += baseGone;
    baselineLines += baseGone;
    const holders: { pool: number; lines: number }[] = [];
    for (const h of file.holders) {
      const p = poolIndex.get(h.dev);
      if (p === undefined) continue;
      holders.push({ pool: p, lines: h.lines });
      poolLines[p]! += h.lines;
      byComponent[p]!.set(c, (byComponent[p]!.get(c) ?? 0) + h.lines);
    }
    if (reachesGuideline(baseGone, file.people, guidelinePercent)) abandonedFiles.add(fi);
    else if (holders.length > 0) relevant.push({ file: fi, people: file.people, baseGone, holders });
  });
  return {
    poolSize: pool.length,
    poolLines,
    poolComponentLines: byComponent.map((m) => [...m]),
    relevant,
    baseline: { files: abandonedFiles.size, lines: baselineLines, abandonedFiles },
    componentNames: names,
    componentOfFile,
    componentPeopleLines,
    componentBaselineLines,
  };
}

/** Who leaves in one trial, and the probability that applied to each active developer (k-leavers: k over the pool). */
function draw(selection: Selection, poolSize: number, rng: () => number, leave: Uint8Array): number {
  leave.fill(0);
  if (selection.mode === "k-leavers") {
    const order = Uint32Array.from({ length: poolSize }, (_, i) => i);
    for (let j = 0; j < selection.k; j++) {
      const pick = j + Math.floor(rng() * (poolSize - j));
      const swap = order[pick]!;
      order[pick] = order[j]!;
      order[j] = swap;
      leave[swap] = 1;
    }
    return poolSize === 0 ? 0 : selection.k / poolSize;
  }
  let probability: number;
  if (selection.mode === "rate") probability = probabilityOver(selection.rate, selection.periods);
  else {
    let stay = 1;
    for (let i = 0; i < selection.periods; i++) stay *= 1 - selection.rates[Math.floor(rng() * selection.rates.length)]!;
    probability = 1 - stay;
  }
  // One draw per developer whatever the probability, so a larger probability only ever adds leavers.
  for (let i = 0; i < poolSize; i++) if (rng() < probability) leave[i] = 1;
  return probability;
}

export function simulate(model: KnowledgeModel, options: SimulationOptions): SimulationResult {
  const { selection, trials, seed, alphas, guidelinePercent } = options;
  const compiled = compile(model, guidelinePercent, options.components ?? []);
  const { poolSize, relevant } = compiled;
  if (selection.mode === "k-leavers" && (selection.k < 1 || selection.k > poolSize)) {
    throw new RangeError(`k must be from 1 to ${poolSize}, the active developers`);
  }

  const leave = new Uint8Array(poolSize);
  const incrementLines = new Float64Array(trials);
  const incrementFiles = new Float64Array(trials);
  const componentLines = compiled.componentNames.map(() => new Float64Array(trials));
  const fileHits = new Uint32Array(relevant.length);
  let probabilitySum = 0;

  /** Visits each relevant file the leavers abandon. */
  const abandoned = (visit: (r: number) => void): void => {
    relevant.forEach((rel, r) => {
      let gone = rel.baseGone;
      for (const h of rel.holders) if (leave[h.pool]) gone += h.lines;
      if (gone > rel.baseGone && reachesGuideline(gone, rel.people, guidelinePercent)) visit(r);
    });
  };

  for (let t = 0; t < trials; t++) {
    probabilitySum += draw(selection, poolSize, trialRng(seed, t), leave);
    let lines = 0;
    for (let p = 0; p < poolSize; p++) {
      if (!leave[p]) continue;
      lines += compiled.poolLines[p]!;
      for (const [c, l] of compiled.poolComponentLines[p]!) componentLines[c]![t]! += l;
    }
    incrementLines[t] = lines;
    let files = 0;
    abandoned((r) => {
      files++;
      fileHits[r]!++;
    });
    incrementFiles[t] = files;
  }

  const filesDistribution = distributionOf(incrementFiles, alphas);
  const linesDistribution = distributionOf(incrementLines, alphas);

  // The tail trials are those at or beyond knowledge at risk, in files, at the lowest alpha. They are
  // replayed to see which files the bad scenarios lose.
  const tailAlpha = alphas[0]!;
  const tailGuideline = filesDistribution.atRisk[0]!.kar;
  const tailHits = new Uint32Array(relevant.length);
  let tailTrials = 0;
  for (let t = 0; t < trials; t++) {
    if (incrementFiles[t]! < tailGuideline) continue;
    tailTrials++;
    draw(selection, poolSize, trialRng(seed, t), leave);
    abandoned((r) => tailHits[r]!++);
  }

  const relevantOf = new Map(relevant.map((rel, r) => [rel.file, r]));
  const fileRisks = model.files.map((file, fi): FileRisk => {
    if (compiled.baseline.abandonedFiles.has(fi)) return { path: file.path, probability: 1, tailShare: 0 };
    const r = relevantOf.get(fi);
    return r === undefined
      ? { path: file.path, probability: 0, tailShare: 0 }
      : { path: file.path, probability: fileHits[r]! / trials, tailShare: tailTrials === 0 ? 0 : tailHits[r]! / tailTrials };
  });

  return {
    trials,
    seed,
    activeDevelopers: poolSize,
    meanLeaverProbability: probabilitySum / trials,
    population: { files: model.files.length, peopleLines: model.files.reduce((sum, f) => sum + f.people, 0) },
    baseline: { files: compiled.baseline.files, lines: compiled.baseline.lines },
    files: filesDistribution,
    lines: linesDistribution,
    tailAlpha,
    fileRisks,
    componentRisks: compiled.componentNames.map((name, c) => ({
      name,
      peopleLines: compiled.componentPeopleLines[c]!,
      baselineLines: compiled.componentBaselineLines[c]!,
      lines: distributionOf(componentLines[c]!, alphas),
    })),
  };
}
