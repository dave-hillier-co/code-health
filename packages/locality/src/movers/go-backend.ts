import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { Node } from "web-tree-sitter";
import type { FileFacts } from "@code-health/parse/facts";
import { GrammarSet, type LoadedGrammar } from "@code-health/parse/grammars";
import { extractFactsWithNodes } from "@code-health/parse/languages/go/extract-facts";
import { defaultPackageName, directoryToImportPath, importPathToDirectory, isGoModFile, isGoWorkFile } from "@code-health/parse/languages/go/go-mod";
import { PackageGraph } from "@code-health/parse/languages/go/resolve-packages";
import { isExported } from "@code-health/parse/languages/go/shape";
import type { SourceTree } from "@code-health/parse/source-tree";
import type { FileOperation } from "../move-plan.ts";
import type { MoveResult, MoverBackend, Rewrite, Skeleton } from "./mover-language.ts";
import { sourceFilesOf } from "./mover-language.ts";

/**
 * The Go mover (suite.md, Language notes). Moving a file within its directory changes nothing. Moving one to
 * another directory changes its package, so the move rewrites, in memory:
 *
 * - the package clause of a moved file, to the name of the package it lands in (the package already in the
 *   destination directory, or its old name when the directory has none);
 * - every reference that now crosses a package boundary, or no longer does: a bare name becomes `pkg.Name`
 *   and an import is added, `pkg.Name` becomes a bare name and an import that nothing uses any more is removed;
 * - the import path of every importer of a package whose files all moved together.
 *
 * References are the ones the adapter resolves (bare names of the package, `alias.Name`, dot imports), found
 * by the same scan the adapter extracts its facts with. A method called on a value is not followed, and a
 * name shadowed by a local declaration is not a reference, as in the adapter. A new import is put in sorted
 * place in the last group of the file's first parenthesised import, and gofmt and goimports are left to tidy
 * the result. What cannot be rewritten leaves code the compiler would reject, so it is reported as a break and the move is
 * refused, not made with a warning: an unexported name now reached from another package, a name declared in two
 * packages after the move, a folder in no module (no import path), and an import of an `internal/` package from
 * code outside its parent. The only warning is a moved file that could not be read as a source file.
 *
 * Reported rewrites are the import changes, at the line the import has in the file before the move: a path
 * changed (`from` and `to`), an import added (`from` empty) and an import removed (`to` empty).
 */

const isSource = sourceFilesOf("go");

interface Range {
  start: number;
  end: number;
}

interface Reference {
  /** The name as the adapter wrote it: `Name`, or `alias.Name`. */
  name: string;
  /** What the whole written reference covers. */
  whole: Range;
  /** `alias` of `alias.Name`, for a qualified reference. */
  head: string | null;
}

interface ImportSpec {
  path: string;
  alias: { kind: "name" | "dot" | "blank"; text: string } | null;
  range: Range;
  /** The string literal, with its quotes. */
  literal: Range;
  startRow: number;
  endRow: number;
  /** The declaration this spec is in, by index into `Parsed.declarations`. */
  declaration: number;
}

interface ImportDeclaration {
  range: Range;
  startRow: number;
  endRow: number;
  parenthesised: boolean;
  specs: number[];
}

interface Parsed {
  path: string;
  text: string;
  facts: FileFacts;
  references: Reference[];
  imports: ImportSpec[];
  declarations: ImportDeclaration[];
  packageName: Range;
  packageEnd: number;
}

interface Edit extends Range {
  text: string;
  seq: number;
}

const rangeOf = (node: Node): Range => ({ start: node.startIndex, end: node.endIndex });

