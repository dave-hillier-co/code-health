import { posix } from "node:path";
import type { SourceTree } from "@code-health/parse/source-tree";
import type { FileOperation } from "../move-plan.ts";
import { confirmWithRoslyn } from "./csharp-roslyn.ts";
import type { MoveResult, MoverBackend, Rewrite, Skeleton } from "./language.ts";
import { sourceFilesOf } from "./language.ts";

const isSource = sourceFilesOf("csharp");

/** The types a file declares `partial`, by simple name. */
const partialTypes = (text: string): string[] =>
  [...text.matchAll(/\bpartial\s+(?:class|struct|interface|record(?:\s+(?:class|struct))?)\s+(\w+)/g)].map((match) => match[1]!);

const directoryOf = (path: string): string => (posix.dirname(path) === "." ? "" : posix.dirname(path));

/**
 * Parts of one type that a move would separate: the type is read as one unit, so its parts are meant to move
 * together, and a part that moves alone leaves the type's files in two folders.
 */
async function partialWarnings(tree: SourceTree, moved: readonly FileOperation[]): Promise<string[]> {
  const warnings: string[] = [];
  const destination = new Map(moved.map((operation) => [operation.from, operation.to]));
  const sources = [...tree.files.keys()].filter(isSource).sort();
  const texts = await tree.readMany(sources);
  for (const operation of moved) {
    for (const type of new Set(partialTypes(texts.get(operation.from) ?? ""))) {
      const folders = new Set<string>();
      for (const path of sources) {
        if (path === operation.from || !partialTypes(texts.get(path) ?? "").includes(type)) continue;
        folders.add(directoryOf(destination.get(path) ?? path));
      }
      if (folders.size > 0 && !(folders.size === 1 && folders.has(directoryOf(operation.to)))) {
        warnings.push(`${operation.to} holds a part of partial type ${type} whose other parts will be in ${[...folders].sort().map((folder) => folder || "the repository root").join(", ")}: the parts of one type move together`);
      }
    }
  }
  return warnings;
}

/** The `<Compile Include|Update|Remove="...">` items of a project file that name a moved file, rewritten to its new place. */
function rewriteProject(path: string, text: string, destination: ReadonlyMap<string, string>): { text: string; rewrites: Rewrite[] } {
  const directory = directoryOf(path) || ".";
  const rewrites: Rewrite[] = [];
  const updated = text.replace(/<Compile\b[^>]*>/gi, (tag, offset: number) =>
    tag.replace(/\b(Include|Update|Remove)(\s*=\s*)"([^"]*)"/gi, (match, attribute: string, equals: string, value: string, at: number) => {
      const target = destination.get(posix.normalize(posix.join(directory, value.replaceAll("\\", "/"))));
      if (target === undefined) return match;
      let written = posix.relative(directory, target);
      if (value.includes("\\")) written = written.replaceAll("/", "\\");
      rewrites.push({ path, line: text.slice(0, offset + at).split("\n").length, from: value, to: written });
      return `${attribute}${equals}"${written}"`;
    }),
  );
  return { text: updated, rewrites };
}

/**
 * Moves C# files. A move changes no namespace, so no `using` and no reference to a type changes: the files
 * only change place. SDK-style projects glob their sources, so nothing in them changes either. A project that
 * lists a moved file as a `<Compile>` item names the new place, and that is the only text a move rewrites.
 * Nothing is written: the caller decides whether to show it or apply it.
 */
async function performMove(tree: SourceTree, operations: readonly FileOperation[]): Promise<Omit<MoveResult, "confirmations">> {
  const moved = operations.filter((operation) => isSource(operation.from));
  const destination = new Map(moved.map((operation) => [operation.from, operation.to]));
  const warnings = await partialWarnings(tree, moved);
  for (const operation of moved) if (!tree.files.has(operation.from)) warnings.push(`${operation.from} could not be read as a source file`);

  const rewrites: Rewrite[] = [];
  const texts = new Map<string, string>();
  const projects = [...tree.files.keys()].filter((path) => path.endsWith(".csproj")).sort();
  for (const [path, text] of await tree.readMany(projects)) {
    const result = rewriteProject(path, text, destination);
    if (result.text === text) continue;
    rewrites.push(...result.rewrites);
    texts.set(path, result.text);
  }
  rewrites.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  return { rewrites, texts, warnings };
}

/** C# has no references to blank: a move rewrites no import path. */
function skeleton(_path: string, text: string): Skeleton {
  return { text, specifiers: [] };
}

export const backend: MoverBackend = {
  performMove,
  skeleton,
  confirm: async (tree, operations, tool) => confirmWithRoslyn(tree, operations, tool, performMove),
};
