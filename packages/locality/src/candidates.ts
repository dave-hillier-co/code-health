import { compareIds } from "@code-health/graph/graph";
import { depthOf, folderDistance, folderOf, treeDistance } from "@code-health/graph/tree-distance";
import type { Consumer, SourceUnit } from "@code-health/parse/analyse-tree";
import { compileGlobs } from "@code-health/history/glob";
import { fileCohesion, type ExportComponent, type FileCohesion } from "./cohesion.ts";
import type { LocalitySettings } from "./config.ts";
import { bestTarget, type BoundaryEdge } from "./footprint.ts";
import type { Edge, Model, RawUnit } from "./model.ts";
import { countLines, unitText, type Project } from "./project.ts";
import { recommend, type Decision, type RecommendInput } from "./recommend.ts";
import { flagParameters, isPassThrough, vagueSegment } from "./signals.ts";

export interface PathCount {
  path: string;
  count: number;
}

export interface Signal {
  name: "barrel" | "overexposure" | "pass-through" | "special-general-mixture" | "vague-name";
  detail: string;
}

export interface Blocker {
  path: string;
  /** A stray is a dependency inside the unit's own neighbourhood that stays behind. */
  kind: "dependency" | "stray";
  /** References from the unit to the blocker. */
  weight: number;
  /** Distinct production files outside the unit that also use the blocker. */
  otherConsumers: number;
  coChange: null;
  /** The unit's gain if every edge to this blocker were resolved. */
  unblockedGain: number;
}

export interface ScoredComponent extends ExportComponent {
  location: string;
  target: string;
  distance: number;
  gain: number;
  fanIn: number;
  lines: number;
  recommendation: Decision["recommendation"];
  rule: string;
}

export interface Candidate {
  path: string;
  score: number;
  recommendation: Decision["recommendation"];
  rule: string;
  source: "structural";
  unit: { kind: RawUnit["kind"] | "barrel"; root: string; entries: string[]; files: string[]; tests: string[]; cycle: boolean };
  location: string;
  target: string;
  distance: number;
  gain: number;
  unblockedGain: number;
  netDistance: { current: number; atTarget: number };
  directCalls: PathCount[];
  otherRefs: PathCount[];
  testRefs: { owned: string[]; external: string[] };
  fanIn: number;
  size: { lines: number; files: number; units: number };
  ownDeps: string[];
  visibility: "exported" | "package-entry";
  age: null;
  lastChanged: null;
  churn: null;
  coChange: null;
  signals: Signal[];
  strays: string[];
  blockers: Blocker[];
  cohesion?: { components: Array<ExportComponent | ScoredComponent>; mixed: boolean };
}

export interface AnalysisSummary {
  files: number;
  units: number;
  byRecommendation: Record<string, number>;
}

export interface AnalysisResult {
  candidates: Candidate[];
  summary: AnalysisSummary;
  /** Leading indicators and the gaming check: distance removed rather than relocated, and code not buried. */
  metrics: { totalWeightedDistance: number; singleFileFolders: number; maxDepth: number };
}

function commonFolder(folders: readonly string[]): string {
  let shared = (folders[0] as string).split("/").filter((part) => part !== "");
  for (const folder of folders) {
    const parts = folder.split("/").filter((part) => part !== "");
    let length = 0;
    while (length < shared.length && length < parts.length && shared[length] === parts[length]) length++;
    shared = shared.slice(0, length);
  }
  return shared.join("/");
}

function relative(folder: string, base: string): string {
  if (folder === base) return "";
  return base === "" ? folder : folder.slice(base.length + 1);
}

function under(folder: string, ancestor: string): boolean {
  return ancestor === "" || folder === ancestor || folder.startsWith(`${ancestor}/`);
}

function countBy(entries: Iterable<[string, number]>): PathCount[] {
  const totals = new Map<string, number>();
  for (const [path, count] of entries) totals.set(path, (totals.get(path) ?? 0) + count);
  return [...totals].map(([path, count]) => ({ path, count })).sort((a, b) => compareIds(a.path, b.path));
}

