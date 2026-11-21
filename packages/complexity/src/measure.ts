import { analyseSource, type FileAnalysis } from "@code-health/lexical/analyse-source";
import type { LengthMetrics } from "@code-health/lexical/indentation";
import { adapterForPath, isTestPath } from "@code-health/parse/languages";
import { factsForBlob } from "@code-health/parse/file-facts";
import { GrammarSet } from "@code-health/parse/grammars";
import type { ParseCache } from "@code-health/parse/parse-cache";
import type { FileFacts, UnitFact } from "@code-health/parse/facts";
import type { SourceTree } from "@code-health/parse/source-tree";
import type { UnitKind } from "@code-health/lexical/unit";
import type { ComplexitySettings } from "./config.ts";
import { structuralValues, type Values } from "./metrics.ts";

export type Layer = "auto" | "lexical" | "structural";

/** One function as either layer measured it. */
export interface UnitRecord {
  path: string;
  /** `path#Qualified.name`, with `~n` on duplicates. Lexical blocks without a name get `<anonymous@line>`. */
  id: string;
  /** The name as the layer found it, absent for an anonymous lexical block. */
  name: string | undefined;
  kind: UnitKind | "block";
  startLine: number;
  endLine: number;
  parent?: string;
  test: boolean;
  source: "structural" | "lexical";
  values: Values;
  /** Properties destructured from object parameters. Structural only. */
  optionCount?: number;
  statements?: number;
  /** Lexical blocks only. */
  bumpyRoad?: boolean;
}

/** A function or class as the interface depth signal sees it. Structural only. */
export interface InterfaceUnit {
  /** `path#Qualified.name`. */
  id: string;
  name: string;
  kind: UnitKind;
  startLine: number;
  endLine: number;
  /** Qualified name of the enclosing unit, when nested. */
  parent?: string;
  /** Exported by the file under its own name. Whether a member of a class is reachable is the class's. */
  exported: boolean;
  /** Implementation size in syntax nodes. */
  nodes: number;
  /** Parameters, or for a class its constructor parameters and reachable members; at least 1. */
  interfaceSize: number;
  /** The call the function's whole body forwards to, when it does nothing else. */
  passThrough?: string;
}

export interface FileRecord {
  path: string;
  test: boolean;
  /** The layer that measured the file's functions, or null when it has none measured. */
  source: "structural" | "lexical" | null;
  profile: string | null;
  /** The profile came from config, so nothing measures its accuracy. */
  unverified: boolean;
  lines: LengthMetrics;
  indentationComplexity: number;
  keywordComplexity?: number;
  units: UnitRecord[];
  /** Structural only: the file's functions and classes with their depth shape, and the module itself. */
  interfaces?: { units: InterfaceUnit[]; module: { nodes: number; exports: number } };
  hasSyntaxErrors: boolean;
  /** What could not be measured, and why. */
  skipped: string[];
  /** Exact-boundary agreement that released lexical per-function metrics, when they were used. */
  agreement?: { exactRate: number; spuriousRate: number; bar: number };
  /** The text, when asked for. Used to compare unit bodies. */
  text?: string;
}

export interface MeasureOptions {
  settings: ComplexitySettings;
  layer: Layer;
  cache?: ParseCache;
  /** Keep each file's text on its record. */
  keepText?: boolean;
}

export interface Measurement {
  files: FileRecord[];
  /** Files left out because they are binary or too large to be worth reading. `excluded` also counts generated files. */
  skippedFiles: { binary: number; large: number; excluded: number; tests: number };
  stats: { parsed: number; cached: number };
}

const MAX_BYTES = 1_000_000;
const BATCH = 100;

function utf8Compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Measures every text file of a tree: file-level metrics for all, functions where a layer can say. */
export async function measureTree(tree: SourceTree, options: MeasureOptions): Promise<Measurement> {
  const { settings } = options;
  const skippedFiles = { binary: 0, large: 0, excluded: 0, tests: 0 };
  const paths: string[] = [];
  for (const path of [...tree.files.keys()].sort(utf8Compare)) {
    if (settings.isExcluded(path)) skippedFiles.excluded++;
    else if (!settings.analyseTests && isTestPath(path)) skippedFiles.tests++;
    else paths.push(path);
  }

  const grammars = new GrammarSet();
  const stats = { parsed: 0, cached: 0 };
  const files: FileRecord[] = [];

  for (let start = 0; start < paths.length; start += BATCH) {
    const texts = await tree.readMany(paths.slice(start, start + BATCH));
    for (const path of paths.slice(start, start + BATCH)) {
      const text = texts.get(path);
      if (text === undefined) continue;
      if (text.length > MAX_BYTES) {
        skippedFiles.large++;
        continue;
      }
      if (text.includes("\0")) {
        skippedFiles.binary++;
        continue;
      }
      if (adapterForPath(path)?.isGeneratedSource?.(text) === true) {
        skippedFiles.excluded++;
        continue;
      }
      const lexical = analyseSource(path, text, { agreementBar: settings.agreementBar });
      const language = options.layer === "lexical" ? undefined : await grammars.forPath(path);
      let structural: { units: UnitRecord[]; interfaces: NonNullable<FileRecord["interfaces"]>; syntaxErrors: boolean } | undefined;
      if (language !== undefined) {
        const { facts, cached } = await factsForBlob(language, tree.files.get(path)!, text, options.cache);
        if (cached) stats.cached++;
        else stats.parsed++;
        structural = {
          units: structuralUnits(path, facts.units, settings),
          interfaces: interfaceUnits(path, facts),
          syntaxErrors: facts.hasSyntaxErrors,
        };
      }
      files.push(fileRecord(path, text, lexical, structural, options));
    }
  }
  return { files, skippedFiles, stats };
}

