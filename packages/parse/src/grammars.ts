import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";
import type { GrammarSpec, LanguageAdapter } from "./language-adapter.ts";
import { bindingForPath, declaredSupportedAdapters, grammarSpecById } from "./languages.ts";

export type { GrammarSpec } from "./language-adapter.ts";
export type GrammarId = string;

/**
 * The grammars a parsing plugin ships: those of every supported adapter, once each, in id order. A plugin
 * ships all of them and loads only the ones the analysed repository has files for (see `GrammarSet`).
 */
export function shippedGrammarSpecs(): GrammarSpec[] {
  const specs = new Map<string, GrammarSpec>();
  for (const adapter of declaredSupportedAdapters()) for (const binding of adapter.grammars) specs.set(binding.spec.id, binding.spec);
  return [...specs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The tree-sitter runtime itself, shipped beside the grammars. */
export const runtimeSpec = { packageName: "web-tree-sitter", file: "web-tree-sitter.wasm" } as const;

/** The grammar that parses a path, when a supported adapter claims its extension. */
export function grammarIdForPath(path: string): GrammarId | undefined {
  return bindingForPath(path)?.binding.spec.id;
}

export interface LoadedGrammar {
  id: GrammarId;
  /**
   * Identifies the grammar and runtime that produce a tree. Derived from the
   * bytes of the .wasm files, so it is always available once bundled (no
   * package.json to read) and cannot drift from the files actually loaded.
   */
  version: string;
  /** Caller owns the tree and must call `delete()` on it. */
  parse(source: string): Tree;
}

export interface LoadOptions {
  /** Directory holding the .wasm files. Defaults to `grammars/` beside this module, then the npm packages. */
  grammarDir?: string;
}

const require = createRequire(import.meta.url);
const loaded = new Map<string, Promise<LoadedGrammar>>();
let runtimeInit: Promise<void> | undefined;

/**
 * Finds a .wasm file. Bundled, the file sits in `grammars/` next to the
 * bundle, resolved from `import.meta.url`. From source, it falls back to the
 * npm package that ships it.
 */
function locate(file: string, packageName: string, grammarDir: string | undefined): string {
  if (grammarDir !== undefined) {
    const explicit = join(grammarDir, file);
    if (!existsSync(explicit)) throw new Error(`Grammar file not found: ${explicit}`);
    return explicit;
  }
  const bundled = fileURLToPath(new URL(`./grammars/${file}`, import.meta.url));
  if (existsSync(bundled)) return bundled;
  try {
    return require.resolve(`${packageName}/${file}`);
  } catch {
    throw new Error(`Grammar file ${file} not found beside ${bundled} or in the ${packageName} package`);
  }
}

export function locateGrammarFile(spec: { packageName: string; file: string }): string {
  return locate(spec.file, spec.packageName, undefined);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/**
 * Initialises the runtime once per process. The runtime is the same whichever
 * directory the grammars come from, so the first caller's location wins.
 */
function initRuntime(path: string): Promise<void> {
  runtimeInit ??= Parser.init({ locateFile: () => path });
  return runtimeInit;
}

/** Loads a grammar by id from any registered adapter, supported or not. */
export function loadGrammar(id: GrammarId, options: LoadOptions = {}): Promise<LoadedGrammar> {
  const spec = grammarSpecById(id);
  if (!spec) return Promise.reject(new Error(`Unknown grammar: ${id}`));
  return loadSpec(spec, options);
}

export function loadSpec(spec: GrammarSpec, options: LoadOptions = {}): Promise<LoadedGrammar> {
  const key = `${options.grammarDir ?? ""}\0${spec.id}`;
  let grammar = loaded.get(key);
  if (!grammar) {
    grammar = load(spec, options.grammarDir);
    loaded.set(key, grammar);
  }
  return grammar;
}

async function load(spec: GrammarSpec, grammarDir: string | undefined): Promise<LoadedGrammar> {
  const id = spec.id;
  const path = locate(spec.file, spec.packageName, grammarDir);
  const runtimePath = locate(runtimeSpec.file, runtimeSpec.packageName, grammarDir);
  const bytes = readFileSync(path);
  await initRuntime(runtimePath);
  const language = await Language.load(new Uint8Array(bytes));
  const parser = new Parser();
  parser.setLanguage(language);
  return {
    id,
    version: `${id}-${hash(bytes)}+runtime-${hash(readFileSync(runtimePath))}`,
    parse(source) {
      const tree = parser.parse(source);
      if (!tree) throw new Error(`Parsing failed for grammar ${id}`);
      if (spec.repairs === undefined || !tree.rootNode.hasError) return tree;
      return repaired(parser, tree, source, spec.repairs);
    },
  };
}

/** How many times a tree is repaired and parsed again: each pass removes the errors it found, nested ones surface on the next. */
const repairPasses = 4;

/**
 * Error and missing nodes in a tree. A missing node that is hidden (an external token the grammar does not
 * list among a node's children) is seen only as `hasError` on its parent, so a node that has an error and no
 * child with one counts once.
 */
function errorCount(node: Node): number {
  if (node.isMissing || node.type === "ERROR") return 1;
  if (!node.hasError) return 0;
  let count = 0;
  for (const child of node.children) count += errorCount(child);
  return Math.max(count, 1);
}

/** The tree of the repaired text when it has fewer errors than the original, otherwise the original. Caller owns the result. */
function repaired(parser: Parser, original: Tree, source: string, repairs: NonNullable<GrammarSpec["repairs"]>): Tree {
  let best = original;
  let text = source;
  for (let pass = 0; pass < repairPasses && best.rootNode.hasError; pass++) {
    const edits = repairs(best.rootNode, text);
    if (edits.length === 0) break;
    for (const { offset, character } of edits) text = `${text.slice(0, offset)}${character}${text.slice(offset + 1)}`;
    const next = parser.parse(text);
    if (!next) break;
    if (errorCount(next.rootNode) < errorCount(best.rootNode)) {
      if (best !== original) best.delete();
      best = next;
    } else {
      next.delete();
      break;
    }
  }
  if (best !== original) original.delete();
  return best;
}

/** The parse cache key of facts an adapter extracted from a tree of this grammar: changed extraction never reads old facts. */
export function cacheKeyOf(adapter: Pick<LanguageAdapter, "id" | "extractorVersion">, grammar: Pick<LoadedGrammar, "version">): string {
  return `${grammar.version}.${adapter.id}-extract-${adapter.extractorVersion}`;
}

/**
 * The grammars of one analysis, loaded when a file needs them. A repository with no Python never loads the
 * Python grammar, however many grammars the plugin ships.
 */
export class GrammarSet {
  private readonly options: LoadOptions;
  private readonly adapters: readonly LanguageAdapter[] | undefined;
  private readonly grammars = new Map<GrammarId, LoadedGrammar>();

  /** `adapters` defaults to the supported ones; conformance tests pass the adapter under test. */
  constructor(options: LoadOptions & { adapters?: readonly LanguageAdapter[] } = {}) {
    this.options = options.grammarDir === undefined ? {} : { grammarDir: options.grammarDir };
    this.adapters = options.adapters;
  }

  /** The adapter and loaded grammar for a path, or undefined when no adapter claims its extension. */
  async forPath(path: string): Promise<{ adapter: LanguageAdapter; grammar: LoadedGrammar } | undefined> {
    const found = bindingForPath(path, this.adapters);
    if (found === undefined) return undefined;
    let grammar = this.grammars.get(found.binding.spec.id);
    if (grammar === undefined) {
      grammar = await loadSpec(found.binding.spec, this.options);
      this.grammars.set(found.binding.spec.id, grammar);
    }
    return { adapter: found.adapter, grammar };
  }

  /** Ids of the grammars loaded so far, sorted. */
  loaded(): string[] {
    return [...this.grammars.keys()].sort();
  }
}
