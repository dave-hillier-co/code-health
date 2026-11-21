import { compareIds } from "@code-health/graph/graph";
import { round3 } from "../stability.ts";
import { measureClosure } from "./closure.ts";
import type { Finding, Principle } from "./findings.ts";
import { consumerPackages, isPublished, isYoung, type PackageModel } from "./model.ts";
import { deployablesOf, versionChanges } from "./release.ts";
import type { ReuseAnalysis } from "./reuse-profile.ts";

/** Which of the three cohesion forces a package's situation makes matter most. */
export type Force = "closure" | "reuse" | "release" | "tentative" | "mixed";

/** Where one package sits between the three cohesion forces, and which it neglects. */
export interface Balance {
  id: string;
  matters: Force;
  /** Common closure (CCP): its closure, its share of changes, and the packages it changes with. */
  closure: { value: number | null; share: number; crossing: number; changesWith: string[] };
  /** Common reuse (CRP): its reuse profile and export components. Null where the structural layer cannot read the package. */
  reuse: { surface: number; consumers: number; medianShare: number | null; components: number; unused: number } | null;
  /** Reuse and release equivalence (REP): its consumers, deployables and version history. */
  release: { consumers: string[]; published: boolean; deployables: string[]; versionChanges: number | null; young: boolean };
  /** The principles that findings against this package are about. */
  neglected: Principle[];
  /** What the findings against it cost: changes that crossed its boundaries, weighted by recency. */
  cost: number;
  reading: string;
}

const READINGS: Record<Force, (consumers: number) => string> = {
  closure: (n) => `it changes often and ${n === 0 ? "nothing" : `only ${n} package${n === 1 ? "" : "s"}`} uses it: it pays for a boundary and gets little back, so closure matters most and merging is the default candidate`,
  reuse: (n) => `it rarely changes and ${n} packages use it: it has earned its boundary, so reuse matters most and the question is whether consumers carry parts they do not need`,
  release: () => "its releases matter most",
  tentative: () => "it is inside the grace period, so what it shows about reuse is held as tentative",
  mixed: () => "no one force dominates: it changes and is used at a middling rate",
};

export async function balances(model: PackageModel, findings: readonly Finding[], reuse: ReuseAnalysis, root: string): Promise<Balance[]> {
  const closure = measureClosure(model);
  const revisions = model.packages.map((p) => model.activity.revisions(p.id)).sort((a, b) => a - b);
  const median = revisions[Math.floor((revisions.length - 1) / 2)] ?? 0;
  const rows: Balance[] = [];
  for (const pkg of model.packages) {
    const consumers = consumerPackages(model, pkg.id);
    const changes = model.activity.revisions(pkg.id);
    const young = isYoung(model, pkg.id);
    const matters: Force = young ? "tentative" : changes > median && consumers.length <= 2 ? "closure" : consumers.length >= 3 && changes <= median ? "reuse" : "mixed";
    const mine = findings.filter((f) => f.packages.includes(pkg.id));
    const profile = reuse.profiles.get(pkg.id);
    const partners = [...model.activity.partners(pkg.id)].sort(([ia, a], [ib, b]) => b - a || compareIds(ia, ib)).slice(0, 3).map(([id]) => id);
    const figures = closure.get(pkg.id)!;
    const versions = await versionChanges(model, root, pkg);
    rows.push({
      id: pkg.id,
      matters,
      closure: { value: figures.closure, share: figures.share, crossing: figures.crossing, changesWith: partners },
      reuse: profile
        ? {
            surface: profile.surface.length,
            consumers: profile.consumers.length,
            medianShare: profile.medianShare,
            components: profile.components.length,
            unused: profile.unused.length,
          }
        : null,
      release: { consumers, published: isPublished(model, pkg), deployables: deployablesOf(model, pkg.id), versionChanges: versions === null ? null : versions.size, young },
      neglected: [...new Set(mine.map((f) => f.principle))].filter((p) => p === "CCP" || p === "CRP" || p === "REP").sort(),
      cost: round3(mine.reduce((sum, f) => sum + f.changeCost, 0)),
      reading: READINGS[matters](consumers.length),
    });
  }
  return rows.sort((a, b) => compareIds(a.id, b.id));
}