function parseFile(grammar: LoadedGrammar, path: string, text: string): Parsed {
  const tree = grammar.parse(text);
  try {
    const root = tree.rootNode;
    const { facts, nodes } = extractFactsWithNodes(root);
    const references: Reference[] = [];
    (facts.symbols?.references ?? []).forEach((reference, index) => {
      const node = nodes[index]!;
      const dot = reference.name.indexOf(".");
      if (node.type === "selector_expression" || node.type === "qualified_type") references.push({ name: reference.name, whole: rangeOf(node), head: reference.name.slice(0, dot) });
      else if (dot < 0) references.push({ name: reference.name, whole: rangeOf(node), head: null });
    });
    const imports: ImportSpec[] = [];
    const declarations: ImportDeclaration[] = [];
    for (const declaration of root.namedChildren.filter((child) => child.type === "import_declaration")) {
      const specs = declaration.descendantsOfType("import_spec");
      declarations.push({
        range: rangeOf(declaration),
        startRow: declaration.startPosition.row,
        endRow: declaration.endPosition.row,
        parenthesised: declaration.descendantsOfType("import_spec_list").length > 0,
        specs: specs.map((_, index) => imports.length + index),
      });
      for (const spec of specs) {
        const literal = spec.childForFieldName("path")!;
        const alias = spec.childForFieldName("name");
        imports.push({
          path: literal.text.slice(1, -1),
          alias: alias === null ? null : { kind: alias.type === "dot" ? "dot" : alias.type === "blank_identifier" ? "blank" : "name", text: alias.text },
          range: rangeOf(spec),
          literal: rangeOf(literal),
          startRow: spec.startPosition.row,
          endRow: spec.endPosition.row,
          declaration: declarations.length - 1,
        });
      }
    }
    const clause = root.namedChildren.find((child) => child.type === "package_clause");
    const name = clause?.namedChildren[0];
    return { path, text, facts, references, imports, declarations, packageName: name === undefined ? { start: 0, end: 0 } : rangeOf(name), packageEnd: clause?.endIndex ?? 0 };
  } finally {
    tree.delete();
  }
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** Applies edits to the original text. Inserts at one place keep the order they were made in, and come before a deletion that starts there. */
function apply(text: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - a.start - (b.end - b.start) || a.seq - b.seq);
  let result = text;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const edit = ordered[i]!;
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  }
  return result;
}

const SEPARATOR = "\u0000";
const nameOfKey = (key: string): string => key.slice(key.indexOf(SEPARATOR) + 1);
const dirOfKey = (key: string): string => key.slice(0, key.indexOf(SEPARATOR));

/** The package an import path of the repository reaches. */
function reached(graph: PackageGraph, path: string): { dir: string; key: string } | undefined {
  const target = importPathToDirectory(graph.modules, path);
  if (target === undefined) return undefined;
  const found = graph.importable(target.dir);
  return found === undefined ? undefined : { dir: found.dir, key: PackageGraph.keyOf(found.dir, found.name) };
}

/** The import declaration new imports go into: the first parenthesised one, else the first. */
function insertionTarget(file: Parsed): number | undefined {
  const parenthesised = file.declarations.findIndex((declaration) => declaration.parenthesised);
  if (parenthesised >= 0) return parenthesised;
  return file.declarations.length > 0 ? 0 : undefined;
}

type Added = readonly [string, { alias: string | null; key: string }];

/** Removes an import spec with its line, and the whole declaration when it was the last in it and nothing is added to it. */
function removeSpec(file: Parsed, index: number, removed: ReadonlySet<number>, additions: boolean, cut: (range: Range) => void): void {
  const starts = lineStarts(file.text);
  const spec = file.imports[index]!;
  const declaration = file.declarations[spec.declaration]!;
  const receives = additions && spec.declaration === insertionTarget(file);
  if (receives && !declaration.parenthesised) return;
  const remaining = declaration.specs.filter((other) => !removed.has(other));
  if (remaining.length === 0 && !receives) {
    if (declaration.specs[0] !== index) return;
    // The declaration goes, with the blank line after it when one follows.
    const next = starts[declaration.endRow + 1] ?? file.text.length;
    const blank = starts[declaration.endRow + 2] !== undefined && file.text.slice(next, starts[declaration.endRow + 2]).trim() === "";
    cut({ start: starts[declaration.startRow]!, end: blank ? starts[declaration.endRow + 2]! : next });
    return;
  }
  cut({ start: starts[spec.startRow]!, end: starts[spec.endRow + 1] ?? file.text.length });
}

