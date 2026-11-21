import type { Consumer, ExportedName, FileEdge, ImportEdge, ResolvedDependencies } from "../../analyse-tree.ts";
import type { FileFacts } from "../../facts.ts";
import type { ResolveInput } from "../../language-adapter.ts";
import { resolveBySymbols } from "../../symbol-model.ts";
import { isProjectFile, ProjectIndex, reachableProjects } from "./projects.ts";

/**
 * C# dependency resolution: the shared symbol model, run once per project over the files that project can see,
 * with two things a project tree adds.
 *
 * - Visibility. A file sees its own project and the projects it references, directly or not. Two projects that
 *   each declare a `Program` do not resolve to one another, and a type is not found in a project that
 *   nothing references. A repository with no project files is one project.
 * - Global usings. A `global using` applies to every file of its project.
 *
 * And partial classes. Parts of one type declared in several files of a project are one unit: references and
 * exports land on the part the type is known by, and the parts depend on one
 * another, which puts them in one strongly connected component of every graph built from the edges. The part a
 * type is known by is the one in the file named for it (`Ledger.cs` for `Ledger`), else the first by path.
 */

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function withGlobalUsings(facts: ReadonlyMap<string, FileFacts>, owner: (path: string) => string): Map<string, FileFacts> {
  const globals = new Map<string, Set<string>>();
  for (const [path, file] of facts) {
    for (const use of file.symbols?.globalUses ?? []) {
      const key = owner(path);
      globals.set(key, (globals.get(key) ?? new Set()).add(use));
    }
  }
  if (globals.size === 0) return new Map(facts);
  const out = new Map<string, FileFacts>();
  for (const [path, file] of facts) {
    const extra = [...(globals.get(owner(path)) ?? [])].filter((use) => !file.symbols?.uses.includes(use));
    out.set(path, file.symbols === undefined || extra.length === 0 ? file : { ...file, symbols: { ...file.symbols, uses: [...file.symbols.uses, ...extra] } });
  }
  return out;
}

interface Part {
  file: string;
  unit: string;
}

/**
 * The types each project declares in more than one file, keyed by project and type name, with the part the type
 * is known by first. Types of different projects that share a name are not parts of one type.
 */
function partialTypes(facts: ReadonlyMap<string, FileFacts>, owner: (path: string) => string): Map<string, Part[]> {
  const declared = new Map<string, Part[]>();
  for (const [file, fileFacts] of facts) {
    for (const declaration of fileFacts.symbols?.declarations ?? []) {
      if (declaration.unit === undefined) continue;
      const key = `${owner(file)}\0${declaration.name}`;
      const list = declared.get(key) ?? [];
      if (!list.some((part) => part.file === file)) list.push({ file, unit: declaration.unit });
      declared.set(key, list);
    }
  }
  const partial = new Map<string, Part[]>();
  for (const [key, parts] of declared) {
    if (parts.length < 2) continue;
    const primary = `${nameOf(key).slice(nameOf(key).lastIndexOf(".") + 1)}.cs`;
    partial.set(key, parts.sort((a, b) => Number(basename(b.file) === primary) - Number(basename(a.file) === primary) || compare(a.file, b.file)));
  }
  return partial;
}

/** The type name of a key made by `partialTypes`. */
const nameOf = (key: string): string => key.slice(key.indexOf("\0") + 1);

