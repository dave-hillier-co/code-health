import { compareIds } from "@code-health/graph/graph";
import { edgeKey } from "../project.ts";
import { round3 } from "../stability.ts";
import { readEntries, type PackageEntries } from "./entries.ts";
import { consumerPackages, type PackageModel } from "./model.ts";

/** One thing a package lets others use: an exported name, followed to where it is defined. */
export interface SurfaceElement {
  /** `file#name` of the definition, the name its defining file exports it under. */
  key: string;
  file: string;
  name: string;
  /** Qualified name of the defining function or class, when it is one. */
  symbol: string | null;
  /** The names the package's entry files export it under. */
  exportedAs: string[];
}

export interface ConsumerUse {
  package: string;
  /** Surface elements it references. */
  used: string[];
  /** Share of the surface it uses. */
  share: number;
}

/** Exports that belong together: used by the same consumers, or referring to each other. */
export interface ExportComponent {
  exports: string[];
  /** Packages using any of them. */
  consumers: string[];
}

export interface ReuseProfile {
  package: string;
  entries: PackageEntries;
  surface: SurfaceElement[];
  consumers: ConsumerUse[];
  /** The middle consumer's share of the surface. Null with no consumer. */
  medianShare: number | null;
  /** Surface elements no other package uses. */
  unused: string[];
  components: ExportComponent[];
  /** Share of the surface that is defined in another package and only passed along. */
  passThroughShare: number;
  /** Uses of the package's files that are not on its surface: past its entry points. */
  deepUses: { from: string; to: string; package: string }[];
}

export interface ReuseAnalysis {
  /** The packages the structural layer could read, with their profiles. */
  profiles: ReadonlyMap<string, ReuseProfile>;
  /** The packages it could not: no adapter for their language, or no code. */
  unavailable: { package: string; reason: string }[];
}

const medianOf = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
};

class UnionFind {
  private readonly parent = new Map<string, string>();
  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }
  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(id, root);
    return root;
  }
  union(a: string, b: string): void {
    const [x, y] = [this.find(a), this.find(b)];
    if (x !== y) this.parent.set(compareIds(x, y) < 0 ? y : x, compareIds(x, y) < 0 ? x : y);
  }
}

