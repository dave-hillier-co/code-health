import { compareIds } from "@code-health/graph/graph";
import { folderOf } from "@code-health/graph/tree-distance";
import type { SourceUnit } from "@code-health/parse/analyse-tree";
import type { Project } from "./project.ts";
import { unitText } from "./project.ts";

/** Exports that belong together: they share consumers or refer to each other. */
export interface ExportComponent {
  /** Qualified names of the exported units, sorted. */
  symbols: string[];
  /** Production files that use any of the symbols, sorted. */
  consumers: string[];
  consumerFolders: string[];
}

export interface FileCohesion {
  /** Connected components of the export graph. One component means the file is cohesive. */
  components: ExportComponent[];
  /** True when two components have consumers in disjoint sets of folders: the file is several units sharing a name. */
  mixed: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * How much the consumers of a file's exported units overlap (module-level LCOM). Two exports are linked when
 * a file uses both or when one's source mentions the other, and the components are the connected groups.
 * Only exported functions, methods and classes are units, so constants and types take no part.
 * Undefined when the file exports fewer than two units.
 */
export function fileCohesion(
  project: Project,
  path: string,
  isLive: (consumer: string) => boolean,
): FileCohesion | undefined {
  const exported: SourceUnit[] = project.analysis.units.filter((unit) => unit.path === path && unit.exported && unit.parent === undefined);
  if (exported.length < 2) return undefined;

  const consumersOf = new Map<string, Set<string>>(exported.map((unit) => [unit.qualifiedName, new Set()]));
  for (const consumer of project.analysis.consumers) {
    if (consumer.to !== path || consumer.toSymbol === undefined || consumer.kind === "test") continue;
    if (consumer.from === path || !isLive(consumer.from)) continue;
    consumersOf.get(consumer.toSymbol)?.add(consumer.from);
  }

  const parent = new Map<string, string>(exported.map((unit) => [unit.qualifiedName, unit.qualifiedName]));
  const find = (name: string): string => {
    let root = name;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  const link = (a: string, b: string) => {
    const [x, y] = [find(a), find(b)].sort(compareIds);
    if (x !== y) parent.set(y as string, x as string);
  };

  for (const a of exported) {
    for (const b of exported) {
      if (a === b) continue;
      const shared = [...(consumersOf.get(a.qualifiedName) as Set<string>)].some((file) =>
        (consumersOf.get(b.qualifiedName) as Set<string>).has(file),
      );
      const mentioned = new RegExp(`(?<![\\w$.])${escapeRegExp(b.qualifiedName)}(?![\\w$])`).test(unitText(project, a));
      if (shared || mentioned) link(a.qualifiedName, b.qualifiedName);
    }
  }

  const groups = new Map<string, string[]>();
  for (const unit of exported) {
    const root = find(unit.qualifiedName);
    groups.set(root, [...(groups.get(root) ?? []), unit.qualifiedName]);
  }
  const components = [...groups.values()]
    .map((symbols): ExportComponent => {
      const consumers = new Set(symbols.flatMap((symbol) => [...(consumersOf.get(symbol) as Set<string>)]));
      return {
        symbols: symbols.sort(compareIds),
        consumers: [...consumers].sort(compareIds),
        consumerFolders: [...new Set([...consumers].map(folderOf))].sort(compareIds),
      };
    })
    .sort((a, b) => compareIds(a.symbols[0] as string, b.symbols[0] as string));

  const mixed = components.some((a, index) =>
    components.slice(index + 1).some(
      (b) =>
        a.consumerFolders.length > 0 &&
        b.consumerFolders.length > 0 &&
        a.consumerFolders.every((folder) => !b.consumerFolders.includes(folder)),
    ),
  );
  return { components, mixed };
}
