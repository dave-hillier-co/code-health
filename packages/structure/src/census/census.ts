import { compareUtf8 } from "@code-health/parse/analyse-tree";
import type { FileCensus, TypeDeclaration } from "@code-health/parse/census-facts";
import { GrammarSet } from "@code-health/parse/grammars";
import { registeredAdapters } from "@code-health/parse/languages";
import type { SourceTree } from "@code-health/parse/source-tree";
import type { CensusDetectors } from "./census-language.ts";
import { censusDetectorsOf } from "./language.ts";
import { folderOf, type Project } from "../project.ts";

export const MECHANISMS = ["callbacks", "interfaces", "dependency-injection", "events", "handlers", "registries", "ports-and-adapters"] as const;
export type Mechanism = (typeof MECHANISMS)[number];

/** What the codebase's own conventions add to the built-in vocabulary. */
export interface CensusSettings {
  /** Folder names that mark ports and adapters, matched against a folder's own name without regard to case (`Ports` is a C# folder). */
  folderNames: readonly string[];
  /** Method names that count as events, on any receiver. */
  eventCalls: readonly string[];
  /** Method names that count as handler registration or dispatch, on any receiver. */
  handlerCalls: readonly string[];
  /** Method names that count as registering into a registry, on any receiver. */
  registerCalls: readonly string[];
}

export interface Occurrence {
  mechanism: Mechanism;
  /** Which form of the mechanism this is, such as `decorator` or `container-registration`. */
  variant: string;
  /** The file, or the folder itself for a folder occurrence. */
  path: string;
  /** Null for a folder. */
  line: number | null;
  /** The folders the occurrence involves, sorted: where it sits, and where it reaches. */
  folders: string[];
  detail: string;
}

/** Calls that match a mechanism's names but were not counted, with why. */
export interface LookAlike {
  mechanism: Mechanism;
  /** The method or function name called. */
  name: string;
  /** Calls left out. */
  count: number;
  /** Types and files of the repository that define the name. */
  definitions: number;
  detail: string;
}

export interface Census {
  /** Production files of every supported language that the census read. */
  files: number;
  occurrences: Occurrence[];
  lookAlikes: LookAlike[];
}

function isNamed(folder: string, names: ReadonlySet<string>): boolean {
  return names.has(folder.slice(folder.lastIndexOf("/") + 1).toLowerCase());
}

class Reader {
  private readonly census: ReadonlyMap<string, FileCensus>;
  private readonly project: Project;

  constructor(census: ReadonlyMap<string, FileCensus>, project: Project) {
    this.census = census;
    this.project = project;
  }

  /**
   * The file declaring a type used in `path` by name: among the files it imports, following re-exports.
   * Only an unambiguous answer is given.
   */
  declaringFile(path: string, name: string, kinds: readonly TypeDeclaration["kind"][]): { path: string; declaration: TypeDeclaration } | undefined {
    const binding = this.census.get(path)?.imports.find((entry) => entry.local === name);
    const wanted = binding && binding.imported !== "*" && binding.imported !== "default" ? binding.imported : name;
    const own = this.census.get(path)?.types.find((type) => type.name === wanted && kinds.includes(type.kind));
    if (own) return { path, declaration: own };
    const seen = new Set<string>([path]);
    const queue = [...(this.project.graph.get(path) ?? [])];
    const found: { path: string; declaration: TypeDeclaration }[] = [];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const declaration = this.census.get(next)?.types.find((type) => type.name === wanted && kinds.includes(type.kind));
      if (declaration) found.push({ path: next, declaration });
      else if (this.isPassThrough(next)) queue.push(...(this.project.graph.get(next) ?? []));
    }
    return found.length === 1 ? found[0] : undefined;
  }

  /** A file that declares no types of its own may be re-exporting them. */
  private isPassThrough(path: string): boolean {
    const file = this.census.get(path);
    return file !== undefined && file.classes.length === 0 && file.functions.length === 0 && file.types.length === 0;
  }
}

