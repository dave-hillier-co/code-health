import { readFileSync } from "node:fs";
import { join } from "node:path";
import { usageError } from "@code-health/cli-kit/errors";
import type { Command } from "@code-health/cli-kit/run-cli";
import { grammarIdForPath, loadGrammar } from "@code-health/parse/grammars";

export const name = "parse";

/**
 * A placeholder that proves the bundled CLI loads its grammars from `dist/grammars`.
 * Replace it with the plugin's first real command, keeping the grammar loading as it is.
 */
export const command: Command = {
  summary: "Parse one source file of the repository and report the shape of its syntax tree",
  async run(context) {
    const [file] = context.positionals;
    if (file === undefined) throw usageError("parse needs a file path, relative to the repository root");
    const id = grammarIdForPath(file);
    if (id === undefined) throw usageError(`no grammar for ${file}`);
    const grammar = await loadGrammar(id);
    const tree = grammar.parse(readFileSync(join(context.repo.root, file), "utf8"));
    try {
      const root = tree.rootNode;
      return { results: { file, grammar: id, rootType: root.type, namedChildren: root.namedChildCount, hasErrors: root.hasError } };
    } finally {
      tree.delete();
    }
  },
};
