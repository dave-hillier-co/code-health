import { extractFacts } from "./extract-facts.ts";
import type { FileFacts, UnitKind } from "./facts.ts";
import { grammarIdForPath, loadGrammar, type GrammarId, type LoadedGrammar, type LoadOptions } from "./grammars.ts";
import type { ParseCache } from "./parse-cache.ts";
import type { SourceTree } from "./source-tree.ts";

/** A source unit as the structural layer reports it. The lexical layer reports the same shape with `source: "lexical"`. */
export interface SourceUnit {
  /** Repo-relative POSIX path. */
  path: string;
  /** Symbol id: `path#qualifiedName`. */
  id: string;
  /** Qualified name within the file, with `~n` on later duplicates. */
  qualifiedName: string;
  kind: UnitKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  source: "structural" | "lexical";
  /** Declared with `export` or listed in an export clause at module level. */
  exported: boolean;
}

export interface ImportEdge {
  from: string;
  to: string;
  kind: "import" | "reexport" | "require";
  typeOnly: boolean;
}

export type ConsumerKind = "call" | "reference" | "test";

/** Uses of one definition from one place, with barrels already followed to the definition. */
export interface Consumer {
  from: string;
  /** Qualified name of the unit the use sits in, when it is inside one. */
  fromUnit?: string;
  /** The file that defines what is used. */
  to: string;
  /** Qualified name of the used unit, when the definition is a unit. */
  toSymbol?: string;
  kind: ConsumerKind;
  count: number;
}

export interface FileEdge {
  from: string;
  to: string;
  /** `test` when the consumer is a test file, otherwise `call` when any use is a direct call. */
  kind: ConsumerKind;
  calls: number;
  references: number;
}

export type UnresolvedReason = "dynamic-import" | "not-found" | "export-not-found";

export interface Unresolved {
  from: string;
  line: number;
  specifier: string | null;
  reason: UnresolvedReason;
}

export interface ProjectAnalysis {
  units: SourceUnit[];
  /** Static import and re-export statements between files of the tree. */
  importEdges: ImportEdge[];
  consumers: Consumer[];
  /** Dependencies by defining file, with barrels followed through. */
  fileEdges: FileEdge[];
  /** Files that only re-export, each a candidate for removal. */
  barrels: string[];
  unresolved: Unresolved[];
  /** Files whose parse reported syntax errors, so their facts may be incomplete. */
  filesWithSyntaxErrors: string[];
  stats: { parsed: number; cached: number };
}

export interface AnalyseOptions extends LoadOptions {
  cache?: ParseCache;
  /** Decides which files are tests. Defaults to common naming conventions. */
  isTestPath?: (path: string) => boolean;
}

const batchSize = 200;

export async function analyseTree(tree: SourceTree, options: AnalyseOptions = {}): Promise<ProjectAnalysis> {
  const facts = new Map<string, FileFacts>();
  const stats = { parsed: 0, cached: 0 };
  const grammars = new Map<GrammarId, LoadedGrammar>();
  const pending: string[] = [];

  for (const [path, blob] of tree.files) {
    const id = grammarIdForPath(path);
    if (!id) continue;
    let grammar = grammars.get(id);
    if (!grammar) {
      grammar = await loadGrammar(id, options);
      grammars.set(id, grammar);
    }
    const cached = await options.cache?.get(blob, grammar.version);
    if (cached) {
      facts.set(path, cached);
      stats.cached++;
    } else {
      pending.push(path);
    }
  }

  for (let start = 0; start < pending.length; start += batchSize) {
    const sources = await tree.readMany(pending.slice(start, start + batchSize));
    for (const [path, source] of sources) {
      const grammar = grammars.get(grammarIdForPath(path) as GrammarId) as LoadedGrammar;
      const parsed = grammar.parse(source);
      const fileFacts = extractFacts(parsed.rootNode);
      parsed.delete();
      facts.set(path, fileFacts);
      stats.parsed++;
      await options.cache?.set(tree.files.get(path) as string, grammar.version, fileFacts);
    }
  }

  const units: SourceUnit[] = [];
  const filesWithSyntaxErrors: string[] = [];
  for (const [path, fileFacts] of facts) {
    if (fileFacts.hasSyntaxErrors) filesWithSyntaxErrors.push(path);
    const exportedLocals = new Set(fileFacts.exports.map((exported) => exported.local));
    for (const unit of fileFacts.units) {
      units.push({
        path,
        id: `${path}#${unit.qualifiedName}`,
        qualifiedName: unit.qualifiedName,
        kind: unit.kind,
        startLine: unit.startLine,
        endLine: unit.endLine,
        source: unit.source,
        exported: unit.parent === undefined && exportedLocals.has(unit.qualifiedName),
      });
    }
  }

  return {
    units,
    importEdges: [],
    consumers: [],
    fileEdges: [],
    barrels: [],
    unresolved: [],
    filesWithSyntaxErrors,
    stats,
  };
}
