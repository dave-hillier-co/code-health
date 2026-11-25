import { analyseTree } from "@code-health/parse/analyse-tree";
import { parseWith } from "@code-health/parse/file-facts";
import { GrammarSet } from "@code-health/parse/grammars";
import type { LanguageAdapter } from "@code-health/parse/language-adapter";
import { adapterById } from "@code-health/parse/languages";
import type { SourceTree } from "@code-health/parse/source-tree";
import type { FileOperation } from "../move-plan.ts";
import { confirmWithLanguageServer } from "./jvm-confirm.ts";
import { packageUnder, readHead, sourceRootOf, withImport, withPackage, type SourceHead } from "./jvm-source.ts";
import { oncePerTree, type MoveResult, type MoverBackend, type Rewrite, type Skeleton } from "./mover-language.ts";

/**
 * Moves Java and Kotlin files. A package follows its folder, so moving a file to another folder changes its
 * package, and with it everything that names the file's declarations: the package clause, the imports of the
 * files that use it, and the names the file itself used without an import because they shared its old
 * package. The mover rewrites exactly those lines and nothing else, and adds the imports that visibility
 * across packages now needs. The language server of the adapter (jdtls, Kotlin LSP) confirms the result when
 * it is installed.
 *
 * Java and Kotlin share one graph, so one backend moves files of both and rewrites references in both.
 */

const isJvm = (path: string): boolean => path.endsWith(".java") || path.endsWith(".kt");
const isKotlin = (path: string): boolean => path.endsWith(".kt");

interface Moved {
  from: string;
  to: string;
  oldPackage: string;
  newPackage: string;
  /** Top-level names the file declares, which move with it. */
  names: string[];
}

const qualified = (packageName: string, name: string): string => (packageName === "" ? name : `${packageName}.${name}`);
const packageOf = (name: string): string => (name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "");

function adaptersOf(): LanguageAdapter[] {
  return ["java", "kotlin"].map((id) => adapterById(id)).filter((adapter): adapter is LanguageAdapter => adapter !== undefined);
}

/** The Java and Kotlin sources of a tree, their package clauses and imports, and who uses what, read once for the tree (see `oncePerTree`). */
const projectOf = oncePerTree(async (tree) => {
  const adapters = adaptersOf();
  const paths = [...tree.files.keys()].filter(isJvm).sort();
  const texts = await tree.readMany(paths);
  const heads = new Map<string, SourceHead>(paths.map((path) => [path, readHead(texts.get(path) ?? "")]));
  return { paths, texts, heads, analysis: await analyseTree(tree, { adapters }) };
});