/** Adds the new imports in sorted place in the last group of the first parenthesised import, or makes one. */
function insertImports(file: Parsed, added: readonly Added[], removed: ReadonlySet<number>, insert: (range: Range, text: string) => void, note: (line: number, importPath: string) => void): void {
  if (added.length === 0) return;
  const starts = lineStarts(file.text);
  const written = (path: string, alias: string | null): string => `${alias === null ? "" : `${alias} `}"${path}"`;
  const target = insertionTarget(file);
  const declaration = target === undefined ? undefined : file.declarations[target];
  if (declaration?.parenthesised) {
    const specs = declaration.specs.map((index) => file.imports[index]!);
    let first = specs.length - 1;
    while (first > 0 && specs[first]!.startRow - specs[first - 1]!.endRow === 1) first--;
    const group = specs.slice(first);
    for (const [path, { alias }] of added) {
      const before = group.find((spec) => spec.path > path);
      const row = before === undefined ? (group.at(-1)?.endRow ?? declaration.endRow - 1) + 1 : before.startRow;
      const at = starts[row] ?? file.text.length;
      insert({ start: at, end: at }, `\t${written(path, alias)}\n`);
      note(row + 1, path);
    }
    return;
  }
  if (declaration !== undefined) {
    const kept = declaration.specs.filter((index) => !removed.has(index)).map((index) => ({ path: file.imports[index]!.path, text: file.text.slice(file.imports[index]!.range.start, file.imports[index]!.range.end) }));
    const entries = [...kept, ...added.map(([path, { alias }]) => ({ path, text: written(path, alias) }))].sort((a, b) => (a.path < b.path ? -1 : 1));
    insert(declaration.range, `import (\n${entries.map((entry) => `\t${entry.text}\n`).join("")})`);
    for (const [path] of added) note(declaration.startRow + 1, path);
    return;
  }
  const body = added.length === 1 ? `import ${written(added[0]![0], added[0]![1].alias)}` : `import (\n${added.map(([path, { alias }]) => `\t${written(path, alias)}\n`).join("")})`;
  insert({ start: file.packageEnd, end: file.packageEnd }, `\n\n${body}`);
  for (const [path] of added) note(1, path);
}

function lineOf(file: Parsed, index: number): number {
  return lineStarts(file.text).filter((start) => start <= index).length;
}

