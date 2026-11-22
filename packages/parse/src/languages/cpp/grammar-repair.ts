import type { Node } from "web-tree-sitter";
import type { SourceRepair } from "../../language-adapter.ts";

/**
 * Constructs the C++ grammar rejects, found on Solent (a CMake game engine with doctest tests) to be most of the files
 * it reported syntax errors for. Each repair overwrites characters with the same number of characters, so no position
 * moves, and the loader keeps the repaired tree only when it has fewer errors. The repairs run only for a file that
 * already has errors. What each one does to the text, so that facts are read from the repaired tree:
 *
 * - A test-framework macro invoked with a block, `TEST_CASE("name") { ... }`, `SUBCASE("name") { ... }` and
 *   `TEST_SUITE("name") { ... }` (doctest, Catch2, GoogleTest `TEST(Suite, Name) { ... }`). The grammar reads the
 *   invocation as a statement missing its semicolon and the block as a stray block. At the top of a file or inside a
 *   namespace the invocation becomes `void <name>()`, or `namespace <name>` when the macro's name contains SUITE or
 *   NAMESPACE, and the unit is named after the invocation's text with every character outside `A-Za-z0-9_` written as
 *   `_` (`TEST_CASE("a: b")` is `void CASE__a__b()`, the last two characters of the invocation standing for
 *   the parentheses). Inside a function body it becomes a plain block.
 * - An empty or braced default argument or value with no type, `const Options& options = {}`, which the grammar
 *   reads as a compound literal missing its type. The braces and what they hold become `0` and blanks.
 * - A pointer-to-member operator, `object.*(member)` and `pointer->*(member)`, whose `.` or `->` becomes blanks,
 *   leaving a product. A pointer-to-member declarator in a class, `const T Class::* member;`, whose class name and
 *   `::` become blanks, leaving a pointer.
 *
 * What is left unrepaired: an enum with a base and no name (`enum : std::uint32_t {`), a calling-convention macro
 * between a return type and a function name (`void SDLCALL callback(`), `using F::operator()...;`, a defaulted friend
 * `operator==` with attributes, and a macro defined with a trailing comma that an `#include` completes.
 */
export function cppRepairs(root: Node, source: string): SourceRepair[] {
  const edits = new Map<number, string>();
  const overwrite = (start: number, text: string): void => {
    for (let i = 0; i < text.length; i++) if (source[start + i] !== text[i]) edits.set(start + i, text[i]!);
  };
  visit(root, source, overwrite);
  return [...edits].map(([offset, character]) => ({ offset, character }));
}

type Overwrite = (start: number, text: string) => void;

const blanks = (text: string): string => text.replace(/[^\r\n]/g, " ");
const identifierText = (text: string): string => text.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[0-9]/, "_");

function visit(node: Node, source: string, overwrite: Overwrite): void {
  if (!node.hasError && !node.isMissing) return;
  if (node.type === "expression_statement") {
    if (testMacro(node, source, overwrite)) return;
  } else if (node.type === "compound_literal_expression") {
    if (untypedBraces(node, source, overwrite)) return;
  } else if (node.isMissing && node.type === "field_identifier") {
    memberPointerUse(node, source, overwrite);
  } else if (node.type === "ERROR") {
    memberPointerDeclarator(node, source, overwrite);
  }
  for (const child of node.children) visit(child, source, overwrite);
}

const suiteName = /SUITE|NAMESPACE/i;

/** A macro invocation the grammar read as a statement missing its semicolon, with the block that follows it, or undefined. */
function macroWithBlock(statement: Node): { call: Node; callee: Node } | undefined {
  const missingSemicolon = statement.children.some((child) => child.isMissing && child.type === ";");
  const call = statement.namedChildren.find((child) => child.type === "call_expression");
  const callee = call?.childForFieldName("function");
  if (!missingSemicolon || call === undefined || callee?.type !== "identifier" || statement.nextNamedSibling?.type !== "compound_statement") return undefined;
  return { call, callee };
}

/** Whether a statement stands where declarations belong: at the top of a file, in a namespace, or in the block of a suite macro that becomes one. */
function holdsDeclarations(statement: Node): boolean {
  const parent = statement.parent;
  if (parent?.type === "translation_unit" || parent?.type === "declaration_list") return true;
  if (parent?.type !== "compound_statement") return false;
  const opener = parent.previousNamedSibling;
  const suite = opener?.type === "expression_statement" ? macroWithBlock(opener) : undefined;
  return suite !== undefined && suiteName.test(suite.callee.text) && holdsDeclarations(opener!);
}

/** `NAME(args)` with no semicolon, followed by a block: a macro that stands for a function, a namespace or a block. */
function testMacro(statement: Node, source: string, overwrite: Overwrite): boolean {
  const macro = macroWithBlock(statement);
  if (macro === undefined) return false;
  const { call, callee } = macro;
  const start = call.startIndex;
  const text = source.slice(start, call.endIndex);
  const topLevel = holdsDeclarations(statement);
  const lineBreak = text.search(/[\r\n]/);
  if (!topLevel) {
    overwrite(start, blanks(text));
    return true;
  }
  if (suiteName.test(callee.text)) {
    const head = "namespace ";
    const identifierEnd = lineBreak === -1 ? text.length : lineBreak;
    if (identifierEnd <= head.length) return false;
    overwrite(start, head + identifierText(text.slice(head.length, identifierEnd)) + blanks(text.slice(identifierEnd)));
    return true;
  }
  const head = "void ";
  // The parentheses stand where the invocation's last two characters, or the end of its first line, were.
  const identifierEnd = lineBreak === -1 ? text.length - 2 : lineBreak - 1;
  if (identifierEnd <= head.length) return false;
  const rest = lineBreak === -1 ? "()" : `(${blanks(text.slice(identifierEnd + 1, -1))})`;
  overwrite(start, head + identifierText(text.slice(head.length, identifierEnd)) + rest);
  return true;
}

/** `= {}` with no type before the braces. */
function untypedBraces(literal: Node, source: string, overwrite: Overwrite): boolean {
  if (!literal.children.some((child) => child.isMissing && child.type === "type_identifier")) return false;
  const braces = literal.children.find((child) => child.type === "initializer_list");
  if (braces === undefined) return false;
  const text = source.slice(braces.startIndex, braces.endIndex);
  overwrite(braces.startIndex, `0${blanks(text.slice(1))}`);
  return true;
}

/** `object.*(member)` and `pointer->*(member)`: the field is missing next to the `*`, and the operator before it goes. */
function memberPointerUse(missing: Node, source: string, overwrite: Overwrite): void {
  const at = missing.startIndex;
  const star = source[at] === "*" ? at : source[at - 1] === "*" ? at - 1 : -1;
  if (star < 0) return;
  if (source[star - 1] === ".") overwrite(star - 1, " ");
  else if (source[star - 1] === ">" && source[star - 2] === "-") overwrite(star - 2, "  ");
}

/** `Class::* member` in a class body, which the grammar reads as a bit field. */
function memberPointerDeclarator(error: Node, source: string, overwrite: Overwrite): void {
  const lineStart = source.lastIndexOf("\n", error.startIndex - 1) + 1;
  const lineEnd = Math.max(error.endIndex, source.indexOf("\n", error.endIndex) === -1 ? source.length : source.indexOf("\n", error.endIndex));
  const region = source.slice(lineStart, lineEnd);
  for (const found of region.matchAll(/[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*::(?=\*\s*[A-Za-z_])/g)) {
    overwrite(lineStart + found.index, blanks(found[0]));
  }
}
