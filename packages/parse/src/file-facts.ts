import type { FileFacts } from "./facts.ts";
import { cacheKeyOf, type LoadedGrammar } from "./grammars.ts";
import type { LanguageAdapter } from "./language-adapter.ts";
import { adapterForPath } from "./languages.ts";
import type { ParseCache } from "./parse-cache.ts";

/** Parses one file's text and extracts its facts with the given adapter. With `explain`, function units also carry their metric increments. */
export function parseWith(adapter: LanguageAdapter, grammar: LoadedGrammar, source: string, options: { explain?: boolean } = {}): FileFacts {
  const tree = grammar.parse(source);
  try {
    return adapter.extract(tree.rootNode, options);
  } finally {
    tree.delete();
  }
}

/** Parses a file with the supported adapter that claims its path. */
export function parseFacts(path: string, grammar: LoadedGrammar, source: string, options: { explain?: boolean } = {}): FileFacts {
  const adapter = adapterForPath(path);
  if (adapter === undefined) throw new Error(`No adapter claims ${path}`);
  return parseWith(adapter, grammar, source, options);
}

/**
 * The facts of a file whose text and blob SHA are known: read from the parse cache when the blob was
 * parsed before with this grammar and adapter, otherwise parsed and stored.
 */
export async function factsForBlob(
  language: { adapter: LanguageAdapter; grammar: LoadedGrammar },
  blob: string,
  source: string,
  cache?: ParseCache,
): Promise<{ facts: FileFacts; cached: boolean }> {
  const key = cacheKeyOf(language.adapter, language.grammar);
  const hit = await cache?.get(blob, key);
  if (hit) return { facts: hit, cached: true };
  const facts = parseWith(language.adapter, language.grammar, source);
  await cache?.set(blob, key, facts);
  return { facts, cached: false };
}