async function performMove(grammar: LoadedGrammar, tree: SourceTree, operations: readonly FileOperation[]): Promise<Omit<MoveResult, "confirmations">> {
  const warnings: string[] = [];
  /** What leaves the moved code not compiling: a refusal in the planner, not a warning. */
  const breaks: string[] = [];
  const moves = new Map<string, string>();
  for (const operation of operations) {
    if (!tree.files.has(operation.from)) {
      if (isSource(operation.from)) warnings.push(`${operation.from} could not be read as a source file`);
      continue;
    }
    moves.set(operation.from, operation.to);
  }
  if (![...moves].some(([from, to]) => posix.dirname(from) !== posix.dirname(to))) return { rewrites: [], texts: new Map(), warnings, breaks };

  const paths = [...tree.files.keys()].sort();
  const texts = await tree.readMany(paths.filter((path) => isSource(path) || isGoModFile(path) || isGoWorkFile(path)));
  const parsed = new Map<string, Parsed>();
  for (const path of paths.filter(isSource)) parsed.set(path, parseFile(grammar, path, texts.get(path) ?? ""));
  const configs = new Map([...texts].filter(([path]) => isGoModFile(path) || isGoWorkFile(path)));
  const graph = new PackageGraph(new Map([...parsed].map(([path, file]) => [path, file.facts])), configs);

  const dirBefore = (path: string): string => posix.dirname(path);
  const dirAfter = (path: string): string => posix.dirname(moves.get(path) ?? path);
  const pathAfter = (path: string): string => moves.get(path) ?? path;
  const crosses = (path: string): boolean => dirBefore(path) !== dirAfter(path);
  const nameBefore = (path: string): string => parsed.get(path)?.facts.symbols?.namespaces[0] ?? "";

  /** The package name a file has once the move is made: that of the package already in its new directory, else its own. */
  const nameAfter = (path: string): string => {
    const own = nameBefore(path);
    if (!crosses(path)) return own;
    const base = (name: string): string => name.replace(/_test$/, "");
    const tally = new Map<string, number>();
    const count = (candidate: string): void => {
      const name = base(nameBefore(candidate));
      tally.set(name, (tally.get(name) ?? 0) + 1);
    };
    const target = dirAfter(path);
    for (const candidate of parsed.keys()) if (!crosses(candidate) && dirBefore(candidate) === target) count(candidate);
    if (tally.size === 0) for (const candidate of [...parsed.keys()].sort()) if (crosses(candidate) && dirAfter(candidate) === target) count(candidate);
    const chosen = [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? base(own);
    return own.endsWith("_test") ? `${chosen}_test` : chosen;
  };
  const keyAfter = (path: string): string => PackageGraph.keyOf(dirAfter(path), nameAfter(path));

  // A package whose files all moved to one place is relocated: its importers change the path, not the names.
  const relocated = new Map<string, string>();
  for (const [key, pkg] of graph.packages) {
    const targets = new Set(pkg.files.map(keyAfter));
    if (targets.size === 1 && !targets.has(key)) relocated.set(key, [...targets][0]!);
  }

  const edits = new Map<string, Edit[]>();
  const rewrites: Rewrite[] = [];
  let sequence = 0;
  const edit = (path: string, range: Range, text: string): void => {
    edits.set(path, [...(edits.get(path) ?? []), { ...range, text, seq: sequence++ }]);
  };

  for (const [path, file] of parsed) {
    if (crosses(path) && nameAfter(path) !== nameBefore(path)) edit(path, file.packageName, nameAfter(path));
    const imports = graph.importsOf(path);
    const reachedBy = file.imports.map((spec) => reached(graph, spec.path));
    const plain = (index: number): boolean => reachedBy[index] !== undefined && file.imports[index]!.alias?.kind !== "blank" && file.imports[index]!.alias?.kind !== "dot";
    /** Where an import's package is once the move is made. */
    const afterKeyOfSpec = (index: number): string => relocated.get(reachedBy[index]!.key) ?? reachedBy[index]!.key;
    const localOf = (index: number): string => file.imports[index]!.alias?.text ?? nameOfKey(afterKeyOfSpec(index));
    const specOf = new Map<string, number>();
    file.imports.forEach((spec, index) => {
      if (plain(index)) specOf.set(spec.alias?.text ?? nameOfKey(reachedBy[index]!.key), index);
    });
    const used = new Set<number>();
    const stillUsed = new Set<number>();
    const added = new Map<string, { alias: string | null; key: string }>();

    for (const reference of file.references) {
      if (reference.head !== null && !imports.locals.has(reference.head)) continue;
      const found = graph.lookup(path, reference.name, imports);
      if (found === undefined) continue;
      const spec = reference.head === null ? undefined : specOf.get(reference.head);
      if (spec !== undefined) used.add(spec);
      const where = `${pathAfter(path)}:${lineOf(file, reference.whole.start)}`;
      const targets = new Set(graph.declarers(found.key, found.name).map(keyAfter));
      if (targets.size !== 1) {
        breaks.push(`${where} ${found.name} is declared in files that end up in different packages, so its references were not rewritten`);
        if (spec !== undefined) stillUsed.add(spec);
        continue;
      }
      const target = [...targets][0]!;
      const before = reference.head === null ? found.name : `${reference.head}.${found.name}`;
      let after: string;
      if (target === keyAfter(path)) after = found.name;
      else if (!isExported(found.name)) {
        breaks.push(`${where} ${found.name} is not exported and would be reached from another package`);
        if (spec !== undefined) stillUsed.add(spec);
        continue;
      } else {
        const existing = file.imports.findIndex((_, index) => plain(index) && afterKeyOfSpec(index) === target);
        if (existing >= 0) {
          stillUsed.add(existing);
          after = `${localOf(existing)}.${found.name}`;
        } else {
          const importPath = directoryToImportPath(graph.modules, dirOfKey(target));
          if (importPath === undefined) {
            breaks.push(`${where} ${dirOfKey(target)} is in no module, so it has no import path`);
            continue;
          }
          const name = nameOfKey(target);
          added.set(importPath, { alias: name === defaultPackageName(importPath) ? null : name, key: target });
          after = `${name}.${found.name}`;
        }
      }
      if (after !== before) edit(path, reference.whole, after);
    }

    // Imports: paths that moved, imports nothing uses any more, and the ones the new references need.
    const removed = new Set<number>();
    file.imports.forEach((spec, index) => {
      const found = reachedBy[index];
      if (found === undefined) return;
      if (used.has(index) && !stillUsed.has(index)) {
        removed.add(index);
        rewrites.push({ path: pathAfter(path), line: spec.startRow + 1, from: spec.path, to: "" });
        return;
      }
      const moved = relocated.get(found.key);
      if (moved === undefined || dirOfKey(moved) === found.dir) return;
      const importPath = directoryToImportPath(graph.modules, dirOfKey(moved));
      if (importPath === undefined) {
        breaks.push(`${pathAfter(path)}:${spec.startRow + 1} ${dirOfKey(moved)} is in no module, so "${spec.path}" was not rewritten`);
        return;
      }
      const quote = file.text[spec.literal.start]!;
      edit(path, spec.literal, `${quote}${importPath}${quote}`);
      rewrites.push({ path: pathAfter(path), line: spec.startRow + 1, from: spec.path, to: importPath });
    });
    const additions = [...added].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const index of removed) removeSpec(file, index, removed, additions.length > 0, (range) => edit(path, range, ""));
    insertImports(file, additions, removed, (range, text) => edit(path, range, text), (line, importPath) => rewrites.push({ path: pathAfter(path), line, from: "", to: importPath }));

    // The fixed point: an import of an internal package from outside the tree that may import it.
    if (!crosses(path) && !edits.has(path)) continue;
    const importer = directoryToImportPath(graph.modules, dirAfter(path));
    const importedAfter = [
      ...file.imports.flatMap((spec, index) => {
        const found = reachedBy[index];
        if (found === undefined || removed.has(index)) return [];
        const moved = relocated.get(found.key);
        return [moved === undefined ? spec.path : (directoryToImportPath(graph.modules, dirOfKey(moved)) ?? spec.path)];
      }),
      ...added.keys(),
    ];
    for (const importPath of importedAfter) {
      const marker = importPath.lastIndexOf("/internal");
      if (marker < 0 || !/^\/internal(\/|$)/.test(importPath.slice(marker))) continue;
      const parent = importPath.slice(0, marker);
      if (importer === undefined || (importer !== parent && !importer.startsWith(`${parent}/`))) {
        breaks.push(`${pathAfter(path)} imports ${importPath}, which only code under ${parent} may import: internal/ is a fixed point`);
      }
    }
  }

  const result = new Map<string, string>();
  for (const [path, file] of parsed) {
    const changes = edits.get(path);
    if (changes === undefined) continue;
    const text = apply(file.text, changes);
    if (text !== file.text) result.set(pathAfter(path), text);
  }
  rewrites.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)));
  return { rewrites, texts: result, warnings, breaks };
}