async function performMove(tree: SourceTree, operations: readonly FileOperation[]): Promise<Omit<MoveResult, "confirmations">> {
  const adapters = adaptersOf();
  const { paths, texts, heads, analysis } = await projectOf(tree);
  const warnings: string[] = [];

  // Which files move, to which package, and which names go with them.
  const grammars = new GrammarSet({ adapters });
  const moves = new Map<string, Moved>();
  for (const operation of operations) {
    const head = heads.get(operation.from);
    if (head === undefined) {
      if (isJvm(operation.from)) warnings.push(`${operation.from} could not be read as a source file`);
      continue;
    }
    const root = sourceRootOf(operation.from, head.packageName);
    const target = root === undefined ? undefined : packageUnder(root, operation.to);
    let newPackage = head.packageName;
    if (root === undefined) warnings.push(`${operation.from}: its package ${head.packageName} does not match its folder, so the package was kept`);
    else if (target === undefined) warnings.push(`${operation.to} is outside the source root of ${operation.from}, so the package ${head.packageName} was kept`);
    else if (head.packageIndex === undefined && target !== "") warnings.push(`${operation.from} has no package clause, so none was added for ${target}`);
    else newPackage = target;

    const language = await grammars.forPath(operation.from);
    const names: string[] = [];
    if (language !== undefined) {
      const facts = parseWith(language.adapter, language.grammar, texts.get(operation.from) ?? "");
      for (const declaration of facts.symbols?.declarations ?? []) {
        const local = head.packageName === "" ? declaration.name : declaration.name.slice(head.packageName.length + 1);
        if (!local.includes(".")) names.push(local);
      }
    }
    moves.set(operation.from, { from: operation.from, to: operation.to, oldPackage: head.packageName, newPackage, names });
  }

  /** Old qualified name of each top-level declaration that moves, to its new one. */
  const relocated = new Map<string, string>();
  const owner = new Map<string, Moved>();
  for (const moved of moves.values()) {
    for (const name of moved.names) {
      relocated.set(qualified(moved.oldPackage, name), qualified(moved.newPackage, name));
      owner.set(qualified(moved.oldPackage, name), moved);
    }
  }
  const relocatedPrefix = (name: string): string | undefined => {
    for (const old of relocated.keys()) if (name === old || name.startsWith(`${old}.`)) return old;
    return undefined;
  };

  const needs = new Map<string, Set<string>>();
  for (const consumer of analysis.consumers) {
    const from = moves.get(consumer.from);
    const target = moves.get(consumer.to);
    if (from === undefined && target === undefined) continue;
    if (!heads.has(consumer.from) || !heads.has(consumer.to)) continue;
    const old = relocatedPrefix(consumer.toExport);
    let top: string;
    if (old !== undefined) top = old;
    else {
      // A declaration of a file that does not move: its top-level name is the one after its package.
      const head = heads.get(consumer.to)!;
      const rest = head.packageName === "" ? consumer.toExport : consumer.toExport.slice(head.packageName.length + 1);
      top = qualified(head.packageName, rest.split(".")[0]!);
    }
    needs.set(consumer.from, (needs.get(consumer.from) ?? new Set()).add(top));
  }

  // A package-private class is out of reach once the file that uses it, or the file that declares it, leaves their package.
  const packageAfter = (path: string): string => moves.get(path)?.newPackage ?? heads.get(path)?.packageName ?? "";
  const reachable = new Set(analysis.exports.map((exported) => `${exported.defined.file}\0${exported.defined.name}`));
  const stranded = new Set<string>();
  for (const consumer of analysis.consumers) {
    if (consumer.from === consumer.to || !consumer.from.endsWith(".java") || !consumer.to.endsWith(".java")) continue;
    if (!moves.has(consumer.from) && !moves.has(consumer.to)) continue;
    const before = heads.get(consumer.from)?.packageName;
    if (before === undefined || before !== heads.get(consumer.to)?.packageName || packageAfter(consumer.from) === packageAfter(consumer.to)) continue;
    if (reachable.has(`${consumer.to}\0${consumer.toExport}`)) continue;
    const name = consumer.toExport.slice(before === "" ? 0 : before.length + 1);
    const warning = `${moves.get(consumer.from)?.to ?? consumer.from} uses ${name} of ${moves.get(consumer.to)?.to ?? consumer.to}, which is package-private in ${before} and out of reach from ${packageAfter(consumer.from) === before ? packageAfter(consumer.to) : packageAfter(consumer.from)}`;
    if (!stranded.has(warning)) {
      stranded.add(warning);
      warnings.push(warning);
    }
  }

  const rewrites: Rewrite[] = [];
  const changed = new Map<string, string>();
  const inCodeOf = new Map<string, string[]>();

  for (const path of paths) {
    const head = heads.get(path)!;
    const moved = moves.get(path);
    const lines = [...head.lines];
    const after = moved?.to ?? path;
    const newPackage = moved?.newPackage ?? head.packageName;
    const found: Rewrite[] = [];

    if (moved !== undefined && moved.newPackage !== moved.oldPackage && head.packageIndex !== undefined) {
      lines[head.packageIndex] = withPackage(lines[head.packageIndex]!, moved.newPackage);
      found.push({ path: after, line: head.packageIndex + 1, from: moved.oldPackage, to: moved.newPackage });
    }

    // Explicit imports of a declaration that moved.
    const explicit = new Set<string>();
    const wildcards = new Set<string>();
    for (const imported of head.imports) {
      const old = imported.wildcard && !imported.isStatic ? undefined : relocatedPrefix(imported.name);
      let name = imported.name;
      if (old !== undefined) {
        name = `${relocated.get(old)!}${imported.name.slice(old.length)}`;
        lines[imported.index] = withImport(lines[imported.index]!, name);
        found.push({ path: after, line: imported.index + 1, from: imported.name, to: name });
      }
      if (imported.wildcard && !imported.isStatic) wildcards.add(name);
      else explicit.add(name);
    }

    // Imports that names now need: a name that shared the old package, or came in by a wildcard of it.
    const added: string[] = [];
    for (const top of [...(needs.get(path) ?? [])].sort()) {
      const now = relocated.get(top) ?? top;
      const home = packageOf(now);
      // An import of the declaration, or of one of its members, already brings it in.
      const imported = [...explicit].some((name) => name === now || name.startsWith(`${now}.`));
      if (home === "" || home === newPackage || imported || wildcards.has(home)) continue;
      added.push(now);
    }
    const style = isKotlin(path) ? "" : ";";
    const insert = [...new Set(added)].map((name) => `import ${name}${style}`);
    if (insert.length > 0) {
      const last = head.imports.at(-1);
      let at: number;
      let block = insert;
      if (last !== undefined) at = last.index + 1;
      else if (head.packageIndex !== undefined) {
        at = head.packageIndex + 1;
        block = lines[at]?.trim() === "" ? ["", ...insert] : ["", ...insert, ""];
      } else {
        at = 0;
        block = [...insert, ""];
      }
      lines.splice(at, 0, ...block);
      const firstLine = at + block.length - insert.length;
      insert.forEach((line, offset) => found.push({ path: after, line: firstLine + offset + 1, from: "", to: line.replace(/^import /, "").replace(/;$/, "") }));
    }

    rewrites.push(...found);
    const text = lines.join("\n");
    if (text !== (texts.get(path) ?? "")) changed.set(after, text);
    inCodeOf.set(path, head.lines.slice(headEnd(head)));
  }

  // A qualified name written in code is not an import: it is left as written, and said so.
  const written = [...relocated.keys()].filter((old) => packageOf(old) !== "").map((old) => ({ old, pattern: new RegExp(`(?<![\\w.])${old.replaceAll(".", "\\.")}(?![\\w])`) }));
  for (const [path, code] of inCodeOf) {
    for (const [offset, line] of code.entries()) {
      for (const { old, pattern } of written) {
        if (pattern.test(line)) warnings.push(`${moves.get(path)?.to ?? path}:${headEnd(heads.get(path)!) + offset + 1} writes ${old} in full, which was not rewritten`);
      }
    }
  }

  rewrites.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  return { rewrites, texts: changed, warnings };
}

