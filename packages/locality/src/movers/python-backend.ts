import { posix } from "node:path";
import type { Node } from "web-tree-sitter";
import { analyseTree } from "@code-health/parse/analyse-tree";
import { loadGrammar, type LoadedGrammar } from "@code-health/parse/grammars";
import { adapterById } from "@code-health/parse/languages";
import { PythonResolver } from "@code-health/parse/languages/python/resolve-module";
import { treeFromTexts, type SourceTree } from "@code-health/parse/source-tree";
import type { FileOperation } from "../move-plan.ts";
import type { MoveResult, MoverBackend, Rewrite, Skeleton } from "./mover-language.ts";
import { sourceFilesOf } from "./mover-language.ts";
import { hasRope, moveWithRope } from "./python-rope.ts";

const isSource = sourceFilesOf("python");

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  return result;
}

const stemOf = (file: string): string => (posix.basename(file) === "__init__.py" ? posix.basename(posix.dirname(file)) : posix.basename(file, ".py"));

/** The module a file is, as a directory and a name: `a/b.py` is `a` and `b`, `a/b/__init__.py` is `a` and `b` too. */
const packageDirectoryOf = (file: string): string => (posix.basename(file) === "__init__.py" ? posix.dirname(posix.dirname(file)) : posix.dirname(file));

/**
 * Applies file moves to a Python tree in memory. Each import statement is resolved before the move, the file it
 * reaches is followed through the move, and the statement is respelled so that it reaches the same file from
 * where the importing file now is: a relative import stays relative, an absolute one stays absolute, under the
 * import root that resolved it. A respelling is checked with the resolver of the moved tree, and one that does
 * not reach the right file is reported as a warning and left as it was.
 *
 * What it does not rewrite is named in the warnings: a dotted `import a.b.c` that is not aliased also rewrites
 * the uses of `a.b.c` in the same file, but strings that name a module (`importlib.import_module`, mock
 * targets, entry point tables) are left to the agent.
 */
class PythonMove {
  private readonly tree: SourceTree;
  private readonly grammar: LoadedGrammar;
  private readonly moved = new Map<string, string>();
  private readonly before: PythonResolver;
  private readonly after: PythonResolver;
  readonly rewrites: Rewrite[] = [];
  readonly warnings: string[] = [];
  readonly texts = new Map<string, string>();
  private readonly sources = new Map<string, string>();

  constructor(tree: SourceTree, grammar: LoadedGrammar, operations: readonly FileOperation[]) {
    this.tree = tree;
    this.grammar = grammar;
    for (const operation of operations) if (isSource(operation.from)) this.moved.set(operation.from, operation.to);
    const paths = [...tree.files.keys()];
    this.before = new PythonResolver(paths);
    this.after = new PythonResolver(paths.map((path) => this.moved.get(path) ?? path));
  }

  private newPath(path: string): string {
    return this.moved.get(path) ?? path;
  }

  async run(): Promise<void> {
    const python = [...this.tree.files.keys()].filter((path) => path.endsWith(".py")).sort();
    for (const [path, text] of await this.tree.readMany(python)) this.sources.set(path, text);
    for (const path of python) {
      const text = this.sources.get(path)!;
      const edited = this.rewriteFile(path, text);
      const target = this.newPath(path);
      if (edited !== text) this.texts.set(target, edited);
    }
    this.rewrites.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  }

  /** The import root under which `spec` reached `file` before the move. */
  private rootOfSpec(from: string, spec: string, file: string): string | undefined {
    const own = this.before.rootOf(posix.dirname(from));
    return [own, ...this.before.roots.filter((root) => root !== own)].find((root) => this.before.moduleName(file, root) === spec);
  }