/**
 * The send names (event names that are not listen names) that the repository defines itself, only on types
 * and files with no listen method and no event base type, with how many types and files define each. A call
 * to such a name runs the repository's own code, which nobody subscribes to: telemetry's `emit`, a logging
 * handler's `emit`. Keyed by adapter id, because each language has its own names.
 */
function ownSendNames(files: ReadonlyMap<string, FileCensus>, adapterOf: ReadonlyMap<string, string>, stated: ReadonlySet<string>): Map<string, Map<string, number>> {
  const definers = new Map<string, Map<string, Set<string>>>();
  const listening = new Set<string>();
  for (const [path, file] of files) {
    const adapterId = adapterOf.get(path)!;
    const detectors = censusDetectorsOf(adapterId);
    for (const klass of file.classes) {
      if (klass.heritage.some((name) => detectors.eventBaseTypes.has(name))) listening.add(`${adapterId}\0${klass.name}`);
    }
    for (const fn of file.functions) {
      const dot = fn.name.lastIndexOf(".");
      const owner = `${adapterId}\0${dot === -1 ? `file:${path}` : fn.name.slice(0, dot)}`;
      const name = fn.name.slice(dot + 1);
      if (detectors.listenMethods.has(name)) listening.add(owner);
      else if ((detectors.eventMethods.has(name) || detectors.eventFunctions.has(name)) && !stated.has(name)) {
        const byName = definers.get(adapterId) ?? new Map<string, Set<string>>();
        definers.set(adapterId, byName.set(name, (byName.get(name) ?? new Set()).add(owner)));
      }
    }
  }
  const out = new Map<string, Map<string, number>>();
  for (const [adapterId, byName] of definers) {
    for (const [name, owners] of byName) {
      if ([...owners].some((owner) => listening.has(owner))) continue;
      out.set(adapterId, (out.get(adapterId) ?? new Map<string, number>()).set(name, owners.size));
    }
  }
  return out;
}

