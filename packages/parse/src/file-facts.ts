import type { Node } from "web-tree-sitter";
import type { FileFacts } from "./facts.ts";
import { cacheKeyOf, type LoadedGrammar } from "./grammars.ts";
import type { LanguageAdapter } from "./language-adapter.ts";
import { adapterForPath } from "./languages.ts";
import type { ParseCache } from "./parse-cache.ts";

/**
 * The deepest syntax tree the extractors read. They walk the tree by recursion, and a chain of thousands of binary
 * operators (a string built from thousands of `+`, which test inputs and generated tables contain) nests as deep as
 * it is long and would exhaust the call stack. Hand-written code does not come near this depth.
 */
export const MAX_TREE_DEPTH = 1000;

/** Whether any node of the tree is more than `limit` levels below the root. Walks with a cursor, so the tree's depth costs no stack. */
export function nestsDeeperThan(root: Node, limit: number): boolean {
  const cursor = root.walk();
  try {
    let depth = 0;
    for (;;) {
      if (cursor.gotoFirstChild()) {
        if (++depth > limit) return true;
        continue;
      }
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return false;
        depth--;
      }
    }
  } finally {
    cursor.delete();
  }
}

/**
 * Parses one file's text and extracts its facts with the given adapter. With `explain`, function units also carry
 * their metric increments. A file whose tree nests deeper than `MAX_TREE_DEPTH` is read as empty and marked `tooDeep`.
 */
export function parseWith(adapter: LanguageAdapter, grammar: LoadedGrammar, source: string, options: { explain?: boolean } = {}): FileFacts {
  const tree = grammar.parse(source);
  try {
    if (!nestsDeeperThan(tree.rootNode, MAX_TREE_DEPTH)) return adapter.extract(tree.rootNode, options);
  } finally {
    tree.delete();
  }
  const empty = grammar.parse("");
  try {
    return { ...adapter.extract(empty.rootNode, options), tooDeep: true };
  } finally {
    empty.delete();
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