  /** `spec` rewritten to reach `target` (after the move) from `to` (where the importing file is after the move), or undefined when no spelling reaches it. */
  private respell(spec: string, from: string, to: string, oldTarget: string, target: string): string | undefined {
    const reaches = (candidate: string): boolean => {
      const found = this.after.resolve(to, candidate);
      return found.kind === "file" && found.path === target;
    };
    if (spec.startsWith(".")) {
      const fromParts = posix.dirname(to) === "." ? [] : posix.dirname(to).split("/");
      const packageDir = posix.basename(target) === "__init__.py" ? posix.dirname(target) : posix.dirname(target);
      const targetParts = packageDir === "." ? [] : packageDir.split("/");
      let common = 0;
      while (common < fromParts.length && common < targetParts.length && fromParts[common] === targetParts[common]) common++;
      const rest = targetParts.slice(common);
      if (posix.basename(target) !== "__init__.py") rest.push(posix.basename(target, ".py"));
      const candidate = `${".".repeat(fromParts.length - common + 1)}${rest.join(".")}`;
      if (reaches(candidate)) return candidate;
    } else {
      const old = this.rootOfSpec(from, spec, oldTarget);
      const own = this.after.rootOf(posix.dirname(to));
      const targetRoot = this.after.rootOf(posix.dirname(target));
      for (const root of [...new Set([old, own, targetRoot, "."].filter((candidate): candidate is string => candidate !== undefined))]) {
        const name = this.after.moduleName(target, root);
        if (name !== undefined && reaches(name)) return name;
      }
    }
    return undefined;
  }

  private rewriteFile(path: string, text: string): string {
    if (!/\bimport\b/.test(text)) return text;
    const tree = this.grammar.parse(text);
    try {
      const to = this.newPath(path);
      const edits: Edit[] = [];
      const visit = (node: Node): void => {
        if (node.type === "import_from_statement") this.fromImport(node, path, to, edits);
        else if (node.type === "import_statement") this.plainImport(node, path, to, edits, tree.rootNode);
        else {
          if (node.type === "call") this.dynamicImport(node, path, to);
          for (const child of node.namedChildren) visit(child);
        }
      };
      visit(tree.rootNode);
      return applyEdits(text, edits);
    } finally {
      tree.delete();
    }
  }

  /** `importlib.import_module("a.b")` names a module in a string, which no import statement shows: when it names a moved file, the agent is told. */
  private dynamicImport(call: Node, from: string, to: string): void {
    const callee = call.childForFieldName("function")?.text;
    if (callee !== "importlib.import_module" && callee !== "import_module" && callee !== "__import__") return;
    const first = call.childForFieldName("arguments")?.namedChildren[0];
    if (first?.type !== "string" || first.namedChildren.some((child) => child.type === "interpolation")) return;
    const spec = first.namedChildren.filter((child) => child.type === "string_content").map((child) => child.text).join("");
    const found = this.before.resolve(from, spec);
    if (found.kind === "file" && this.newPath(found.path) !== found.path) this.warnings.push(`${to}:${call.startPosition.row + 1} "${spec}" is imported dynamically and names a moved module: update it by hand`);
  }

  private record(path: string, node: Node, from: string, to: string): void {
    this.rewrites.push({ path, line: node.startPosition.row + 1, from, to });
  }

  private warn(path: string, node: Node, spec: string, target: string): void {
    this.warnings.push(`${path}:${node.startPosition.row + 1} "${spec}" no longer reaches ${target} and could not be repaired`);
  }

  private fromImport(node: Node, from: string, to: string, edits: Edit[]): void {
    const module = node.childForFieldName("module_name");
    if (module === null) return;
    const spec = module.text;
    const found = this.before.resolve(from, spec);
    if (found.kind !== "file") return;
    const target = this.newPath(found.path);
    if (target !== found.path || to !== from) {
      const respelled = this.respell(spec, from, to, found.path, target);
      if (respelled === undefined) this.warn(to, node, spec, target);
      else if (respelled !== spec) {
        edits.push({ start: module.startIndex, end: module.endIndex, text: respelled });
        this.record(to, node, spec, respelled);
      }
    }
    this.movedSubmodules(node, from, to, found.path, edits);
  }