/** Index of the first line after the package clause and the imports. */
function headEnd(head: SourceHead): number {
  return Math.max(head.packageIndex ?? -1, head.imports.at(-1)?.index ?? -1) + 1;
}

/** The text without its package name and imports, and what those were: so a move is told from other changes by what is left. */
function skeleton(_path: string, text: string): Skeleton {
  const head = readHead(text);
  const specifiers: { value: string; line: number }[] = [];
  const drop = new Set<number>();
  const lines = [...head.lines];
  if (head.packageIndex !== undefined) {
    specifiers.push({ value: head.packageName, line: head.packageIndex + 1 });
    lines[head.packageIndex] = withPackage(lines[head.packageIndex]!, "");
  }
  const imports = head.imports.map((imported) => ({ value: `${imported.isStatic ? "static " : ""}${imported.name}${imported.wildcard ? ".*" : ""}`, line: imported.index + 1 })).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  for (const imported of head.imports) drop.add(imported.index);
  specifiers.push(...imports);
  return { text: lines.filter((_line, index) => !drop.has(index)).join("\n"), specifiers };
}

async function confirm(tree: SourceTree, operations: readonly FileOperation[], tool: { name: string; path: string }): Promise<{ status: "confirmed" | "not confirmed"; detail: string }> {
  const result = await performMove(tree, operations);
  return confirmWithLanguageServer(tree, operations, result.texts, tool);
}

export const backend: MoverBackend = { performMove, skeleton, confirm };
