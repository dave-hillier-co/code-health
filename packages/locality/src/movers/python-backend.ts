import { posix } from "node:path";
import type { Node } from "web-tree-sitter";
import { analyseTree } from "@code-health/parse/analyse-tree";
import { loadGrammar, type LoadedGrammar } from "@code-health/parse/grammars";
import { adapterById } from "@code-health/parse/languages";
import { PythonResolver } from "@code-health/parse/languages/python/resolve-module";
import { treeFromTexts, type SourceTree } from "@code-health/parse/source-tree";
import type { FileOperation } from "../move-plan.ts";
import type { MoveResult, MoverBackend, Rewrite, Skeleton } from "./mover-language.ts";
import { oncePerTree, sourceFilesOf } from "./mover-language.ts";
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

/** A span of the text and what is written there. */
interface Span {
  text: string;
  start: number;
  end: number;
}

/** A name a `from ... import` imports, as written, with the name it imports and its alias. */
interface FromName {
  text: string;
  imported: string;
  alias: string | undefined;
}

/** What a move reads of one import statement or dynamic import, in the order they are written. */
type ImportSite =
  | { kind: "from"; start: number; end: number; row: number; column: number; module: Span | undefined; names: FromName[] }
  | { kind: "plain"; row: number; names: { aliased: boolean; dotted: Span | undefined }[] }
  | { kind: "dynamic"; row: number; spec: string };

/** The imports of a Python file, read once, and the attribute chains outside them, found the first time a move asks. */
interface ImportFacts {
  sites: ImportSite[];
  chains: Span[] | undefined;
}

function importSites(grammar: LoadedGrammar, text: string): ImportSite[] {
  const tree = grammar.parse(text);
  try {
    const sites: ImportSite[] = [];
    const span = (node: Node | null): Span | undefined => (node === null ? undefined : { text: node.text, start: node.startIndex, end: node.endIndex });
    const visit = (node: Node): void => {
      if (node.type === "import_from_statement") {
        const names = node.childrenForFieldName("name").map((name): FromName => {
          const aliased = name.type === "aliased_import";
          return { text: name.text, imported: (aliased ? name.childForFieldName("name") : name)?.text ?? "", alias: aliased ? name.childForFieldName("alias")?.text : undefined };
        });
        sites.push({ kind: "from", start: node.startIndex, end: node.endIndex, row: node.startPosition.row, column: node.startPosition.column, module: span(node.childForFieldName("module_name")), names });
      } else if (node.type === "import_statement") {
        const names = node.childrenForFieldName("name").map((name) => {
          const aliased = name.type === "aliased_import";
          return { aliased, dotted: span(aliased ? name.childForFieldName("name") : name) };
        });
        sites.push({ kind: "plain", row: node.startPosition.row, names });
      } else {
        if (node.type === "call") {
          const spec = dynamicSpec(node);
          if (spec !== undefined) sites.push({ kind: "dynamic", row: node.startPosition.row, spec });
        }
        for (const child of node.namedChildren) visit(child);
      }
    };
    visit(tree.rootNode);
    return sites;
  } finally {
    tree.delete();
  }
}

/** The module `importlib.import_module("a.b")` names in a string, which no import statement shows. */
function dynamicSpec(call: Node): string | undefined {
  const callee = call.childForFieldName("function")?.text;
  if (callee !== "importlib.import_module" && callee !== "import_module" && callee !== "__import__") return undefined;
  const first = call.childForFieldName("arguments")?.namedChildren[0];
  if (first?.type !== "string" || first.namedChildren.some((child) => child.type === "interpolation")) return undefined;
  return first.namedChildren.filter((child) => child.type === "string_content").map((child) => child.text).join("");
}

/** The outermost attribute chains of a file outside its import statements, in the order they are written: `a.b.c.name`, and the chains inside each. */
function attributeChains(grammar: LoadedGrammar, text: string): Span[] {
  const tree = grammar.parse(text);
  try {
    const chains: Span[] = [];
    const walk = (node: Node): void => {
      if (node.type === "import_statement" || node.type === "import_from_statement") return;
      if (node.type === "attribute" && node.parent?.type !== "attribute") chains.push({ text: node.text, start: node.startIndex, end: node.endIndex });
      for (const child of node.namedChildren) walk(child);
    };
    walk(tree.rootNode);
    return chains;
  } finally {
    tree.delete();
  }
}

