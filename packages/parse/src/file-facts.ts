import type { Node } from "web-tree-sitter";
import type { FileFacts, SyntaxErrorFact } from "./facts.ts";
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
 * The first error or missing node of a tree, in text order. A node that has an error and no child with one stands for
 * a missing token the grammar does not list among its children, and is reported as missing that node's kind.
 */
export function firstSyntaxError(root: Node): SyntaxErrorFact | undefined {
  if (!root.hasError) return undefined;
  let node = root;
  for (;;) {
    if (node.isMissing || node.type === "ERROR") break;
    const child = node.children.find((candidate) => candidate.hasError || candidate.isMissing);
    if (child === undefined) break;
    node = child;
  }
  const at = { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
  if (node.type === "ERROR") return { ...at, kind: "unexpected", text: node.text.split(/\r?\n/, 1)[0]!.slice(0, 40) };
  return { ...at, kind: "missing", text: node.type };
}

/** The first syntax error of one file. */
export interface SyntaxErrorLocation extends SyntaxErrorFact {
  path: string;
}

/** Where a file's first syntax error is. Facts that report errors and hold no position give the file's start. */
export function syntaxErrorAt(path: string, facts: { syntaxError?: SyntaxErrorFact }): SyntaxErrorLocation {
  return { path, ...(facts.syntaxError ?? { line: 1, column: 1, kind: "unexpected", text: "" }) };
}

/**
 * Parses one file's text and extracts its facts with the given adapter. With `explain`, function units also carry
 * their metric increments. A file whose tree nests deeper than `MAX_TREE_DEPTH` is read as empty and marked `tooDeep`.
 */
export function parseWith(adapter: LanguageAdapter, grammar: LoadedGrammar, source: string, options: { explain?: boolean } = {}): FileFacts {
  const tree = grammar.parse(source);
  try {
    if (!nestsDeeperThan(tree.rootNode, MAX_TREE_DEPTH)) {
      const facts = adapter.extract(tree.rootNode, options);
      if (facts.hasSyntaxErrors && facts.syntaxError === undefined) {
        const first = firstSyntaxError(tree.rootNode);
        if (first !== undefined) facts.syntaxError = first;
      }
      return facts;
    }
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
