import { posix } from "node:path";
import type { SourceTree } from "@code-health/parse/source-tree";
import type { FileOperation } from "../move-plan.ts";
import type { MoveResult, Rewrite } from "./mover-language.ts";

/**
 * The optional second step of a C# move: making namespaces follow the folders the files moved to. It is a
 * commit of its own, after the move, because reflection, serialisation, XAML and DI-by-name can all see a
 * namespace, and for a library it is a public API change (docs/languages.md, Language notes).
 *
 * The step is deliberately narrow. A moved file's namespace follows its folder when the namespace ends with the
 * folder's path below the part the move leaves alone (`Acme.Billing` for `src/Billing`). That namespace is
 * renamed only when the move vacates it: every file declaring it moves, and none declares a child namespace
 * that reaches its types by enclosure. The `using` directives that name it are then rewritten. A namespace that
 * stays partly in use, and fully qualified uses in code, are reported and left for a person.
 */

const declaration = /^(\s*namespace\s+)([\w.]+)(\s*[;{]?)/;
const segmentsOf = (folder: string): string[] => (folder === "." || folder === "" ? [] : folder.split("/"));
const directoryOf = (path: string): string => posix.dirname(path);

/** The namespace the move gives a namespace declared in a file that moves from one folder to another, or undefined when it does not follow its folder. */
export function namespaceAfterMove(namespace: string, from: string, to: string): string | undefined {
  const before = segmentsOf(directoryOf(from));
  const after = segmentsOf(directoryOf(to));
  let shared = 0;
  while (shared < before.length && shared < after.length && before[shared] === after[shared]) shared++;
  const leaving = before.slice(shared);
  const arriving = after.slice(shared);
  const parts = namespace.split(".");
  if (leaving.length === 0) {
    // Moving down into a folder: the namespace followed the folder it was in, and now takes the new folders too.
    const folder = before.at(-1);
    return folder !== undefined && parts.at(-1) === folder && arriving.length > 0 ? [...parts, ...arriving].join(".") : undefined;
  }
  const tail = parts.slice(parts.length - leaving.length);
  if (tail.length !== leaving.length || tail.some((part, index) => part !== leaving[index])) return undefined;
  return [...parts.slice(0, parts.length - leaving.length), ...arriving].join(".");
}

export interface NamespacePlan extends Omit<MoveResult, "confirmations"> {
  /** The namespaces renamed, old to new. */
  renamed: Record<string, string>;
}

/**
 * The text changes that make the namespaces of moved files follow their folders. `tree` holds the files after
 * the move, with `operations` saying where each moved file came from.
 */
export async function planNamespaceUpdate(tree: SourceTree, operations: readonly FileOperation[]): Promise<NamespacePlan> {
  const moved = new Map(operations.filter((operation) => operation.to.endsWith(".cs")).map((operation) => [operation.to, operation.from]));
  const sources = [...tree.files.keys()].filter((path) => path.endsWith(".cs")).sort();
  const texts = await tree.readMany(sources);
  const warnings: string[] = [];

  // Who declares each namespace, and what the moved files would call it.
  const declaredBy = new Map<string, string[]>();
  for (const path of sources) {
    for (const line of (texts.get(path) ?? "").split("\n")) {
      const found = declaration.exec(line);
      if (found !== null) declaredBy.set(found[2]!, [...(declaredBy.get(found[2]!) ?? []), path]);
    }
  }
  const proposals = new Map<string, Set<string>>();
  for (const [namespace, files] of declaredBy) {
    for (const path of files) {
      const from = moved.get(path);
      if (from === undefined) continue;
      const next = namespaceAfterMove(namespace, from, path);
      if (next === undefined) warnings.push(`${path}: namespace ${namespace} does not follow the folder ${directoryOf(from)}, so it is left alone`);
      else proposals.set(namespace, (proposals.get(namespace) ?? new Set()).add(next));
    }
  }

  const renamed = new Map<string, string>();
  for (const [namespace, options] of [...proposals].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const files = declaredBy.get(namespace)!;
    const staying = files.filter((path) => !moved.has(path));
    const children = [...declaredBy.keys()].filter((other) => other.startsWith(`${namespace}.`));
    if (options.size !== 1) warnings.push(`${namespace} would become ${[...options].sort().join(" and ")} in different files, so it is left alone`);
    else if (staying.length > 0) warnings.push(`${namespace} is still declared by ${staying.join(", ")}: its users would need a new using, so it is left alone`);
    else if (children.length > 0) warnings.push(`${namespace} encloses ${children.sort().join(", ")}, which reach its types without a using: it is left alone`);
    else renamed.set(namespace, [...options][0]!);
  }

  const changed = new Map<string, string>();
  const rewrites: Rewrite[] = [];
  for (const path of sources) {
    const lines = (texts.get(path) ?? "").split("\n");
    let touched = false;
    lines.forEach((line, index) => {
      let next = line;
      let from: string | undefined;
      let to: string | undefined;
      const declared = declaration.exec(line);
      if (declared !== null && moved.has(path) && renamed.has(declared[2]!)) {
        from = declared[2]!;
        to = renamed.get(from)!;
        next = line.replace(declaration, (_all, head: string, _name: string, tail: string) => `${head}${to}${tail}`);
      }
      next = next.replace(/^(\s*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?)([\w.]+)(\s*;)/, (all, head: string, name: string, tail: string) => {
        for (const [old, replacement] of renamed) {
          if (name !== old && !name.startsWith(`${old}.`)) continue;
          from = old;
          to = replacement;
          return `${head}${replacement}${name.slice(old.length)}${tail}`;
        }
        return all;
      });
      if (next !== line && from !== undefined && to !== undefined) {
        rewrites.push({ path, line: index + 1, from, to });
        lines[index] = next;
        touched = true;
      }
    });
    if (touched) changed.set(path, lines.join("\n"));
  }

  for (const path of sources) {
    for (const [from] of renamed) {
      const qualified = new RegExp(`(?<![\\w.])${from.replaceAll(".", "\\.")}\\.[A-Za-z_]`);
      (changed.get(path) ?? texts.get(path) ?? "").split("\n").forEach((line, index) => {
        if (qualified.test(line) && !/^\s*(?:global\s+)?using\b/.test(line) && !declaration.test(line)) warnings.push(`${path}:${index + 1} names ${from} in full, which is not rewritten`);
      });
    }
  }
  rewrites.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  return { rewrites, texts: changed, warnings, renamed: Object.fromEntries(renamed) };
}
