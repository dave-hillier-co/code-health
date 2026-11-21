import { analyseSource } from "./analyse-source.ts";

/**
 * Indentation complexity of a file: the one definition, shared with `analyseSource`. It sums logical
 * indentation levels over code lines, with the file's own indent unit, tabs as one level, and comment
 * lines and multi-line string bodies left out. Pass the file `path` so its lexer profile can identify
 * them. Without a path every non-blank line counts, because comments cannot be told apart.
 */
export function indentationComplexity(text: string, path = ""): number {
  return analyseSource(path, text).file.indentationComplexity;
}
