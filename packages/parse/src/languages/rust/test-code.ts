import type { Node } from "web-tree-sitter";

/**
 * Which items of a Rust file are test code wherever the file sits: an item with `#[test]` or an async runtime's
 * `#[tokio::test]`, or one compiled only for tests, `#[cfg(P)]` where every build that satisfies P has `test` set.
 * `test` requires it, `all(..)` requires it when any of its parts does, `any(..)` when every part does, and `not(..)`
 * never does, so `#[cfg(all(test, unix))]` is test code and `#[cfg(any(test, feature = "test-utils"))]`, which a
 * feature also compiles, is not.
 */

/** The kinds of item an attribute can make test code. */
export const itemKinds: ReadonlySet<string> = new Set([
  "function_item",
  "function_signature_item",
  "mod_item",
  "impl_item",
  "struct_item",
  "union_item",
  "enum_item",
  "trait_item",
  "type_item",
  "const_item",
  "static_item",
  "use_declaration",
  "macro_definition",
  "macro_invocation",
  "extern_crate_declaration",
]);

const isComment = (node: Node): boolean => node.type === "line_comment" || node.type === "block_comment";

/** The attribute items written just before an item, nearest first, with comments between them skipped. */
export function attributesOf(node: Node): Node[] {
  const out: Node[] = [];
  for (let previous = node.previousNamedSibling; previous !== null && (previous.type === "attribute_item" || isComment(previous)); previous = previous.previousNamedSibling) {
    if (previous.type === "attribute_item") out.push(previous);
  }
  return out;
}

/** The item carries an attribute that makes it test code. */
export function isTestItem(node: Node): boolean {
  return attributesOf(node).some((item) => {
    const attribute = item.namedChildren.find((child) => child.type === "attribute");
    const name = attribute?.namedChildren[0]?.text.replace(/\s+/g, "");
    if (attribute === undefined || name === undefined) return false;
    if (/^(\w+::)*test$/.test(name)) return true;
    if (name !== "cfg") return false;
    const args = attribute.childForFieldName("arguments")?.text;
    return args !== undefined && cfgRequiresTest(args);
  });
}

/** The first line of an item, its attributes included. */
export function itemStartLine(node: Node): number {
  const attributes = attributesOf(node);
  return (attributes.at(-1) ?? node).startPosition.row + 1;
}

type Predicate = { name: string; args: Predicate[] | undefined; value: boolean };

/** Whether the predicate of a `cfg(..)`, given with its parentheses, holds only in a test build. */
export function cfgRequiresTest(argumentText: string): boolean {
  const tokens = argumentText.match(/"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_]*|[(),=]/g) ?? [];
  let at = 0;
  const parse = (): Predicate | undefined => {
    const name = tokens[at++];
    if (name === undefined || !/^[A-Za-z_]/.test(name)) return undefined;
    if (tokens[at] === "=") {
      at += 2;
      return { name, args: undefined, value: true };
    }
    if (tokens[at] !== "(") return { name, args: undefined, value: false };
    at++;
    const args: Predicate[] = [];
    while (at < tokens.length && tokens[at] !== ")") {
      const arg = parse();
      if (arg === undefined) return undefined;
      args.push(arg);
      if (tokens[at] === ",") at++;
    }
    at++;
    return { name, args, value: false };
  };
  if (tokens[at++] !== "(") return false;
  const predicate = parse();
  return predicate !== undefined && requiresTest(predicate);
}

function requiresTest(predicate: Predicate): boolean {
  if (predicate.args === undefined) return predicate.name === "test" && !predicate.value;
  if (predicate.name === "all") return predicate.args.some(requiresTest);
  if (predicate.name === "any") return predicate.args.length > 0 && predicate.args.every(requiresTest);
  return false;
}