/** Everything a move reads of a tree that does not depend on the move: the Python sources, their imports, and how imports resolve. */
interface PythonProject {
  paths: string[];
  python: string[];
  sources: Map<string, string>;
  before: PythonResolver;
  facts: Map<string, ImportFacts>;
}

const projectsOf = new WeakMap<LoadedGrammar, (tree: SourceTree) => Promise<PythonProject>>();
/** The project of a tree, read once for the tree (see `oncePerTree`). */
function projectOf(grammar: LoadedGrammar, tree: SourceTree): Promise<PythonProject> {
  let read = projectsOf.get(grammar);
  if (read === undefined) {
    read = oncePerTree(async (source): Promise<PythonProject> => {
      const paths = [...source.files.keys()];
      const python = paths.filter((path) => path.endsWith(".py")).sort();
      const sources = await source.readMany(python);
      const facts = new Map<string, ImportFacts>();
      for (const [path, text] of sources) if (/\bimport\b/.test(text)) facts.set(path, { sites: importSites(grammar, text), chains: undefined });
      return { paths, python, sources, before: new PythonResolver(paths), facts };
    });
    projectsOf.set(grammar, read);
  }
  return read(tree);
}

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
  private readonly project: PythonProject;
  private readonly grammar: LoadedGrammar;
  private readonly moved = new Map<string, string>();
  private readonly before: PythonResolver;
  private readonly after: PythonResolver;
  readonly rewrites: Rewrite[] = [];
  readonly warnings: string[] = [];
  readonly texts = new Map<string, string>();
  private readonly sources: ReadonlyMap<string, string>;

  constructor(project: PythonProject, grammar: LoadedGrammar, operations: readonly FileOperation[]) {
    this.project = project;
    this.grammar = grammar;
    for (const operation of operations) if (isSource(operation.from)) this.moved.set(operation.from, operation.to);
    this.sources = project.sources;
    this.before = project.before;
    this.after = new PythonResolver(project.paths.map((path) => this.moved.get(path) ?? path));
  }

  private newPath(path: string): string {
    return this.moved.get(path) ?? path;
  }

  run(): void {
    for (const path of this.project.python) {
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
    const facts = this.project.facts.get(path);
    if (facts === undefined) return text;
    const to = this.newPath(path);
    const edits: Edit[] = [];
    for (const site of facts.sites) {
      if (site.kind === "from") this.fromImport(site, path, to, edits);
      else if (site.kind === "plain") this.plainImport(site, path, to, edits, () => (facts.chains ??= attributeChains(this.grammar, text)));
      else this.dynamicImport(site, path, to);
    }
    return applyEdits(text, edits);
  }

  /** `importlib.import_module("a.b")` names a module in a string, which no import statement shows: when it names a moved file, the agent is told. */
  private dynamicImport(site: Extract<ImportSite, { kind: "dynamic" }>, from: string, to: string): void {
    const found = this.before.resolve(from, site.spec);
    if (found.kind === "file" && this.newPath(found.path) !== found.path) this.warnings.push(`${to}:${site.row + 1} "${site.spec}" is imported dynamically and names a moved module: update it by hand`);
  }

  private record(path: string, row: number, from: string, to: string): void {
    this.rewrites.push({ path, line: row + 1, from, to });
  }

  private warn(path: string, row: number, spec: string, target: string): void {
    this.warnings.push(`${path}:${row + 1} "${spec}" no longer reaches ${target} and could not be repaired`);
  }

  private fromImport(site: Extract<ImportSite, { kind: "from" }>, from: string, to: string, edits: Edit[]): void {
    const module = site.module;
    if (module === undefined) return;
    const spec = module.text;
    const found = this.before.resolve(from, spec);
    if (found.kind !== "file") return;
    const target = this.newPath(found.path);
    if (target !== found.path || to !== from) {
      const respelled = this.respell(spec, from, to, found.path, target);
      if (respelled === undefined) this.warn(to, site.row, spec, target);
      else if (respelled !== spec) {
        edits.push({ start: module.start, end: module.end, text: respelled });
        this.record(to, site.row, spec, respelled);
      }
    }
    this.movedSubmodules(site, module, from, to, found.path, edits);
  }

  /** `from pkg import sub` where `sub` is a module of `pkg` that moved elsewhere: the name is imported from where it now is. */
  private movedSubmodules(site: Extract<ImportSite, { kind: "from" }>, module: Span, from: string, to: string, init: string, edits: Edit[]): void {
    if (posix.basename(init) !== "__init__.py") return;
    // What the package defines itself: its text without the statement being repaired, which would otherwise define every name it imports.
    const initSource = this.sources.get(init) ?? "";
    const initText = from === init ? initSource.slice(0, site.start) + initSource.slice(site.end) : initSource;
    const own: string[] = [];
    const split: { alias: string; module: string; name: string }[] = [];
    for (const name of site.names) {
      const { imported, alias } = name;
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
      const spec = module.text;
      const respelled = this.respell(spec, from, to, init, packageInit);
      if (respelled === undefined) {
        this.warnings.push(`${to}:${site.row + 1} "${imported}" moved to ${target} and no import of it could be written from here`);
        own.push(name.text);
        continue;
      }
      const stem = stemOf(target);
      split.push({ module: respelled, name: stem, alias: alias ?? (stem === imported ? "" : imported) });
      this.record(to, site.row, `${spec}.${imported}`, `${respelled}.${stem}`);
    }
    if (split.length === 0) return;
    const indent = " ".repeat(site.column);
    const lines = [...(own.length === 0 ? [] : [`from ${this.currentModule(module, edits)} import ${own.join(", ")}`]), ...split.map((entry) => `from ${entry.module} import ${entry.name}${entry.alias === "" ? "" : ` as ${entry.alias}`}`)];
    // The statement is rebuilt whole: drop any module respelling already queued for it.
    for (let i = edits.length - 1; i >= 0; i--) if (edits[i]!.start >= site.start && edits[i]!.end <= site.end) edits.splice(i, 1);
    edits.push({ start: site.start, end: site.end, text: lines.join(`\n${indent}`) });
  }

  private currentModule(module: Span, edits: readonly Edit[]): string {
    return edits.find((edit) => edit.start === module.start && edit.end === module.end)?.text ?? module.text;
  }

  private plainImport(site: Extract<ImportSite, { kind: "plain" }>, from: string, to: string, edits: Edit[], chains: () => readonly Span[]): void {
    for (const { aliased, dotted } of site.names) {
      if (dotted === undefined) continue;
      const spec = dotted.text;
      const found = this.before.resolve(from, spec);
      if (found.kind !== "file") continue;
      const target = this.newPath(found.path);
      if (target === found.path && to === from) continue;
      const respelled = this.respell(spec, from, to, found.path, target);
      if (respelled === undefined) {
        this.warn(to, site.row, spec, target);
        continue;
      }
      if (respelled === spec) continue;
      edits.push({ start: dotted.start, end: dotted.end, text: respelled });
      this.record(to, site.row, spec, respelled);
      if (!aliased) this.rewriteUses(chains(), spec, respelled, edits);
    }
  }

  /**
   * `import a.b.c` binds `a` and the code writes `a.b.c.name`: every chain that starts with the old dotted name
   * starts with the new one. A chain inside one that is rewritten is left alone.
   */
  private rewriteUses(chains: readonly Span[], old: string, next: string, edits: Edit[]): void {
    let rewrittenUpTo = -1;
    for (const chain of chains) {
      if (chain.start < rewrittenUpTo) continue;
      if (chain.text === old || chain.text.startsWith(`${old}.`)) {
        edits.push({ start: chain.start, end: chain.start + old.length, text: next });
        rewrittenUpTo = chain.end;
      }
    }
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
      const move = new PythonMove(await projectOf(grammar, tree), grammar, operations);
      move.run();
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
      const ours = new PythonMove(await projectOf(grammar, tree), grammar, operations);
      ours.run();
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
