import type { FunctionBlock } from "./blocks.ts";
import { detectIndentUnit, levelOf } from "./indentation.ts";
import type { LexerProfile } from "./profile.ts";
import type { SourceLine } from "./strip.ts";

const DEFAULT_BUMP_DEPTH = 2;

const keywordPatterns = new WeakMap<LexerProfile, RegExp>();
const openerPatterns = new WeakMap<LexerProfile, RegExp>();

function keywordPattern(profile: LexerProfile): RegExp {
  let pattern = keywordPatterns.get(profile);
  if (pattern === undefined) {
    const words = `\\b(?:${profile.branchKeywords.join("|")})\\b`;
    pattern = new RegExp([words, ...profile.shortCircuitOperators].join("|"), "g");
    keywordPatterns.set(profile, pattern);
  }
  return pattern;
}

function openerPattern(profile: LexerProfile): RegExp {
  let pattern = openerPatterns.get(profile);
  if (pattern === undefined) {
    pattern = new RegExp(`\\b(?:${profile.bumpOpeners.join("|")})\\b`);
    openerPatterns.set(profile, pattern);
  }
  return pattern;
}

/**
 * Branch keywords plus short-circuit operators over lines `from` to `to`
 * (1-based, inclusive), outside strings and comments. A lexical stand-in for
 * the decision points of cyclomatic complexity, counted without the base 1.
 */
export function keywordComplexity(
  lines: SourceLine[],
  profile: LexerProfile,
  from = 1,
  to = lines.length,
): number {
  const pattern = keywordPattern(profile);
  let count = 0;
  for (let n = from; n <= to; n++) {
    const line = lines[n - 1];
    if (line === undefined || line.kind !== "code") continue;
    count += line.code.match(pattern)?.length ?? 0;
  }
  return count;
}

export interface BlockMetrics {
  /** Non-blank, non-comment lines from the header to the closing line. */
  length: number;
  /** Sum of indentation levels below the block's base over its code lines. */
  indentationComplexity: number;
  /** Deepest nesting of structures inside the block: 0 for a flat body. */
  maxNesting: number;
  keywordComplexity: number;
  /** Separate chunks of nested logic, each opened by a branch keyword. */
  bumps: number;
  /** Deepest indentation level, below the block's base, reached inside any bump. */
  bumpDepth: number;
  /** Code lines in the largest bump. */
  bumpSize: number;
}

export interface BlockMetricOptions {
  /** Levels below the base at which a run of lines counts as a bump. Default 2. */
  bumpDepth?: number;
  /** Indent unit of the file; detected when omitted. */
  indentUnit?: number;
}

export function blockMetrics(
  lines: SourceLine[],
  block: FunctionBlock,
  profile: LexerProfile,
  options: BlockMetricOptions = {},
): BlockMetrics {
  const unit = options.indentUnit ?? detectIndentUnit(lines);
  const threshold = options.bumpDepth ?? DEFAULT_BUMP_DEPTH;
  const header = lines[block.startLine - 1]!;
  const base = levelOf(header.text, unit);

  let length = 0;
  let indentationComplexity = 0;
  let maxRelative = 0;
  const codeLines: { relative: number; text: string }[] = [];
  for (let n = block.startLine; n <= block.endLine; n++) {
    const line = lines[n - 1]!;
    if (line.kind === "code" || line.kind === "literal") length++;
    if (line.kind !== "code" || line.startsInLiteral) continue;
    const relative = Math.max(0, levelOf(line.text, unit) - base);
    indentationComplexity += relative;
    if (n > block.startLine && relative > maxRelative) maxRelative = relative;
    codeLines.push({ relative, text: line.code });
  }

  return {
    length,
    indentationComplexity,
    maxNesting: Math.max(0, maxRelative - 1),
    keywordComplexity: keywordComplexity(lines, profile, block.startLine, block.endLine),
    ...findBumps(codeLines, profile, threshold),
  };
}

function findBumps(
  codeLines: { relative: number; text: string }[],
  profile: LexerProfile,
  threshold: number,
): Pick<BlockMetrics, "bumps" | "bumpDepth" | "bumpSize"> {
  const opener = openerPattern(profile);
  let bumps = 0;
  let bumpDepth = 0;
  let bumpSize = 0;
  let runSize = 0;
  let runDepth = 0;
  let state: "outside" | "bump" | "other" = "outside";

  const endRun = () => {
    if (state === "bump") {
      bumps++;
      bumpDepth = Math.max(bumpDepth, runDepth);
      bumpSize = Math.max(bumpSize, runSize);
    }
    state = "outside";
  };

  for (let i = 0; i < codeLines.length; i++) {
    const line = codeLines[i]!;
    if (line.relative < threshold) {
      endRun();
      continue;
    }
    if (state === "outside") {
      let previous = codeLines[i - 1];
      // Allman style puts the opening brace on its own line after the keyword.
      if (previous !== undefined && profile.blocks === "braces" && previous.text.trim() === "{") {
        previous = codeLines[i - 2];
      }
      state = previous !== undefined && opener.test(previous.text) ? "bump" : "other";
      runSize = 0;
      runDepth = 0;
    }
    runSize++;
    runDepth = Math.max(runDepth, line.relative);
  }
  endRun();
  return { bumps, bumpDepth, bumpSize };
}

export interface BumpyRoadGuidelines {
  /** Bumps that make a bumpy road. Default 3. */
  bumps?: number;
  /** Bumps that make one when any bump is deeper than `nesting`. Default 2. */
  deepBumps?: number;
  /** Bump depth above which fewer bumps suffice. Default 4. */
  nesting?: number;
}

export function isBumpyRoad(metrics: Pick<BlockMetrics, "bumps" | "bumpDepth">, guidelines: BumpyRoadGuidelines = {}): boolean {
  const { bumps = 3, deepBumps = 2, nesting = 4 } = guidelines;
  if (metrics.bumps >= bumps) return true;
  return metrics.bumps >= deepBumps && metrics.bumpDepth > nesting;
}
