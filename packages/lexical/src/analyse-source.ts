import { exactRate, spuriousRate, type AgreementCounts } from "./agreement.ts";
import { recordedAgreement } from "./agreement-rates.ts";
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

export type FunctionRelease =
  | { gated: true; gate: "agreement"; reason: string; blocks: MeasuredBlock[] }
  | {
      gated: false;
      gate: "agreement";
      agreement: { exactRate: number; spuriousRate: number; bar: number };
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
  if (mapped) return gated("profile mapped by config, so no agreement is measured for this language");
  const counts = (options.agreement ?? recordedAgreement)[profileName];
  if (counts === undefined) return gated(`no agreement measured for ${profileName}`);
  const bar = options.agreementBar ?? DEFAULT_AGREEMENT_BAR;
  const rate = exactRate(counts);
  if (rate < bar) return gated(`${profileName} agreement ${rate} is below the bar ${bar}`);
  return { gated: false, gate: "agreement", agreement: { exactRate: rate, spuriousRate: spuriousRate(counts), bar }, blocks };
}
