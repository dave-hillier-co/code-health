import type { LogicalChange } from "@code-health/history/noise";

/** A logical change reduced to the packages it touched. */
export interface PackageChange {
  /** The change's id: the SHA of its first commit. */
  id: string;
  /** Committer date, unix seconds. */
  date: number;
  /** More files than the maximum changeset size: counts for frequency, not for coupling. */
  oversized: boolean;
  /** Distinct mapped author emails. */
  authors: string[];
  /** Ids of the packages the change touched, sorted. */
  touched: string[];
  /** Files of the change that lie in a package, with their package. */
  files: { path: string; package: string }[];
}

/**
 * Reduces logical changes to the packages they touched. A file is a package's when it is still in the
 * tree and a package owns it, as in the rest of the suite. Changes that touched no package are dropped.
 */
export function packageChanges(changes: readonly LogicalChange[], ownerOf: (fileId: string) => string | undefined): PackageChange[] {
  const result: PackageChange[] = [];
  for (const change of changes) {
    const files: PackageChange["files"] = [];
    const touched = new Set<string>();
    for (const file of change.files) {
      const owner = ownerOf(file.fileId);
      if (owner === undefined) continue;
      touched.add(owner);
      files.push({ path: file.fileId, package: owner });
    }
    if (touched.size === 0) continue;
    result.push({ id: change.id, date: change.committerDate, oversized: change.oversized, authors: change.authors, touched: [...touched].sort(), files });
  }
  return result;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** Co-change counted between packages, over the changes small enough to say anything about coupling. */
export interface PackageActivity {
  /** Changes that touched at least one package and are small enough to count for coupling: the population every figure is counted over. */
  eligibleChanges: number;
  /** Every change that touched the package, oversized ones included: its frequency. */
  revisions(id: string): number;
  /** Eligible changes that touched the package. */
  eligible(id: string): number;
  /** Eligible changes that touched both. */
  shared(a: string, b: string): number;
  /** Eligible changes that touched the package and no other. */
  alone(id: string): number;
  /** Eligible changes that touched at least `count` packages. */
  touchingAtLeast(count: number): number;
  /** Eligible changes that touched the package and at least one other, each counted once. */
  crossing(id: string): number;
  /** The packages that co-changed with this one, by shared eligible changes. */
  partners(id: string): ReadonlyMap<string, number>;
}

export function measurePackages(changes: readonly PackageChange[]): PackageActivity {
  const revisions = new Map<string, number>();
  const eligible = new Map<string, number>();
  const alone = new Map<string, number>();
  const shared = new Map<string, number>();
  const partners = new Map<string, Map<string, number>>();
  const widths: number[] = [];
  let eligibleChanges = 0;

  for (const change of changes) {
    for (const id of change.touched) revisions.set(id, (revisions.get(id) ?? 0) + 1);
    if (change.oversized) continue;
    eligibleChanges++;
    widths.push(change.touched.length);
    for (const id of change.touched) eligible.set(id, (eligible.get(id) ?? 0) + 1);
    if (change.touched.length === 1) alone.set(change.touched[0]!, (alone.get(change.touched[0]!) ?? 0) + 1);
    for (let i = 0; i < change.touched.length; i++) {
      for (let j = i + 1; j < change.touched.length; j++) {
        const a = change.touched[i]!;
        const b = change.touched[j]!;
        const key = pairKey(a, b);
        shared.set(key, (shared.get(key) ?? 0) + 1);
        for (const [from, to] of [[a, b], [b, a]] as const) {
          if (!partners.has(from)) partners.set(from, new Map());
          partners.get(from)!.set(to, (partners.get(from)!.get(to) ?? 0) + 1);
        }
      }
    }
  }

  const none = new Map<string, number>();
  return {
    eligibleChanges,
    revisions: (id) => revisions.get(id) ?? 0,
    eligible: (id) => eligible.get(id) ?? 0,
    shared: (a, b) => shared.get(pairKey(a, b)) ?? 0,
    alone: (id) => alone.get(id) ?? 0,
    touchingAtLeast: (count) => widths.filter((width) => width >= count).length,
    crossing: (id) => (eligible.get(id) ?? 0) - (alone.get(id) ?? 0),
    partners: (id) => partners.get(id) ?? none,
  };
}

/**
 * The upper tail of the hypergeometric distribution: the probability, if two packages changed
 * independently, of at least `shared` of the `total` changes touching both, given that one was
 * touched by `a` of them and the other by `b`. The one-sided exact test behind the suite's
 * "significantly above what independence predicts".
 */
export function independenceTail(shared: number, a: number, b: number, total: number): number {
  if (shared <= 0) return 1;
  const most = Math.min(a, b);
  if (shared > most) return 0;
  const logFactorial = new Float64Array(total + 1);
  for (let i = 2; i <= total; i++) logFactorial[i] = logFactorial[i - 1]! + Math.log(i);
  const choose = (n: number, k: number): number =>
    k < 0 || k > n ? Number.NEGATIVE_INFINITY : logFactorial[n]! - logFactorial[k]! - logFactorial[n - k]!;
  const denominator = choose(total, b);
  let tail = 0;
  for (let x = shared; x <= most; x++) {
    if (b - x > total - a) continue;
    tail += Math.exp(choose(a, x) + choose(total - a, b - x) - denominator);
  }
  return Math.min(1, tail);
}

/** Recency weights run from one half for the oldest change in the window to one for the newest. */
export function recencyWeight(date: number, windowSince: number, anchor: number): number {
  if (anchor <= windowSince) return 1;
  const age = Math.min(1, Math.max(0, (anchor - date) / (anchor - windowSince)));
  return 1 - age / 2;
}

/** Changes that crossed a boundary, counted with recency weights. */
export interface CrossingCost {
  /** Weighted eligible changes that touched both packages. */
  pair(a: string, b: string): number;
  /** Weighted eligible changes that touched the package and at least one other. */
  package(id: string): number;
  /** Weighted eligible changes that touched at least `count` packages. */
  wide(count: number): number;
}

export function crossingCost(changes: readonly PackageChange[], weightOf: (date: number) => number): CrossingCost {
  const pairs = new Map<string, number>();
  const perPackage = new Map<string, number>();
  const wide = new Map<number, number>();
  for (const change of changes) {
    if (change.oversized || change.touched.length < 2) continue;
    const weight = weightOf(change.date);
    wide.set(change.touched.length, (wide.get(change.touched.length) ?? 0) + weight);
    for (const id of change.touched) perPackage.set(id, (perPackage.get(id) ?? 0) + weight);
    for (let i = 0; i < change.touched.length; i++) {
      for (let j = i + 1; j < change.touched.length; j++) {
        const key = pairKey(change.touched[i]!, change.touched[j]!);
        pairs.set(key, (pairs.get(key) ?? 0) + weight);
      }
    }
  }
  return {
    pair: (a, b) => pairs.get(pairKey(a, b)) ?? 0,
    package: (id) => perPackage.get(id) ?? 0,
    wide: (count) => [...wide].filter(([width]) => width >= count).reduce((sum, [, weight]) => sum + weight, 0),
  };
}
