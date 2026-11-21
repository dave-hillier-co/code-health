import { extractFacts } from "./extract-facts.ts";
import type { FileFacts } from "./facts.ts";
import type { LoadedGrammar } from "./grammars.ts";
import type { ParseCache } from "./parse-cache.ts";

/** Parses one file's text and extracts its facts. With `explain`, function units also carry their metric increments. */
export function parseFacts(grammar: LoadedGrammar, source: string, options: { explain?: boolean } = {}): FileFacts {
  const tree = grammar.parse(source);
  try {
    return extractFacts(tree.rootNode, options);
  } finally {
    tree.delete();
  }
}

/**
 * The facts of a file whose text and blob SHA are known: read from the parse cache when the blob was
 * parsed before with this grammar, otherwise parsed and stored.
 */
export async function factsForBlob(
  grammar: LoadedGrammar,
  blob: string,
  source: string,
  cache?: ParseCache,
): Promise<{ facts: FileFacts; cached: boolean }> {
  const hit = await cache?.get(blob, grammar.version);
  if (hit) return { facts: hit, cached: true };
  const facts = parseFacts(grammar, source);
  await cache?.set(blob, grammar.version, facts);
  return { facts, cached: false };
}