function mergePartials(resolved: ResolvedDependencies, partial: ReadonlyMap<string, Part[]>, own: ReadonlySet<string>, isTest: (path: string) => boolean): ResolvedDependencies {
  if (partial.size === 0) return resolved;
  // Where each part's name leads: the part the type is known by.
  const lead = new Map<string, Part>();
  for (const [key, parts] of partial) for (const part of parts) lead.set(`${part.file}\0${nameOf(key)}`, parts[0]!);

  const consumers = new Map<string, Consumer>();
  const addConsumer = (consumer: Consumer): void => {
    const key = [consumer.from, consumer.fromUnit ?? "", consumer.to, consumer.toSymbol ?? consumer.toExport, consumer.kind].join("\0");
    const existing = consumers.get(key);
    if (existing === undefined) consumers.set(key, { ...consumer });
    // A reference to a partial type resolves to every part, so the same use arrives once per part.
    else existing.count = Math.max(existing.count, consumer.count);
  };
  for (const consumer of resolved.consumers) {
    const target = lead.get(`${consumer.to}\0${consumer.toExport}`);
    addConsumer(target === undefined ? consumer : { ...consumer, to: target.file, toSymbol: target.unit });
  }

  const fileEdges = new Map<string, FileEdge>(resolved.fileEdges.map((edge) => [`${edge.from}\0${edge.to}`, edge]));
  for (const [key, parts] of partial) {
    for (const from of parts) {
      for (const to of parts) {
        if (from.file === to.file || !own.has(from.file)) continue;
        const edge = `${from.file}\0${to.file}`;
        const kind = isTest(from.file) ? "test" : "reference";
        if (!fileEdges.has(edge)) fileEdges.set(edge, { from: from.file, to: to.file, kind, calls: 0, references: 1 });
        addConsumer({ from: from.file, fromUnit: from.unit, to: to.file, toSymbol: to.unit, toExport: nameOf(key), kind, count: 1 });
      }
    }
  }

  const exports: ExportedName[] = resolved.exports.map((exported) => {
    const target = lead.get(`${exported.defined.file}\0${exported.defined.name}`);
    return target === undefined ? exported : { ...exported, defined: { ...exported.defined, file: target.file, symbol: target.unit } };
  });
  const importEdges = new Map<string, ImportEdge>(resolved.importEdges.map((edge) => [`${edge.from}\0${edge.to}`, edge]));
  for (const edge of fileEdges.values()) {
    if (!importEdges.has(`${edge.from}\0${edge.to}`)) importEdges.set(`${edge.from}\0${edge.to}`, { from: edge.from, to: edge.to, kind: "import", typeOnly: false });
  }
  return { ...resolved, consumers: [...consumers.values()], fileEdges: [...fileEdges.values()], importEdges: [...importEdges.values()], exports };
}

export function resolveCsharp(input: ResolveInput): ResolvedDependencies {
  const index = new ProjectIndex(input.paths);
  const projects = index.projects.filter(isProjectFile);
  const owner = (path: string): string => index.ownerOf(path) ?? "";
  const facts = withGlobalUsings(input.facts, owner);

  // Files with no project see everything, and so do all the files of a repository with none.
  const reach = reachableProjects(projects, input.configs);
  const groups = [...new Set([...facts.keys()].map(owner))].sort(compare);
  const merged: ResolvedDependencies[] = [];
  for (const group of groups) {
    const visible = group === "" ? undefined : reach.get(group);
    const members = new Map([...facts].filter(([path]) => visible === undefined || visible.has(owner(path))));
    const own = new Set([...members.keys()].filter((path) => owner(path) === group));
    const resolved = resolveBySymbols({ ...input, facts: members });
    const kept: ResolvedDependencies = {
      ...resolved,
      importEdges: resolved.importEdges.filter((edge) => own.has(edge.from)),
      consumers: resolved.consumers.filter((consumer) => own.has(consumer.from)),
      fileEdges: resolved.fileEdges.filter((edge) => own.has(edge.from)),
      exports: resolved.exports.filter((exported) => own.has(exported.file)),
    };
    merged.push(mergePartials(kept, partialTypes(members, owner), own, input.isTestPath));
  }
  return {
    importEdges: merged.flatMap((part) => part.importEdges),
    consumers: merged.flatMap((part) => part.consumers),
    fileEdges: merged.flatMap((part) => part.fileEdges),
    barrels: [],
    exports: merged.flatMap((part) => part.exports),
    externalImports: [],
    unresolved: [],
  };
}