/** The text with each import and the package name blanked, so only what a move legitimately rewrites is left out. */
function skeleton(grammar: LoadedGrammar, text: string): Skeleton {
  const tree = grammar.parse(text);
  try {
    const root = tree.rootNode;
    const blanks: Edit[] = [];
    const specifiers: { value: string; line: number }[] = [];
    let seq = 0;
    for (const spec of root.descendantsOfType("import_spec")) {
      const literal = spec.childForFieldName("path")!;
      specifiers.push({ value: literal.text.slice(1, -1), line: literal.startPosition.row + 1 });
      blanks.push({ start: spec.startIndex, end: spec.endIndex, text: "", seq: seq++ });
    }
    const name = root.namedChildren.find((child) => child.type === "package_clause")?.namedChildren[0];
    if (name !== undefined) blanks.push({ start: name.startIndex, end: name.endIndex, text: "", seq: seq++ });
    return { text: apply(text, blanks), specifiers };
  } finally {
    tree.delete();
  }
}

/**
 * Applies the move in a scratch copy of the tree and asks `gopls check` whether the moved files still
 * type-check. Dependencies outside the repository are not fetched, so a repository that needs them reports
 * `not confirmed` with gopls' own words.
 */
async function confirm(grammar: LoadedGrammar, tree: SourceTree, operations: readonly FileOperation[], tool: { name: string; path: string }): Promise<{ status: "confirmed" | "not confirmed"; detail: string }> {
  const moved = await performMove(grammar, tree, operations);
  const directory = await mkdtemp(join(tmpdir(), "code-health-gopls-"));
  try {
    const renames = new Map(operations.map((operation) => [operation.from, operation.to]));
    const checked: string[] = [];
    for (const [path, text] of await tree.readMany([...tree.files.keys()])) {
      const target = renames.get(path) ?? path;
      const file = join(directory, target);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, moved.texts.get(target) ?? text);
      if (isSource(target) && renames.has(path)) checked.push(file);
    }
    if (checked.length === 0) return { status: "confirmed", detail: "no Go file moved" };
    const output = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn(tool.path, ["check", ...checked], { cwd: directory });
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
      child.on("error", (error) => resolve({ code: null, text: error.message }));
      child.on("close", (code) => resolve({ code, text }));
    });
    const first = output.text.trim().split("\n")[0] ?? "";
    return output.code === 0 && output.text.trim() === ""
      ? { status: "confirmed", detail: `${tool.name} check found no problem in ${checked.length} moved file${checked.length === 1 ? "" : "s"}` }
      : { status: "not confirmed", detail: `${tool.name} check reported: ${first || `exit ${output.code}`}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The backend, with the Go grammar loaded so that `skeleton`, which is synchronous, can parse. */
export async function createBackend(): Promise<MoverBackend> {
  const language = await new GrammarSet().forPath("main.go");
  if (language === undefined) throw new Error("the Go adapter is not supported here, so the Go mover has no grammar");
  const grammar = language.grammar;
  return {
    performMove: (tree, operations) => performMove(grammar, tree, operations),
    skeleton: (_path, text) => skeleton(grammar, text),
    confirm: (tree, operations, tool) => confirm(grammar, tree, operations, tool),
  };
}