/** Finds, scores and recommends units. Everything here is deterministic over the project, model and settings. */
export function analyseProject(project: Project, model: Model, settings: LocalitySettings): AnalysisResult {
  const { analysis } = project;
  const isFixed = compileGlobs(settings.fixedPoints);
  const forbidden = (folder: string) => settings.fixedPoints.length > 0 && isFixed(folder === "" ? "_" : `${folder}/_`);
  const thresholds = {
    minDistance: settings.minDistance,
    tinyLines: settings.tinyLines,
    largeLines: settings.largeLines,
    inlineHostLines: settings.inlineHostLines,
    highFanIn: settings.highFanIn,
  };
  const barrels = new Set(analysis.barrels);
  const lines = (path: string) => countLines(project.texts.get(path) ?? "");
  const live = (file: string) => model.reachable.has(file) && !project.isTest(file);

  const consumersTo = new Map<string, Consumer[]>();
  for (const consumer of analysis.consumers) {
    const list = consumersTo.get(consumer.to);
    if (list) list.push(consumer);
    else consumersTo.set(consumer.to, [consumer]);
  }
  const productionSet = new Set(project.production);
  const testImports = new Map<string, Set<string>>();
  const touch = (test: string, file: string) => {
    if (!productionSet.has(file)) return;
    const set = testImports.get(test);
    if (set) set.add(file);
    else testImports.set(test, new Set([file]));
  };
  for (const edge of analysis.importEdges) if (project.isTest(edge.from)) touch(edge.from, edge.to);
  for (const edge of analysis.fileEdges) if (project.isTest(edge.from)) touch(edge.from, edge.to);
  const testsByFile = new Map<string, string[]>();
  for (const [test, files] of [...testImports].sort(([a], [b]) => compareIds(a, b))) {
    for (const file of files) testsByFile.set(file, [...(testsByFile.get(file) ?? []), test]);
  }
  const unitsByFile = new Map<string, SourceUnit[]>();
  for (const unit of analysis.units) unitsByFile.set(unit.path, [...(unitsByFile.get(unit.path) ?? []), unit]);

  function testsOf(files: ReadonlySet<string>): { owned: string[]; external: string[] } {
    const touching = new Set([...files].flatMap((file) => testsByFile.get(file) ?? []));
    const owned: string[] = [];
    const external: string[] = [];
    for (const test of [...touching].sort(compareIds)) {
      const imported = testImports.get(test) as Set<string>;
      (([...imported].every((file) => files.has(file)) ? owned : external) as string[]).push(test);
    }
    return { owned, external };
  }

  function exportedUnits(path: string): SourceUnit[] {
    return (unitsByFile.get(path) ?? []).filter((unit) => unit.exported && unit.parent === undefined);
  }

  function signalsOf(root: string, fanIn: number, importerCount: number): Signal[] {
    const signals: Signal[] = [];
    const vague = vagueSegment(root, settings.vagueNames);
    if (vague !== undefined) signals.push({ name: "vague-name", detail: vague });
    if (barrels.has(root)) signals.push({ name: "barrel", detail: `${importerCount} importing file${importerCount === 1 ? "" : "s"}` });
    const exported = exportedUnits(root);
    const passing = exported.filter((unit) => isPassThrough(unitText(project, unit)));
    if (exported.length > 0 && passing.length === exported.length) {
      signals.push({ name: "pass-through", detail: passing.map((unit) => unit.qualifiedName).join(", ") });
    }
    if (!model.entries.has(root)) {
      const unused = exported.filter(
        (unit) => !(consumersTo.get(root) ?? []).some((consumer) => consumer.toSymbol === unit.qualifiedName && consumer.from !== root),
      );
      if (unused.length > 0) signals.push({ name: "overexposure", detail: unused.map((unit) => unit.qualifiedName).join(", ") });
    }
    if (fanIn >= settings.highFanIn) {
      const flagged = exported
        .map((unit) => ({ unit, flags: flagParameters(unitText(project, unit)) }))
        .filter(({ flags }) => flags.length > 0);
      if (flagged.length > 0) {
        signals.push({
          name: "special-general-mixture",
          detail: flagged.map(({ unit, flags }) => `${unit.qualifiedName}(${flags.join(", ")})`).join("; "),
        });
      }
    }
    return signals.sort((a, b) => compareIds(a.name, b.name));
  }

  function scoreComponent(path: string, component: ExportComponent): ScoredComponent {
    const symbols = new Set(component.symbols);
    const base = folderOf(path);
    const own = (consumersTo.get(path) ?? []).filter(
      (consumer) => consumer.toSymbol !== undefined && symbols.has(consumer.toSymbol) && consumer.kind !== "test" && consumer.from !== path && live(consumer.from),
    );
    const within = (name: string | undefined) =>
      name !== undefined && [...symbols].some((symbol) => name === symbol || name.startsWith(`${symbol}.`));
    const outward = analysis.consumers.filter(
      (consumer) => consumer.from === path && within(consumer.fromUnit) && consumer.to !== path && productionSet.has(consumer.to),
    );
    const boundary: BoundaryEdge[] = [
      ...own.map((consumer) => ({ inner: "", outer: folderOf(consumer.from), weight: consumer.count })),
      ...outward.map((consumer) => ({ inner: "", outer: folderOf(consumer.to), weight: consumer.count })),
    ];
    const choice = bestTarget(boundary, base, { maxDepth: settings.maxDepth, forbidden });
    const units = exportedUnits(path).filter((unit) => symbols.has(unit.qualifiedName));
    const componentLines = units.reduce((sum, unit) => sum + unit.endLine - unit.startLine + 1, 0);
    const only = component.consumers.length === 1 ? (component.consumers[0] as string) : undefined;
    const decision = recommend({
      fanIn: component.consumers.length,
      gain: choice.gain,
      unblockedGain: choice.gain,
      lines: componentLines,
      files: 1,
      consumerLines: only === undefined ? null : lines(only),
      otherRefs: own.filter((consumer) => consumer.kind === "reference").length,
      packageEntry: project.packageEntries.has(path),
      scattered: false,
      fixedPoint: isFixed(path),
      passThrough: units.length === 1 && isPassThrough(unitText(project, units[0] as SourceUnit)),
      barrelWithOneConsumer: false,
      splitCandidate: false,
      ...thresholds,
    });
    return {
      ...component,
      location: base,
      target: choice.target,
      distance: folderDistance(base, choice.target),
      gain: choice.gain,
      fanIn: component.consumers.length,
      lines: componentLines,
      ...decision,
    };
  }

  function candidateFor(unit: RawUnit): Candidate {
    const importerCount = (model.importers.get(unit.root) ?? []).filter(live).length;
    const barrelAlone = barrels.has(unit.root) && importerCount === 1;
    const files = barrelAlone ? [unit.root] : unit.files;
    const fileSet = new Set(files);
    const base = commonFolder(files.map(folderOf));

    const incoming: Edge[] = [];
    const outgoing: Edge[] = [];
    for (const file of files) {
      for (const edge of model.incoming.get(file) ?? []) if (!fileSet.has(edge.from) && model.reachable.has(edge.from)) incoming.push(edge);
      for (const edge of model.outgoing.get(file) ?? []) if (!fileSet.has(edge.to)) outgoing.push(edge);
    }
    const boundaryOf = (outbound: readonly Edge[]): BoundaryEdge[] => [
      ...incoming.map((edge) => ({ inner: relative(folderOf(edge.to), base), outer: folderOf(edge.from), weight: edge.weight })),
      ...outbound.map((edge) => ({ inner: relative(folderOf(edge.from), base), outer: folderOf(edge.to), weight: edge.weight })),
    ];
    const options = { maxDepth: settings.maxDepth, forbidden };
    const choice = barrelAlone ? { target: base, current: 0, distance: 0, gain: 0 } : bestTarget(boundaryOf(outgoing), base, options);

    const consumerFiles = barrelAlone
      ? (model.importers.get(unit.root) ?? []).filter(live)
      : [...new Set(incoming.map((edge) => edge.from))].sort(compareIds);
    const targets = [...new Set(outgoing.map((edge) => edge.to))].sort(compareIds);
    const blockers: Blocker[] = [];
    if (incoming.length > 0 && !barrelAlone) {
      for (const target of targets) {
        const without = bestTarget(boundaryOf(outgoing.filter((edge) => edge.to !== target)), base, options);
        if (without.gain <= choice.gain) continue;
        const weight = outgoing.filter((edge) => edge.to === target).reduce((sum, edge) => sum + edge.weight, 0);
        const others = new Set((model.incoming.get(target) ?? []).filter((edge) => !fileSet.has(edge.from) && model.reachable.has(edge.from)).map((edge) => edge.from));
        blockers.push({
          path: target,
          kind: base !== "" && under(folderOf(target), base) ? "stray" : "dependency",
          weight,
          otherConsumers: others.size,
          coChange: null,
          unblockedGain: without.gain,
        });
      }
      blockers.sort((a, b) => b.unblockedGain - a.unblockedGain || compareIds(a.path, b.path));
    }
    const blocked = new Set(blockers.map((blocker) => blocker.path));
    const unblocked =
      blockers.length === 0
        ? choice.gain
        : bestTarget(boundaryOf(outgoing.filter((edge) => !blocked.has(edge.to))), base, options).gain;

    const calls = countBy(
      files.flatMap((file) =>
        (consumersTo.get(file) ?? []).filter((c) => c.kind === "call" && !fileSet.has(c.from) && live(c.from)).map((c): [string, number] => [c.from, c.count]),
      ),
    );
    const otherRefs = countBy(
      files.flatMap((file) =>
        (consumersTo.get(file) ?? []).filter((c) => c.kind === "reference" && !fileSet.has(c.from) && live(c.from)).map((c): [string, number] => [c.from, c.count]),
      ),
    );
    const tests = testsOf(fileSet);
    const totalLines = files.reduce((sum, file) => sum + lines(file), 0);
    const only = consumerFiles.length === 1 ? (consumerFiles[0] as string) : undefined;
    const signals = signalsOf(unit.root, consumerFiles.length, importerCount);
    const cohesion: FileCohesion | undefined = barrelAlone ? undefined : fileCohesion(project, unit.root, live);
    const input: RecommendInput = {
      fanIn: consumerFiles.length,
      gain: choice.gain,
      unblockedGain: unblocked,
      lines: totalLines,
      files: files.length,
      consumerLines: only === undefined ? null : lines(only),
      otherRefs: otherRefs.length,
      packageEntry: files.some((file) => project.packageEntries.has(file)),
      scattered: files.some((file) => !under(folderOf(file), folderOf(unit.root))),
      fixedPoint: files.some((file) => isFixed(file)),
      passThrough: signals.some((signal) => signal.name === "pass-through") && files.length === 1,
      barrelWithOneConsumer: barrelAlone,
      splitCandidate: cohesion?.mixed === true,
      ...thresholds,
    };
    const decision = recommend(input);

    const scored = cohesion?.mixed ? cohesion.components.map((component) => scoreComponent(unit.root, component)) : undefined;
    const score =
      decision.recommendation === "blocked"
        ? unblocked
        : decision.recommendation === "split"
          ? Math.max(choice.gain, (scored ?? []).reduce((sum, component) => sum + component.gain, 0))
          : decision.recommendation === "scrutinise"
            ? consumerFiles.length
            : choice.gain;

    const ownDeps = targets;
    return {
      path: unit.path,
      score,
      ...decision,
      source: "structural",
      unit: {
        kind: barrelAlone ? "barrel" : unit.kind,
        root: unit.root,
        entries: unit.entries,
        files,
        tests: tests.owned,
        cycle: unit.cycle,
      },
      location: base,
      target: choice.target,
      distance: folderDistance(base, choice.target),
      gain: choice.gain,
      unblockedGain: unblocked,
      netDistance: { current: choice.current, atTarget: choice.distance },
      directCalls: calls,
      otherRefs,
      testRefs: tests,
      fanIn: consumerFiles.length,
      size: { lines: totalLines, files: files.length, units: files.reduce((sum, file) => sum + (unitsByFile.get(file)?.length ?? 0), 0) },
      ownDeps,
      visibility: input.packageEntry ? "package-entry" : "exported",
      age: null,
      lastChanged: null,
      churn: null,
      coChange: null,
      signals,
      strays: blockers.filter((blocker) => blocker.kind === "stray").map((blocker) => blocker.path).sort(compareIds),
      blockers,
      ...(cohesion ? { cohesion: { components: scored ?? cohesion.components, mixed: cohesion.mixed } } : {}),
    };
  }

  const all = model.units.map(candidateFor);
  const reported = all
    .filter((candidate) => candidate.rule !== "near-consumers")
    .sort((a, b) => b.score - a.score || compareIds(a.path, b.path));
  const byRecommendation: Record<string, number> = {};
  for (const candidate of reported) byRecommendation[candidate.recommendation] = (byRecommendation[candidate.recommendation] ?? 0) + 1;

  const folders = new Map<string, number>();
  for (const file of project.production) folders.set(folderOf(file), (folders.get(folderOf(file)) ?? 0) + 1);
  return {
    candidates: reported,
    summary: { files: project.production.length, units: all.length, byRecommendation },
    metrics: {
      totalWeightedDistance: model.edges
        .filter((edge) => model.reachable.has(edge.from))
        .reduce((sum, edge) => sum + edge.weight * treeDistance(edge.from, edge.to), 0),
      singleFileFolders: [...folders.values()].filter((count) => count === 1).length,
      maxDepth: Math.max(0, ...[...folders.keys()].map(depthOf)),
    },
  };
}