  /** `from pkg import sub` where `sub` is a module of `pkg` that moved elsewhere: the name is imported from where it now is. */
  private movedSubmodules(node: Node, from: string, to: string, init: string, edits: Edit[]): void {
    if (posix.basename(init) !== "__init__.py") return;
    // What the package defines itself: its text without the statement being repaired, which would otherwise define every name it imports.
    const initSource = this.sources.get(init) ?? "";
    const initText = from === init ? initSource.slice(0, node.startIndex) + initSource.slice(node.endIndex) : initSource;
    const own: string[] = [];
    const split: { alias: string; module: string; name: string }[] = [];
    for (const name of node.childrenForFieldName("name")) {
      const aliased = name.type === "aliased_import";
      const imported = (aliased ? name.childForFieldName("name") : name)?.text ?? "";
      const alias = aliased ? name.childForFieldName("alias")?.text : undefined;
      const definedHere = new RegExp(`^(?:def|class)\\s+${imported}\\b|^${imported}\\s*[:=]|^\\s*(?:from\\s+\\S+\\s+)?import\\s+.*\\b${imported}\\b`, "m").test(initText);
      const sub = definedHere ? undefined : this.before.submodule(init, imported);
      if (sub === undefined) {
        own.push(name.text);
        continue;
      }
      const target = this.newPath(sub);
      const initAfter = this.newPath(init);
      if (target === sub && initAfter === init) {
        own.push(name.text);
        continue;
      }
      const stillThere = this.after.submodule(initAfter, imported);
      if (stillThere === target) {
        own.push(name.text);
        continue;
      }
      const directory = packageDirectoryOf(target);
      const packageInit = directory === "." ? "__init__.py" : `${directory}/__init__.py`;
      const spec = node.childForFieldName("module_name")!.text;
      const respelled = this.respell(spec, from, to, init, packageInit);
      if (respelled === undefined) {
        this.warnings.push(`${to}:${node.startPosition.row + 1} "${imported}" moved to ${target} and no import of it could be written from here`);
        own.push(name.text);
        continue;
      }
      const stem = stemOf(target);
      split.push({ module: respelled, name: stem, alias: alias ?? (stem === imported ? "" : imported) });
      this.record(to, node, `${spec}.${imported}`, `${respelled}.${stem}`);
    }
    if (split.length === 0) return;
    const indent = " ".repeat(node.startPosition.column);
    const module = node.childForFieldName("module_name")!;
    const lines = [...(own.length === 0 ? [] : [`from ${this.currentModule(module, edits)} import ${own.join(", ")}`]), ...split.map((entry) => `from ${entry.module} import ${entry.name}${entry.alias === "" ? "" : ` as ${entry.alias}`}`)];
    // The statement is rebuilt whole: drop any module respelling already queued for it.
    for (let i = edits.length - 1; i >= 0; i--) if (edits[i]!.start >= node.startIndex && edits[i]!.end <= node.endIndex) edits.splice(i, 1);
    edits.push({ start: node.startIndex, end: node.endIndex, text: lines.join(`\n${indent}`) });
  }

  private currentModule(module: Node, edits: readonly Edit[]): string {
    return edits.find((edit) => edit.start === module.startIndex && edit.end === module.endIndex)?.text ?? module.text;
  }

  private plainImport(node: Node, from: string, to: string, edits: Edit[], root: Node): void {
    for (const name of node.childrenForFieldName("name")) {
      const aliased = name.type === "aliased_import";
      const dotted = aliased ? name.childForFieldName("name") : name;
      if (dotted === null) continue;
      const spec = dotted.text;
      const found = this.before.resolve(from, spec);
      if (found.kind !== "file") continue;
      const target = this.newPath(found.path);
      if (target === found.path && to === from) continue;
      const respelled = this.respell(spec, from, to, found.path, target);
      if (respelled === undefined) {
        this.warn(to, node, spec, target);
        continue;
      }
      if (respelled === spec) continue;
      edits.push({ start: dotted.startIndex, end: dotted.endIndex, text: respelled });
      this.record(to, node, spec, respelled);
      if (!aliased) this.rewriteUses(root, spec, respelled, edits);
    }
  }

