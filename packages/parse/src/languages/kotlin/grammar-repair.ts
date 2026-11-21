import type { Node } from "web-tree-sitter";
import type { SourceRepair } from "../../language-adapter.ts";

/**
 * The Kotlin grammar wants a newline or a semicolon after the last member of a body, so a body that ends
 * on the line of its member, `class A { val x = 1 }` or `companion object { fun make() = A() }`, parses
 * with a missing member separator. One of them is recovered, but two in a file can lose the whole file to
 * an error node.
 *
 * A semicolon before a closing brace is always valid Kotlin, so the space between the last token of a line
 * and a `}` that follows it on the same line is overwritten with `;`. That keeps every position where it was.
 * Strings, character literals and comments are skipped, so their text is never changed. The loader keeps the
 * repaired tree only when it has fewer errors, and the repair only runs for a file that has some.
 */
export function kotlinRepairs(_root: Node, source: string): SourceRepair[] {
  const repairs: SourceRepair[] = [];
  let lastTokenOnLine = -1;
  let index = 0;
  const skipTo = (end: number): void => {
    lastTokenOnLine = end - 1;
    index = end;
  };
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\n") {
      lastTokenOnLine = -1;
      index++;
    } else if (char === " " || char === "\t" || char === "\r") {
      index++;
    } else if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      // A comment ending a line leaves the line's last token where it was.
      index = stop;
    } else if (source.startsWith('"""', index)) {
      const end = source.indexOf('"""', index + 3);
      skipTo(end < 0 ? source.length : end + 3);
    } else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < source.length && source[end] !== char && source[end] !== "\n") end += source[end] === "\\" ? 2 : 1;
      skipTo(Math.min(end + 1, source.length));
    } else {
      if (char === "}" && lastTokenOnLine >= 0 && index - 1 > lastTokenOnLine && /[ \t]/.test(source[index - 1]!)) {
        const before = source[lastTokenOnLine]!;
        if (before !== "{" && before !== ";") repairs.push({ offset: index - 1, character: ";" });
      }
      lastTokenOnLine = index;
      index++;
    }
  }
  return repairs;
}
