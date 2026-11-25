import { exactRate, spuriousRate, type AgreementCounts } from "./agreement.ts";
import { recordedAgreement } from "./agreement-rates.ts";
import { findFunctionBlocks, type FunctionBlock } from "./blocks.ts";
import { indentationMetrics, lengthMetrics, type IndentationMetrics, type LengthMetrics } from "./indentation.ts";
import {
  blockMetrics,
  isBumpyRoad,
  keywordComplexity,
  type BlockMetrics,
  type BumpyRoadGuidelines,
} from "./metrics.ts";
import { selectProfile } from "./profile.ts";
import { stripSource } from "./strip.ts";

/** Default minimum exact-boundary rate against the structural layer for per-function metrics to be reported. */
export const DEFAULT_AGREEMENT_BAR = 0.9;

export interface AnalyseOptions {
  /** Minimum exact-boundary agreement rate (0 to 1) for per-function metrics to be released. Defaults to 0.9. */
  agreementBar?: number;
  /** Measured agreement per profile name. Defaults to the rates recorded in the repository. */
  agreement?: Record<string, AgreementCounts>;
  /** Config mapping from file extension (no dot) to a profile name. */
  mappings?: Record<string, string>;
  bumpDepth?: number;
  bumpyRoad?: BumpyRoadGuidelines;
  /**
   * Lines of test code inside the file, such as a Rust `#[cfg(test)]` module, 1-based and inclusive. The file-level
   * metrics, `lineCount` aside, are measured over the other lines, and `testCodeLines` counts the code lines inside.
   */
  testRanges?: readonly { startLine: number; endLine: number }[];
}

export type FileMetrics = IndentationMetrics &
  LengthMetrics & {
    /** Present only when a lexer profile applies to the file. */
    keywordComplexity?: number;
    /** Code lines inside the `testRanges` that were given. Present only when some were. */
    testCodeLines?: number;
  };

export interface MeasuredBlock extends FunctionBlock {
  metrics: BlockMetrics;
  bumpyRoad: boolean;
}

export type FunctionRelease =
  | { gated: true; gate: "agreement"; reason: string; blocks: MeasuredBlock[] }
  | {
      gated: false;
      gate: "agreement";
      agreement: { exactRate: number; spuriousRate: number; bar: number };
      blocks: MeasuredBlock[];
    }
  | {
      /** A language mapped to a profile by config: nothing measures its agreement, so the values are unverified. */
      gated: false;
      gate: "config";
      blocks: MeasuredBlock[];
    };

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
   * Per-function metrics are released only where the profile's recorded agreement with the structural
   * layer clears the bar (milestone 2). While `gated` is true the blocks are computed but must not be
   * reported. When released, `agreement` carries the rates that travel with them.
   */
  functions: FunctionRelease;
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
  const ranges = options.testRanges ?? [];
  const inTests = (index: number): boolean => ranges.some((range) => range.startLine <= index + 1 && index + 1 <= range.endLine);
  const own = ranges.length === 0 ? lines : lines.filter((_, index) => !inTests(index));
  const file: FileMetrics = { ...indentationMetrics(own), ...lengthMetrics(own), lineCount: lines.length };
  if (ranges.length > 0) file.testCodeLines = lengthMetrics(lines.filter((_, index) => inTests(index))).codeLines;
  const skipped: string[] = [];
  const blocks: MeasuredBlock[] = [];

  if (profile === undefined) {
    const reason = `no lexer profile for ${path}`;
    skipped.push(`comment and string stripping: ${reason}`);
    skipped.push(`keywordComplexity: ${reason}`);
    skipped.push(`function blocks: ${reason}`);
  } else {
    file.keywordComplexity = keywordComplexity(own, profile);
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
    functions: releaseFunctions(profile?.name, selection?.mapped ?? false, blocks, options),
    skipped,
  };
}

function releaseFunctions(
  profileName: string | undefined,
  mapped: boolean,
  blocks: MeasuredBlock[],
  options: AnalyseOptions,
): FunctionRelease {
  const gated = (reason: string): FunctionRelease => ({ gated: true, gate: "agreement", reason, blocks });
  if (profileName === undefined) return gated("no lexer profile");
  if (mapped) return { gated: false, gate: "config", blocks };
  const counts = (options.agreement ?? recordedAgreement)[profileName];
  if (counts === undefined) return gated(`no agreement measured for ${profileName}`);
  const bar = options.agreementBar ?? DEFAULT_AGREEMENT_BAR;
  const rate = exactRate(counts);
  if (rate < bar) return gated(`${profileName} agreement ${rate} is below the bar ${bar}`);
  return { gated: false, gate: "agreement", agreement: { exactRate: rate, spuriousRate: spuriousRate(counts), bar }, blocks };
}