/** The units of a file for the interface depth signal, and its module. */
function interfaceUnits(path: string, facts: FileFacts): NonNullable<FileRecord["interfaces"]> {
  const exported = new Set(facts.exports.flatMap((fact) => (fact.local === undefined ? [] : [fact.local])));
  const units: InterfaceUnit[] = [];
  for (const unit of facts.units) {
    if (unit.shape === undefined) continue;
    units.push({
      id: `${path}#${unit.qualifiedName}`,
      name: unit.qualifiedName,
      kind: unit.kind,
      startLine: unit.startLine,
      endLine: unit.endLine,
      ...(unit.parent === undefined ? {} : { parent: unit.parent }),
      exported: unit.parent === undefined && exported.has(unit.qualifiedName),
      nodes: unit.shape.nodes,
      interfaceSize: unit.shape.interfaceSize,
      ...(unit.passThrough === undefined ? {} : { passThrough: unit.passThrough }),
    });
  }
  return { units, module: { nodes: facts.nodes, exports: facts.exports.length + facts.reexports.length } };
}

function structuralUnits(path: string, units: UnitFact[], settings: ComplexitySettings): UnitRecord[] {
  const test = isTestPath(path);
  const records: UnitRecord[] = [];
  for (const unit of units) {
    if (unit.metrics === undefined) continue;
    records.push({
      path,
      id: `${path}#${unit.qualifiedName}`,
      name: unit.qualifiedName,
      kind: unit.kind,
      startLine: unit.startLine,
      endLine: unit.endLine,
      ...(unit.parent === undefined ? {} : { parent: unit.parent }),
      test,
      source: "structural",
      values: structuralValues(unit.metrics, settings.cyclomaticSwitch),
      optionCount: unit.metrics.optionCount,
      statements: unit.metrics.statements,
    });
  }
  return records;
}

function fileRecord(
  path: string,
  text: string,
  lexical: FileAnalysis,
  structural: { units: UnitRecord[]; interfaces: NonNullable<FileRecord["interfaces"]>; syntaxErrors: boolean } | undefined,
  options: MeasureOptions,
): FileRecord {
  const test = isTestPath(path);
  // The lexical layer lists three things it skipped for a file with no profile; the per-function reason below covers two of them.
  const skipped = lexical.skipped.filter((reason) => reason.startsWith("comment and string stripping"));
  let units: UnitRecord[] = [];
  let source: FileRecord["source"] = null;
  let agreement: FileRecord["agreement"];

  if (structural !== undefined) {
    units = structural.units;
    source = "structural";
  } else if (options.layer === "structural") {
    skipped.push(`per-function metrics: no structural adapter for ${path}`);
  } else if (lexical.profile === null) {
    skipped.push(`per-function metrics: no lexer profile for ${path}`);
  } else if (lexical.functions.gated) {
    skipped.push(`per-function metrics: ${lexical.functions.reason}`);
  } else {
    source = "lexical";
    agreement = lexical.functions.agreement;
    units = lexical.functions.blocks.map((block) => ({
      path,
      id: `${path}#${block.qualifiedName ?? `<anonymous@${block.startLine}>`}`,
      name: block.qualifiedName,
      kind: "block",
      startLine: block.startLine,
      endLine: block.endLine,
      test,
      source: "lexical",
      values: {
        length: block.metrics.length,
        nesting: block.metrics.maxNesting,
        keyword: block.metrics.keywordComplexity,
        bumps: block.metrics.bumps,
      },
      bumpyRoad: block.bumpyRoad,
    }));
  }

  return {
    path,
    test,
    source,
    profile: lexical.profile,
    unverified: lexical.unverified,
    lines: { lineCount: lexical.file.lineCount, nonBlankLines: lexical.file.nonBlankLines, codeLines: lexical.file.codeLines },
    indentationComplexity: lexical.file.indentationComplexity,
    ...(lexical.file.keywordComplexity === undefined ? {} : { keywordComplexity: lexical.file.keywordComplexity }),
    units,
    ...(structural === undefined ? {} : { interfaces: structural.interfaces }),
    hasSyntaxErrors: structural?.syntaxErrors ?? false,
    skipped,
    ...(agreement === undefined ? {} : { agreement }),
    ...(options.keepText ? { text } : {}),
  };
}
