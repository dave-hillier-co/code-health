import type { Node } from "web-tree-sitter";

/**
 * The TypeScript grammar rejects two valid constructs, because it reserves words the language only treats
 * as keywords in some positions:
 *
 * - a tuple member labelled with a type keyword or a reserved word: `[specifier: string, symbol: string]`;
 * - a statement that starts with the identifier `abstract`, `as` or `satisfies`: `abstract++;`.
 *
 * `typescriptRepairOffsets` finds them from the error nodes of a tree. Each offset is the first character of
 * such a word; the grammar loader overwrites it with `_` (same length, so every position stays the same) and
 * parses again. Only error nodes are inspected, so a string or comment is never touched, and a file with a
 * real syntax error keeps its error.
 */
const labelWords = new Set([
  "string", "number", "boolean", "object", "any", "never", "void", "unknown", "undefined", "null", "symbol", "bigint",
  "this", "readonly", "keyof", "new", "typeof", "unique", "infer", "asserts", "is",
]);
const statementWords = new Set(["abstract", "as", "satisfies"]);
const afterStatementWord = /^\s*(\+\+|--|[-+*/%&|^]?=|\*\*=|\.|\(|\[|,|;|\)|$)/;

export function typescriptRepairOffsets(root: Node, source: string): number[] {
  const offsets = new Set<number>();
  const visit = (node: Node): void => {
    if (!node.hasError) return;
    if (node.type === "ERROR") {
      const start = node.startIndex;
      const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(start, start + 20))?.[0];
      if (word !== undefined) {
        const rest = source.slice(start + word.length, start + word.length + 20);
        const before = source.slice(0, start).trimEnd().slice(-1);
        if (labelWords.has(word) && /^\s*\??\s*:/.test(rest) && (before === "[" || before === ",")) offsets.add(start);
        else if (statementWords.has(word) && afterStatementWord.test(rest)) offsets.add(start);
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return [...offsets].sort((a, b) => a - b);
}
