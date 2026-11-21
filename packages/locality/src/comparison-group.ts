import { footprintOf, type BaselineCandidate } from "./baseline-store.ts";

export interface Pairing {
  actedOn: { path: string; rank: number };
  /** The candidate of nearest rank that was left alone, or null when none was left to pair. */
  comparison: { path: string; rank: number } | null;
}

export interface ComparisonGroup {
  group: BaselineCandidate[];
  pairs: Pairing[];
  /** Candidates left alone that shared a file with something acted on, so they cannot stand for the untouched. */
  overlapping: number;
}

/**
 * Findings are acted on because they are extreme, and extreme values drift back towards the average when left
 * alone. The comparison group is therefore drawn from the candidates of the same baseline ranking that were not
 * acted on, one for each that was, the nearest in rank first. Ties go to the better rank, and a candidate is used
 * once. A candidate whose neighbourhood shares a file with anything acted on is passed over: its changes and reads
 * are partly the acted-on ones.
 */
export function chooseComparison(candidates: readonly BaselineCandidate[], actedOn: readonly BaselineCandidate[]): ComparisonGroup {
  const acted = new Set(actedOn.map((candidate) => candidate.path));
  const touched = new Set(actedOn.flatMap(footprintOf));
  const left = candidates.filter((candidate) => !acted.has(candidate.path));
  const pool = left.filter((candidate) => !footprintOf(candidate).some((file) => touched.has(file)));
  const available = [...pool];
  const group: BaselineCandidate[] = [];
  const pairs: Pairing[] = [];
  for (const target of [...actedOn].sort((a, b) => a.rank - b.rank)) {
    let best = -1;
    for (const [index, candidate] of available.entries()) {
      if (best === -1) {
        best = index;
        continue;
      }
      const nearer = Math.abs(candidate.rank - target.rank) - Math.abs(available[best]!.rank - target.rank);
      if (nearer < 0 || (nearer === 0 && candidate.rank < available[best]!.rank)) best = index;
    }
    if (best === -1) {
      pairs.push({ actedOn: { path: target.path, rank: target.rank }, comparison: null });
      continue;
    }
    const [chosen] = available.splice(best, 1) as [BaselineCandidate];
    group.push(chosen);
    pairs.push({ actedOn: { path: target.path, rank: target.rank }, comparison: { path: chosen.path, rank: chosen.rank } });
  }
  return { group, pairs, overlapping: left.length - pool.length };
}