/** Reads every production file of the project and finds the decoupling mechanisms already in use. */
export async function buildCensus(tree: SourceTree, project: Project, settings: CensusSettings): Promise<Census> {
  const files = new Map<string, FileCensus>();
  const adapterOf = new Map<string, string>();
  const grammars = new GrammarSet();
  const sources = await tree.readMany(project.files);
  for (const path of project.files) {
    const source = sources.get(path);
    const language = await grammars.forPath(path);
    if (source === undefined || language === undefined) continue;
    const parsed = language.grammar.parse(source);
    try {
      files.set(path, language.adapter.census.extract(parsed.rootNode));
      adapterOf.set(path, language.adapter.id);
    } finally {
      parsed.delete();
    }
  }

  const occurrences: Occurrence[] = [];
  const add = (occurrence: Omit<Occurrence, "folders"> & { folders?: string[] }): void => {
    // A folder occurrence is the folder itself. A file occurrence involves the file's folder and any it reaches.
    const home = occurrence.line === null ? occurrence.path : folderOf(occurrence.path);
    occurrences.push({ ...occurrence, folders: [...new Set([home, ...(occurrence.folders ?? [])])].sort(compareUtf8) });
  };
  const reader = new Reader(files, project);
  const handlerNames = new Set(settings.handlerCalls);
  const registerNames = new Set(settings.registerCalls);
  const eventNamesOf = new Map<string, ReadonlySet<string>>();
  const eventNames = (id: string, detectors: CensusDetectors): ReadonlySet<string> => {
    let names = eventNamesOf.get(id);
    if (names === undefined) eventNamesOf.set(id, (names = new Set([...detectors.eventMethods, ...settings.eventCalls])));
    return names;
  };

  const ownSends = ownSendNames(files, adapterOf, new Set(settings.eventCalls));
  const lookAlikeCalls = new Map<string, number>();

  const implementers = new Map<string, { interfacePath: string; line: number; name: string; folders: Set<string> }>();
  const projectFiles = new Set(project.files);
  const callers = new Map<string, Set<string>>();
  // Uses of a type by any kind, for a method whose calls the graph does not resolve (`Queue::new(..)` in Rust is a use of `Queue`).
  const typeUsers = new Map<string, Set<string>>();
  for (const consumer of project.analysis.consumers) {
    if (consumer.toSymbol === undefined || !projectFiles.has(consumer.from)) continue;
    if (folderOf(consumer.from) === folderOf(consumer.to)) continue;
    const key = `${consumer.to}#${consumer.toSymbol}`;
    if (consumer.kind === "call") callers.set(key, (callers.get(key) ?? new Set()).add(folderOf(consumer.from)));
    if (consumer.kind === "call" || consumer.kind === "reference") typeUsers.set(key, (typeUsers.get(key) ?? new Set()).add(folderOf(consumer.from)));
  }
  const symbolBased = new Set(registeredAdapters.filter((adapter) => adapter.dependencies.model === "symbol-based").map((adapter) => adapter.id));
  const callbackAliases = (path: string, names: readonly string[], detectors: CensusDetectors): boolean =>
    names.some((name) => detectors.callbackTypeNames.has(name) || reader.declaringFile(path, name, ["function-type"]) !== undefined);

  for (const [path, file] of files) {
    const folder = folderOf(path);
    const adapterId = adapterOf.get(path)!;
    const detectors = censusDetectorsOf(adapterId);

    // Interfaces implemented elsewhere, and constructor injection of them.
    for (const klass of file.classes) {
      for (const name of klass.heritage) {
        if (detectors.eventBaseTypes.has(name)) add({ mechanism: "events", variant: "base-type", path, line: klass.line, detail: `${klass.name} extends ${name}` });
        else if (detectors.handlerType.test(name)) add({ mechanism: "handlers", variant: "handler-type", path, line: klass.line, detail: `${klass.name} implements ${name}` });
        const target = reader.declaringFile(path, name, ["interface", "abstract-class"]);
        if (target && folderOf(target.path) !== folder) {
          const key = `${target.path}#${target.declaration.name}`;
          const entry = implementers.get(key) ?? { interfacePath: target.path, line: target.declaration.line, name: target.declaration.name, folders: new Set<string>() };
          entry.folders.add(folder);
          implementers.set(key, entry);
        }
      }
      const injected = new Set<string>();
      for (const name of klass.constructorTypes) {
        const target = reader.declaringFile(path, name, ["interface", "abstract-class"]);
        if (target && folderOf(target.path) !== folder && !injected.has(name)) {
          injected.add(name);
          add({
            mechanism: "dependency-injection",
            variant: "constructor-injection",
            path,
            line: klass.line,
            folders: [folderOf(target.path)],
            detail: `${klass.name} takes ${target.declaration.name} from ${folderOf(target.path)}`,
          });
        }
      }
    }

    for (const klass of file.news) {
      if (detectors.eventBaseTypes.has(klass.name)) add({ mechanism: "events", variant: "base-type", path, line: klass.line, detail: `new ${klass.name}` });
    }

    for (const decorator of file.decorators) {
      if (detectors.injectionDecorators.has(decorator.name.toLowerCase())) add({ mechanism: "dependency-injection", variant: "decorator", path, line: decorator.line, detail: `@${decorator.name}` });
      else if (detectors.handlerType.test(decorator.name)) add({ mechanism: "handlers", variant: "handler-decorator", path, line: decorator.line, detail: `@${decorator.name}` });
    }

    for (const call of file.calls) {
      const where = call.receiver === null ? call.method : `${call.receiver}.${call.method}`;
      const registers = /^register\w*$/.test(call.method) || registerNames.has(call.method);
      if (call.receiver !== null && detectors.containerReceiver.test(call.receiver) && detectors.containerRegistrations.test(call.method)) {
        add({ mechanism: "dependency-injection", variant: "container-registration", path, line: call.line, detail: where });
      } else if (detectors.handlerRegistration.test(call.method) || handlerNames.has(call.method)) {
        add({ mechanism: "handlers", variant: "handler-registration", path, line: call.line, detail: where });
      } else if (call.receiver !== null && detectors.handlerReceiver.test(call.receiver) && detectors.handlerMethods.has(call.method)) {
        add({ mechanism: "handlers", variant: "dispatch", path, line: call.line, detail: where });
      } else if (call.receiver !== null ? eventNames(adapterId, detectors).has(call.method) && !detectors.platformReceivers.has(call.receiver) : detectors.eventFunctions.has(call.method) || settings.eventCalls.includes(call.method)) {
        if (ownSends.get(adapterId)?.has(call.method)) {
          const key = `${adapterId}\0${call.method}`;
          lookAlikeCalls.set(key, (lookAlikeCalls.get(key) ?? 0) + 1);
        } else add({ mechanism: "events", variant: "call", path, line: call.line, detail: where });
      } else if (registers) {
        add({ mechanism: "registries", variant: "register-call", path, line: call.line, detail: where });
      }
    }

    for (const map of file.keyedMaps) add({ mechanism: "registries", variant: "keyed-map", path, line: map.line, detail: map.name });

    // Callbacks: a function with a function-typed parameter that something in another folder calls.
    for (const fn of file.functions) {
      const parameter = fn.parameters.find((p) => p.type.callback || callbackAliases(path, p.type.names, detectors));
      if (!parameter) continue;
      // A symbol-based graph resolves a call to the type that declares the method, and an import-based one records
      // the use of the type (an import, `Type::new(..)`), so a method is reached through its type.
      const owner = fn.name.includes(".") ? fn.name.slice(0, fn.name.lastIndexOf(".")) : undefined;
      const throughType = owner === undefined ? undefined : (symbolBased.has(adapterId) ? callers : typeUsers).get(`${path}#${owner}`);
      const direct = callers.get(`${path}#${fn.name}`);
      const callerFolders = [...(direct ?? throughType ?? [])].sort(compareUtf8);
      if (callerFolders.length === 0) continue;
      const reach = direct === undefined && !symbolBased.has(adapterId) ? `is a method of ${owner}, which is used from` : "is called from";
      add({
        mechanism: "callbacks",
        variant: "function-parameter",
        path,
        line: fn.line,
        folders: callerFolders,
        detail: `${fn.name}(${parameter.name}) ${reach} ${callerFolders.join(", ")}`,
      });
    }
  }

  for (const entry of implementers.values()) {
    const folders = [...entry.folders].sort(compareUtf8);
    add({
      mechanism: "interfaces",
      variant: "interface",
      path: entry.interfacePath,
      line: entry.line,
      folders,
      detail: `${entry.name} is implemented in ${folders.join(", ")}`,
    });
  }

  const names = new Set(settings.folderNames.map((name) => name.toLowerCase()));
  const seen = new Set<string>();
  for (const path of project.files) {
    for (let folder = folderOf(path); folder !== "."; folder = folderOf(folder)) {
      if (seen.has(folder)) break;
      seen.add(folder);
      if (isNamed(folder, names)) add({ mechanism: "ports-and-adapters", variant: "folder", path: folder, line: null, detail: folder.slice(folder.lastIndexOf("/") + 1) });
    }
  }

  occurrences.sort(
    (a, b) =>
      MECHANISMS.indexOf(a.mechanism) - MECHANISMS.indexOf(b.mechanism) ||
      compareUtf8(a.path, b.path) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      compareUtf8(a.variant, b.variant) ||
      compareUtf8(a.detail, b.detail),
  );
  // One entry per name: the same name in two languages is still one name to the reader.
  const byName = new Map<string, { count: number; definitions: number }>();
  for (const [key, count] of lookAlikeCalls) {
    const [adapterId, name] = key.split("\0") as [string, string];
    const entry = byName.get(name) ?? { count: 0, definitions: 0 };
    byName.set(name, { count: entry.count + count, definitions: entry.definitions + ownSends.get(adapterId)!.get(name)! });
  }
  const lookAlikes = [...byName]
    .map(([name, { count, definitions }]): LookAlike => ({
      mechanism: "events",
      name,
      count,
      definitions,
      detail: `${name} is defined in this repository on ${definitions === 1 ? "1 type or file, which has no listen method and no event base type" : `${definitions} types or files, and none of them has a listen method or an event base type`}, so a call runs that code and notifies no listener`,
    }))
    .sort((a, b) => b.count - a.count || compareUtf8(a.name, b.name));
  return { files: files.size, occurrences, lookAlikes };
}
