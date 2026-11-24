import type { Node } from "web-tree-sitter";
import { nodeCount } from "../typescript/interface-shape.ts";

/**
 * What the interface depth signal needs of a unit (the complexity skill's references/metrics.md, Interface depth), for Rust.
 *
 * - Nodes: named nodes of the unit, comments left out (doc comments are comments).
 * - Function interface: its declared parameters, `self` excluded, and at least 1.
 * - Type interface: what a user of the type can reach. A struct or union: its fields marked `pub`, in any
 *   form. An enum: its variants. A trait: its members. At least 1. The methods of the type are in `impl`
 *   blocks of their own units.
 * - Pass-through: the body is one call whose arguments are parameters (`x`, `&x`, `&mut x`), a spread of
 *   nothing (Rust has none) or literals.
 */

const comments = (node: Node): boolean => node.type === "line_comment" || node.type === "block_comment";

export const rustNodeCount = (node: Node): number => nodeCount(node, comments);

export interface InterfaceShape {
  nodes: number;
  interfaceSize: number;
}

export function functionShape(fn: Node, parameters: number): InterfaceShape {
  return { nodes: rustNodeCount(fn), interfaceSize: Math.max(1, parameters) };
}

function isPublicField(field: Node): boolean {
  return field.namedChildren.some((child) => child.type === "visibility_modifier");
}

export function typeShape(declaration: Node): InterfaceShape {
  const body = declaration.childForFieldName("body");
  const members = (body?.namedChildren ?? []).filter((member) => !comments(member) && member.type !== "attribute_item");
  let interfaceSize: number;
  switch (declaration.type) {
    case "struct_item":
    case "union_item":
      // `field_declaration` in a braced struct. A tuple struct's fields are its types, each preceded by an optional modifier.
      interfaceSize = body?.type === "ordered_field_declaration_list" ? members.filter((member) => member.type === "visibility_modifier").length : members.filter(isPublicField).length;
      break;
    default:
      interfaceSize = members.length;
  }
  return { nodes: rustNodeCount(declaration), interfaceSize: Math.max(1, interfaceSize) };
}

const literals = new Set(["integer_literal", "float_literal", "string_literal", "raw_string_literal", "boolean_literal", "char_literal", "unit_expression"]);
const wrappers = new Set(["try_expression", "await_expression", "parenthesized_expression"]);

function unwrap(node: Node | null): Node | null {
  let current = node;
  while (current !== null && wrappers.has(current.type)) current = current.namedChildren.find((child) => !comments(child)) ?? null;
  return current;
}

function isForwarded(argument: Node, parameters: ReadonlySet<string>): boolean {
  if (argument.type === "identifier") return parameters.has(argument.text);
  if (argument.type === "self") return true;
  if (argument.type === "reference_expression") {
    const value = argument.childForFieldName("value");
    return value !== null && isForwarded(value, parameters);
  }
  return literals.has(argument.type);
}

/** Names bound by a pattern, for the parameters of a function. */
export function patternNames(pattern: Node | null, out: string[]): void {
  if (pattern === null) return;
  if (pattern.type === "identifier") out.push(pattern.text);
  else if (pattern.type !== "type_identifier" && pattern.type !== "scoped_identifier") for (const child of pattern.namedChildren) patternNames(child, out);
}

export function parameterNames(fn: Node): string[] {
  const names: string[] = [];
  for (const entry of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    if (entry.type === "parameter") patternNames(entry.childForFieldName("pattern"), names);
    else if (entry.type === "identifier") names.push(entry.text);
  }
  return names;
}

/** The call a function's whole body forwards to, as written (`self.store.save`), or undefined. */
export function passThroughOf(fn: Node, parameters: ReadonlySet<string>): string | undefined {
  const body = fn.childForFieldName("body");
  if (body === null) return undefined;
  let expression: Node | null = body;
  if (body.type === "block") {
    const statements = body.namedChildren.filter((child) => !comments(child));
    if (statements.length !== 1) return undefined;
    expression = statements[0]!;
    if (expression.type === "expression_statement") expression = expression.namedChildren.find((child) => !comments(child)) ?? null;
    if (expression?.type === "return_expression") expression = expression.namedChildren.find((child) => !comments(child)) ?? null;
  }
  const call = unwrap(expression);
  if (call === null || call.type !== "call_expression") return undefined;
  const callee = call.childForFieldName("function");
  const args = call.childForFieldName("arguments");
  if (callee === null || args === null) return undefined;
  const forwarded = args.namedChildren.filter((child) => !comments(child)).every((argument) => isForwarded(argument, parameters));
  return forwarded ? callee.text : undefined;
}
