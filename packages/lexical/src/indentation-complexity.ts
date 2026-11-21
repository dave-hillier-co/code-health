/** Indent unit assumed when a file shows no space indentation to learn it from. */
const DEFAULT_UNIT = 4;

const isBlank = (line: string) => line.trim() === "";

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

/** Columns of leading whitespace, counting a tab as one unit. Tabs and spaces may mix. */
function indentWidth(line: string, unit: number): number {
  let width = 0;
  for (const ch of leadingWhitespace(line)) width += ch === "\t" ? unit : 1;
  return width;
}

/**
 * The number of spaces that make one indentation level in a file: the most
 * common positive step up in space indentation between consecutive non-blank
 * lines, the smaller step winning a tie. Files that never step up in spaces
 * (tab indented or flat) get a default, which does not matter for them.
 */
export function detectIndentUnit(lines: readonly string[]): number {
  const steps = new Map<number, number>();
  let previous = 0;
  for (const line of lines) {
    if (isBlank(line)) continue;
    const spaces = leadingWhitespace(line).replaceAll("\t", "").length;
    if (spaces > previous) steps.set(spaces - previous, (steps.get(spaces - previous) ?? 0) + 1);
    previous = spaces;
  }
  let best = DEFAULT_UNIT;
  let bestCount = 0;
  for (const [step, count] of steps) {
    if (count > bestCount || (count === bestCount && step < best)) {
      best = step;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Indentation complexity of a file: the sum of logical indentation levels over
 * its non-blank lines, with tabs and spaces normalised by the file's own
 * indent unit. Language-agnostic and parser-free. Comment lines are left in
 * until a lexer profile can identify them.
 */
export function indentationComplexity(text: string): number {
  const lines = text.split(/\r?\n/);
  const unit = detectIndentUnit(lines);
  let total = 0;
  for (const line of lines) {
    if (isBlank(line)) continue;
    total += Math.floor(indentWidth(line, unit) / unit);
  }
  return total;
}
