import { findFunctionBlocks, type FunctionBlock } from "./blocks.ts";
import { indentationMetrics, lengthMetrics, type IndentationMetrics, type LengthMetrics } from "./indentation.ts";
import {
  blockMetrics,
  isBumpyRoad,
  keywordComplexity,
  type BlockMetrics,
  type BumpyRoadThresholds,
} from "./metrics.ts";
import { selectProfile } from "./profile.ts";
import { stripSource } from "./strip.ts";

export interface AnalyseOptions {
  /** Config mapping from file extension (no dot) to a profile name. */
  mappings?: Record<string, string>;
  bumpDepth?: number;
  bumpyRoad?: BumpyRoadThresholds;
}

export type FileMetrics = IndentationMetrics &
  LengthMetrics & {
    /** Present only when a lexer profile applies to the file. */
    keywordComplexity?: number;
  };

export interface MeasuredBlock extends FunctionBlock {
  metrics: BlockMetrics;
  bumpyRoad: boolean;
}

export interface FileAnalysis {
  path: string;
  /** Which layer produced the values. */
  source: "lexical";
  /** Name of the lexer profile, or null when the file has none. */
  profile: string | null;
  /** True when config mapped the file's extension to a profile, so nothing measures its accuracy. */
  unverified: boolean;
  /** The shipped output of this layer. */
  file: FileMetrics;
  /**
   * Per-function metrics are computed but withheld until the agreement test
   * against the structural layer clears the bar for the language (milestone 2).
   * Consumers must not report `blocks` while `gated` is true.
   */
  functions: { gated: true; gate: "agreement"; blocks: MeasuredBlock[] };
  /** What could not be measured, and why. */
  skipped: string[];
}

/**
 * Analyses one blob's text. Takes content rather than a path on disk, so any
 * historical revision can be measured from `git show` output without checkout.
 */
export function analyseSource(path: string, content: string, options: AnalyseOptions = {}): FileAnalysis {
  const selection = selectProfile(path, options.mappings);
  const profile = selection?.profile;
  const lines = stripSource(content, profile);
  const file: FileMetrics = { ...indentationMetrics(lines), ...lengthMetrics(lines) };
  const skipped: string[] = [];
  const blocks: MeasuredBlock[] = [];

  if (profile === undefined) {
    const reason = `no lexer profile for ${path}`;
    skipped.push(`comment and string stripping: ${reason}`);
    skipped.push(`keywordComplexity: ${reason}`);
    skipped.push(`function blocks: ${reason}`);
  } else {
    file.keywordComplexity = keywordComplexity(lines, profile);
    for (const block of findFunctionBlocks(lines, profile)) {
      const metrics = blockMetrics(lines, block, profile, {
        indentUnit: file.indentUnit,
        ...(options.bumpDepth === undefined ? {} : { bumpDepth: options.bumpDepth }),
      });
      blocks.push({ ...block, metrics, bumpyRoad: isBumpyRoad(metrics, options.bumpyRoad) });
    }
  }

  return {
    path,
    source: "lexical",
    profile: profile?.name ?? null,
    unverified: selection?.mapped ?? false,
    file,
    functions: { gated: true, gate: "agreement", blocks },
    skipped,
  };
}