export async function analyseReuse(model: PackageModel): Promise<ReuseAnalysis> {
  const entries = await readEntries(model);
  const unavailable: ReuseAnalysis["unavailable"] = [];
  const surfaces = new Map<string, Map<string, SurfaceElement>>();

  for (const pkg of model.packages) {
    const own = entries.get(pkg.id);
    if (!own) {
      unavailable.push({
        package: pkg.id,
        reason: (model.codeFiles.get(pkg.id)?.length ?? 0) === 0 ? "no TypeScript or JavaScript for the structural layer to read" : `no adapter for ${pkg.ecosystem} packages`,
      });
      continue;
    }
    surfaces.set(pkg.id, new Map());
  }

  for (const exported of model.project.analysis.exports) {
    const owner = model.index.owner(exported.file);
    if (owner === undefined || !entries.get(owner)?.files.has(exported.file)) continue;
    const key = `${exported.defined.file}#${exported.defined.name}`;
    const surface = surfaces.get(owner)!;
    const element = surface.get(key) ?? { key, file: exported.defined.file, name: exported.defined.name, symbol: exported.defined.symbol ?? null, exportedAs: [] };
    if (!element.exportedAs.includes(exported.name)) element.exportedAs.push(exported.name);
    surface.set(key, element);
  }

  // what each other package references of each package
  const used = new Map<string, Map<string, Set<string>>>();
  const deepUses = new Map<string, ReuseProfile["deepUses"]>();
  const internalLinks = new Map<string, [string, string][]>();
  for (const consumer of model.project.analysis.consumers) {
    if (consumer.kind === "test") continue;
    const from = model.index.owner(consumer.from);
    const to = model.index.owner(consumer.to);
    if (from === undefined || to === undefined) continue;
    const surface = surfaces.get(to);
    if (from !== to) {
      // A use is attributed to every package the user imports whose surface holds what is used, so a
      // package that only re-exports another's names is credited with the use it passes along.
      const keys = consumer.toExport === "*" ? model.project.analysis.exports.filter((e) => e.defined.file === consumer.to).map((e) => `${e.defined.file}#${e.defined.name}`) : [`${consumer.to}#${consumer.toExport}`];
      let attributed = false;
      for (const [reached, reachedSurface] of surfaces) {
        if (reached === from || (model.edges.get(edgeKey(from, reached))?.productionImports ?? 0) === 0) continue;
        const hits = keys.filter((key) => reachedSurface.has(key));
        if (hits.length === 0) continue;
        attributed = true;
        if (!used.has(reached)) used.set(reached, new Map());
        const usedOfReached: Map<string, Set<string>> = used.get(reached)!;
        if (!usedOfReached.has(from)) usedOfReached.set(from, new Set());
        for (const key of hits) usedOfReached.get(from)!.add(key);
      }
      if (!attributed && surface && (model.edges.get(edgeKey(from, to))?.productionImports ?? 0) > 0) {
        if (!deepUses.has(to)) deepUses.set(to, []);
        deepUses.get(to)!.push({ from: consumer.from, to: consumer.to, package: from });
      }
      continue;
    }
    if (!surface) continue;
    if (from === to) {
      if (consumer.fromUnit === undefined) continue;
      const topUnit = consumer.fromUnit.split(".")[0];
      const source = [...surface.values()].find((e) => e.file === consumer.from && e.symbol === topUnit);
      const target = [...surface.values()].find((e) => e.file === consumer.to && (e.symbol ?? e.name) === (consumer.toSymbol ?? consumer.toExport));
      if (source && target && source !== target) {
        if (!internalLinks.has(to)) internalLinks.set(to, []);
        internalLinks.get(to)!.push([source.key, target.key]);
      }
    }
  }

  // a package that re-exports names of another uses them, whether or not anything in it calls them
  for (const [reexporter, surface] of surfaces) {
    for (const [source, sourceSurface] of surfaces) {
      if (reexporter === source || (model.edges.get(edgeKey(reexporter, source))?.productionImports ?? 0) === 0) continue;
      const passed = [...surface.keys()].filter((key) => sourceSurface.has(key));
      if (passed.length === 0) continue;
      if (!used.has(source)) used.set(source, new Map());
      const usedOfSource: Map<string, Set<string>> = used.get(source)!;
      if (!usedOfSource.has(reexporter)) usedOfSource.set(reexporter, new Set());
      for (const key of passed) usedOfSource.get(reexporter)!.add(key);
    }
  }

  const profiles = new Map<string, ReuseProfile>();
  for (const [id, surfaceMap] of surfaces) {
    const surface = [...surfaceMap.values()].sort((a, b) => compareIds(a.key, b.key));
    const byConsumer = used.get(id) ?? new Map<string, Set<string>>();
    const consumerIds = new Set([...consumerPackages(model, id), ...byConsumer.keys()]);
    const consumers = [...consumerIds].sort(compareIds).map((consumer): ConsumerUse => {
      const keys = [...(byConsumer.get(consumer) ?? [])].sort(compareIds);
      return { package: consumer, used: keys, share: surface.length === 0 ? 0 : round3(keys.length / surface.length) };
    });
    const everyUsed = new Set(consumers.flatMap((c) => c.used));

    const sets = new UnionFind();
    for (const element of surface) sets.add(element.key);
    for (const consumer of consumers) for (const key of consumer.used.slice(1)) sets.union(consumer.used[0]!, key);
    for (const [a, b] of internalLinks.get(id) ?? []) sets.union(a, b);
    const grouped = new Map<string, string[]>();
    for (const element of surface) {
      const root = sets.find(element.key);
      if (!grouped.has(root)) grouped.set(root, []);
      grouped.get(root)!.push(element.key);
    }
    const components = [...grouped.values()]
      .map((keys): ExportComponent => ({
        exports: keys.sort(compareIds),
        consumers: consumers.filter((c) => c.used.some((key) => keys.includes(key))).map((c) => c.package),
      }))
      .sort((a, b) => compareIds(a.exports[0]!, b.exports[0]!));

    const passedAlong = surface.filter((element) => model.index.owner(element.file) !== id).length;
    profiles.set(id, {
      package: id,
      entries: entries.get(id)!,
      surface,
      consumers,
      medianShare: medianOf(consumers.map((c) => c.share)),
      unused: surface.filter((e) => !everyUsed.has(e.key)).map((e) => e.key),
      components,
      passThroughShare: surface.length === 0 ? 0 : round3(passedAlong / surface.length),
      deepUses: (deepUses.get(id) ?? []).sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to)),
    });
  }
  return { profiles, unavailable };
}
