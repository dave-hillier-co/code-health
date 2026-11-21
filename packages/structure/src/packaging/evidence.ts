import { compareIds } from "@code-health/graph/graph";
import { pairFigures, measureClosure, type Closure, type PairFigures } from "./closure.ts";
import type { PackageAnalysis } from "./analysis.ts";
import type { Finding } from "./findings.ts";
import { packageRows, type PackageRow } from "./list.ts";
import { consumerPackages, type PackageEdge, type PackageModel } from "./model.ts";
import { balances, type Balance } from "./balance.ts";
import type { ReuseProfile } from "./reuse.ts";
import { edgeKey } from "../project.ts";
import { describeEdge, type SymbolUse } from "../modules.ts";

/** At most this many changes are listed as shared between a pair. The count travels with them. */
export const SHARED_CHANGES_SHOWN = 50;

export interface PartnerFigures extends PairFigures {
  package: string;
  /** Weighted changes that crossed between the two. */
  cost: number;
}

export interface SharedChange {
  /** The SHA of the change's first commit. */
  id: string;
  date: string;
  /** Files of the change in the packages asked about. */
  files: string[];
  /** Every package the change touched. */
  touched: string[];
}

export interface ReuseEvidence {
  entries: string[];
  wildcardExports: boolean;
  hasExportsMap: boolean;
  surface: { key: string; exportedAs: string[] }[];
  consumers: { package: string; used: string[]; share: number }[];
  components: { exports: string[]; consumers: string[] }[];
  unused: string[];
  deepUses: { from: string; to: string; package: string }[];
  passThroughShare: number;
}

export interface PackageEvidence {
  kind: "package";
  id: string;
  row: PackageRow;
  balance: Balance;
  closure: Closure;
  /** Co-change with every package it changed with, most shared changes first. */
  coChange: PartnerFigures[];
  /** The reuse profile, or null where the structural layer cannot read the package. */
  reuse: ReuseEvidence | null;
  findings: Finding[];
}

export interface PairEvidence {
  kind: "pair";
  from: string;
  to: string;
  /** Each direction of dependency, by manifest and import. Null where there is none. */
  dependencies: { fromTo: PackageEdge | null; toFrom: PackageEdge | null };
  /** Co-change with `from` as the first side: confidence is in both directions. */
  coChange: PairFigures & { cost: number };
  sharedChanges: SharedChange[];
  sharedChangesTotal: number;
  /** The symbols one uses of the other, where there is a dependency in that direction. */
  symbols: { fromTo: SymbolUse[]; toFrom: SymbolUse[] };
  /** Consumers both use, which is how the export components of each are linked. */
  commonConsumers: string[];
  findings: Finding[];
}

const reuseEvidence = (profile: ReuseProfile): ReuseEvidence => ({
  entries: [...profile.entries.files],
  wildcardExports: profile.entries.wildcard,
  hasExportsMap: profile.entries.hasExportsMap,
  surface: profile.surface.map((e) => ({ key: e.key, exportedAs: e.exportedAs })),
  consumers: profile.consumers.map((c) => ({ ...c })),
  components: profile.components.map((c) => ({ ...c })),
  unused: profile.unused,
  deepUses: profile.deepUses,
  passThroughShare: profile.passThroughShare,
});

export async function packageEvidence(model: PackageModel, analysis: PackageAnalysis, id: string, root: string): Promise<PackageEvidence> {
  const closure = measureClosure(model).get(id)!;
  const partners: PartnerFigures[] = [...model.activity.partners(id)]
    .sort(([ia, a], [ib, b]) => b - a || compareIds(ia, ib))
    .map(([other]) => ({ package: other, ...pairFigures(model, id, other), cost: analysis.context.cost.pair(id, other) }));
  const profile = analysis.reuse.profiles.get(id);
  const balance = (await balances(model, analysis.all, analysis.reuse, root)).find((row) => row.id === id)!;
  return {
    kind: "package",
    id,
    row: packageRows(model).find((row) => row.id === id)!,
    balance,
    closure,
    coChange: partners,
    reuse: profile === undefined ? null : reuseEvidence(profile),
    findings: analysis.all.filter((f) => f.packages.includes(id)),
  };
}

export function pairEvidence(model: PackageModel, analysis: PackageAnalysis, from: string, to: string): PairEvidence {
  const shared = model.changes.filter((c) => !c.oversized && c.touched.includes(from) && c.touched.includes(to));
  const symbols = (a: string, b: string): SymbolUse[] => {
    if ((model.edges.get(edgeKey(a, b))?.productionImports ?? 0) === 0) return [];
    return describeEdge(model.project, model.model.graph, a, b).symbols;
  };
  const consumersOf = (id: string) => new Set(consumerPackages(model, id));
  const other = consumersOf(to);
  return {
    kind: "pair",
    from,
    to,
    dependencies: { fromTo: model.edges.get(edgeKey(from, to)) ?? null, toFrom: model.edges.get(edgeKey(to, from)) ?? null },
    coChange: { ...pairFigures(model, from, to), cost: analysis.context.cost.pair(from, to) },
    sharedChanges: [...shared]
      .sort((a, b) => b.date - a.date || compareIds(a.id, b.id))
      .slice(0, SHARED_CHANGES_SHOWN)
      .map((c) => ({
        id: c.id,
        date: new Date(c.date * 1000).toISOString(),
        files: c.files.filter((f) => f.package === from || f.package === to).map((f) => f.path).sort(compareIds),
        touched: c.touched,
      })),
    sharedChangesTotal: shared.length,
    symbols: { fromTo: symbols(from, to), toFrom: symbols(to, from) },
    commonConsumers: [...consumersOf(from)].filter((c) => other.has(c)).sort(compareIds),
    findings: analysis.all.filter((f) => f.packages.includes(from) && f.packages.includes(to)),
  };
}