  /** `import a.b.c` binds `a` and the code writes `a.b.c.name`: every chain that starts with the old dotted name starts with the new one. */
  private rewriteUses(root: Node, old: string, next: string, edits: Edit[]): void {
    const walk = (node: Node): void => {
      if (node.type === "import_statement" || node.type === "import_from_statement") return;
      if (node.type === "attribute" && node.parent?.type !== "attribute") {
        const text = node.text;
        if (text === old || text.startsWith(`${old}.`)) {
          edits.push({ start: node.startIndex, end: node.startIndex + old.length, text: next });
          return;
        }
      }
      for (const child of node.namedChildren) walk(child);
    };
    walk(root);
  }
}

/** The text with each import's module name blanked, so only what is not an import path remains. */
function skeletonOf(grammar: LoadedGrammar, text: string): Skeleton {
  const tree = grammar.parse(text);
  try {
    const specifiers: { value: string; line: number; start: number; end: number }[] = [];
    const walk = (node: Node): void => {
      if (node.type === "import_from_statement") {
        const module = node.childForFieldName("module_name");
        if (module !== null) specifiers.push({ value: module.text, line: module.startPosition.row + 1, start: module.startIndex, end: module.endIndex });
        return;
      }
      if (node.type === "import_statement") {
        for (const name of node.childrenForFieldName("name")) {
          const dotted = name.type === "aliased_import" ? name.childForFieldName("name") : name;
          if (dotted !== null) specifiers.push({ value: dotted.text, line: dotted.startPosition.row + 1, start: dotted.startIndex, end: dotted.endIndex });
        }
        return;
      }
      for (const child of node.namedChildren) walk(child);
    };
    walk(tree.rootNode);
    let blanked = text;
    for (const specifier of [...specifiers].reverse()) blanked = `${blanked.slice(0, specifier.start)}${blanked.slice(specifier.end)}`;
    return { text: blanked, specifiers: specifiers.map(({ value, line }) => ({ value, line })) };
  } finally {
    tree.delete();
  }
}

/** Loads the Python grammar the mover reads imports with, once, and returns the backend. */
export async function load(): Promise<MoverBackend> {
  const grammar = await loadGrammar("python");
  return {
    async performMove(tree: SourceTree, operations: readonly FileOperation[]): Promise<Omit<MoveResult, "confirmations">> {
      const move = new PythonMove(tree, grammar, operations);
      await move.run();
      return { rewrites: move.rewrites, texts: move.texts, warnings: move.warnings };
    },
    skeleton: (_path, text) => skeletonOf(grammar, text),
    /**
     * Rope makes the same move on a copy, and the two results are compared by what each import reaches: the
     * import edges of the analysed trees. Spelling is not compared, because rope writes imports its own way.
     */
    async confirm(tree, operations, tool) {
      if (!(await hasRope(tool.path))) return { status: "not confirmed", detail: `rope is not installed for ${tool.path}, so references were not confirmed` };
      const python = [...tree.files.keys()].filter((path) => path.endsWith(".py"));
      const originals = await tree.readMany(python);
      const moved = new Map(operations.map((operation) => [operation.from, operation.to]));
      const ours = new PythonMove(tree, grammar, operations);
      await ours.run();
      const mine: Record<string, string> = {};
      for (const [path, text] of originals) mine[moved.get(path) ?? path] = ours.texts.get(moved.get(path) ?? path) ?? text;
      const theirs = await moveWithRope(tool.path, originals, operations);
      if ("error" in theirs) return { status: "not confirmed", detail: theirs.error };
      const adapters = [adapterById("python")!];
      const edges = async (texts: Readonly<Record<string, string>>): Promise<string[]> => (await analyseTree(treeFromTexts(texts), { adapters })).importEdges.map((edge) => `${edge.from} -> ${edge.to}`);
      const wanted = await edges(Object.fromEntries(theirs.texts));
      const actual = await edges(mine);
      const differing = [...new Set([...wanted.filter((edge) => !actual.includes(edge)), ...actual.filter((edge) => !wanted.includes(edge))])].sort();
      return differing.length === 0
        ? { status: "confirmed", detail: "rope made the same move and every import reaches the same file" }
        : { status: "not confirmed", detail: `rope and the move differ on: ${differing.join("; ")}` };
    },
  };
}
