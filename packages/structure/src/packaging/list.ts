import { compareIds } from "@code-health/graph/graph";
import { measureClosure } from "./closure.ts";
import { consumerPackages, isPublished, isYoung, purposeOf, type PackageModel } from "./model.ts";
import type { Purpose } from "./settings.ts";

export interface PackageRow {
  id: string;
  name: string;
  ecosystem: string;
  kind: "internal" | "published";
  purpose: Purpose | null;
  /** An application or tool, which nothing is expected to depend on. */
  entry: boolean;
  testSupport: boolean;
  /** Files the package owns. */
  files: number;
  /** Packages that really use it. */
  consumers: string[];
  /** Packages it depends on, by manifest or import. */
  dependencies: string[];
  ca: number;
  ce: number;
  instability: number | null;
  /** Share of exported types that are abstract. Null where the structural layer has no adapter. */
  abstractness: number | null;
  /** `|A + I - 1|`. Null when `A` or `I` is. */
  distance: number | null;
  /** Share of its changes that touched no other package. Null with no changes in the window. */
  closure: number | null;
  /** Its share of all changes in the window. Closure is judged against packages of a comparable share. */
  share: number;
  /** Changes that touched it and another package. */
  crossing: number;
  /** Changes to it in the window. */
  revisions: number;
  /** The day it first appeared in the history, ISO date. */
  firstSeen: string | null;
  /** Inside the grace period, so its findings are tentative. */
  young: boolean;
}

export function packageRows(model: PackageModel, abstractness: ReadonlyMap<string, number | null> = new Map()): PackageRow[] {
  const closure = measureClosure(model);
  return model.packages
    .map((pkg): PackageRow => {
      const structural = model.model.structural.get(pkg.id)!;
      const figures = closure.get(pkg.id)!;
      const first = model.firstSeen.get(pkg.id);
      const a = abstractness.get(pkg.id) ?? null;
      return {
        id: pkg.id,
        name: pkg.name,
        ecosystem: pkg.ecosystem,
        kind: isPublished(model, pkg) ? "published" : "internal",
        purpose: purposeOf(model, pkg),
        entry: pkg.entry,
        testSupport: pkg.testSupport,
        files: model.files.get(pkg.id)?.length ?? 0,
        consumers: consumerPackages(model, pkg.id),
        dependencies: [...(model.model.graph.graph.get(pkg.id) ?? [])].sort(compareIds),
        ca: structural.ca,
        ce: structural.ce,
        instability: structural.instability,
        abstractness: a,
        distance: a === null || structural.instability === null ? null : Math.round(Math.abs(a + structural.instability - 1) * 1000) / 1000,
        closure: figures.closure,
        share: figures.share,
        crossing: figures.crossing,
        revisions: model.activity.revisions(pkg.id),
        firstSeen: first === undefined ? null : new Date(first * 1000).toISOString().slice(0, 10),
        young: isYoung(model, pkg.id),
      };
    })
    .sort((a, b) => compareIds(a.id, b.id));
}
