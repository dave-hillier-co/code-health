import type { SourceLine } from "./strip.ts";

const DEFAULT_UNIT = 4;
const MAX_UNIT = 8;

/**
 * Lines whose indentation is meaningful: code only. Comment lines and lines that
 * begin inside a multi-line string are left out. Without a profile every
 * non-blank line is code, because comments cannot be told apart.
 */
export function isIndentLine(line: SourceLine): boolean {
  return line.kind === "code" && !line.startsInLiteral;
}

/**
 * The number of spaces that make one logical level, taken as the most common
 * increase in space indentation between consecutive lines, smallest on a tie.
 * Tab-indented lines do not vote: a tab is one level by definition.
 */
export function detectIndentUnit(lines: SourceLine[]): number {
  const votes = new Map<number, number>();
  let previous = 0;
  for (const line of lines) {
    if (!isIndentLine(line)) continue;
    if (line.text.startsWith("\t")) {
      previous = 0;
      continue;
    }
    const width = leadingSpaces(line.text);
    const increase = width - previous;
    if (increase > 0 && increase <= MAX_UNIT) votes.set(increase, (votes.get(increase) ?? 0) + 1);
    previous = width;
  }
  let best = DEFAULT_UNIT;
  let bestVotes = 0;
  for (const [unit, count] of [...votes].sort((a, b) => a[0] - b[0])) {
    if (count > bestVotes) {
      best = unit;
      bestVotes = count;
    }
  }
  return best;
}

function leadingSpaces(text: string): number {
  let width = 0;
  while (text[width] === " ") width++;
  return width;
}

/** Logical indentation level: each leading tab is one level, spaces are divided by the unit. */
export function levelOf(text: string, unit: number): number {
  let tabs = 0;
  while (text[tabs] === "\t") tabs++;
  let spaces = 0;
  while (text[tabs + spaces] === " ") spaces++;
  return tabs + Math.floor(spaces / unit);
}

export interface IndentationMetrics {
  /** Spaces per logical level that were detected (4 when the file gives no evidence). */
  indentUnit: number;
  /** Sum of logical indentation levels over code lines. */
  indentationComplexity: number;
  /** Deepest logical indentation of any code line, relative to the file's left margin. */
  maxIndent: number;
}

export function indentationMetrics(lines: SourceLine[]): IndentationMetrics {
  const indentUnit = detectIndentUnit(lines);
  let indentationComplexity = 0;
  let maxIndent = 0;
  for (const line of lines) {
    if (!isIndentLine(line)) continue;
    const level = levelOf(line.text, indentUnit);
    indentationComplexity += level;
    if (level > maxIndent) maxIndent = level;
  }
  return { indentUnit, indentationComplexity, maxIndent };
}

export interface LengthMetrics {
  lineCount: number;
  nonBlankLines: number;
  /** Non-blank, non-comment lines. */
  codeLines: number;
}

export function lengthMetrics(lines: SourceLine[]): LengthMetrics {
  let nonBlankLines = 0;
  let codeLines = 0;
  for (const line of lines) {
    if (line.kind !== "blank") nonBlankLines++;
    if (line.kind === "code" || line.kind === "literal") codeLines++;
  }
  return { lineCount: lines.length, nonBlankLines, codeLines };
}
