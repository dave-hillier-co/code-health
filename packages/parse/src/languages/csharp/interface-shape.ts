import type { Node } from "web-tree-sitter";
import { bodyOf, parameterCounts } from "./metric-rules.ts";

/**
 * What the interface depth signal needs of a unit (the complexity skill's references/metrics.md, Interface depth), for C#.
 *
 * - Nodes: named nodes of the unit, itself included, comments left out. Attributes and the names of a
 *   declaration count, because a long signature is part of what a reader takes in.
 * - Function interface: its declared parameters, and at least 1.
 * - Type interface: the parameters of every constructor a user can call, plus the members a user can reach:
 *   public, protected and internal ones, and every member of an interface. A class member with no modifier is
 *   private. At least 1.
 */

/** Named, non-comment nodes of the subtree, the node itself included. */
export function nodeCount(node: Node, skip?: (child: Node) => boolean): number {
  let count = 0;
  const walk = (current: Node): void => {
    if (!current.isNamed || current.type === "comment") return;
    if (skip?.(current) === true) return;
    count++;
    for (let i = 0; i < current.childCount; i++) {
      const child = current.child(i);
      if (child !== null) walk(child);
    }
  };
  walk(node);
  return count;
}

export interface InterfaceShape {
  nodes: number;
  interfaceSize: number;
}

export function functionShape(fn: Node, parameters: number): InterfaceShape {
  return { nodes: nodeCount(fn), interfaceSize: Math.max(1, parameters) };
}

export const modifiersOf = (node: Node): string[] => node.namedChildren.filter((child) => child.type === "modifier").map((child) => child.text);

const memberTypes = new Set([
  "method_declaration",
  "property_declaration",
  "indexer_declaration",
  "operator_declaration",
  "conversion_operator_declaration",
  "event_declaration",
]);
const declaratorTypes = new Set(["field_declaration", "event_field_declaration"]);

function isReachable(member: Node, inInterface: boolean): boolean {
  const modifiers = modifiersOf(member);
  if (modifiers.includes("private") && !modifiers.includes("protected")) return false;
  if (inInterface) return true;
  return modifiers.some((modifier) => modifier === "public" || modifier === "protected" || modifier === "internal");
}

/** The shape of a class, struct, interface, record or enum. */
export function typeShape(declaration: Node): InterfaceShape {
  const inInterface = declaration.type === "interface_declaration";
  let interfaceSize = 0;
  if (declaration.type === "enum_declaration") {
    interfaceSize = declaration.childForFieldName("body")?.namedChildren.filter((member) => member.type === "enum_member_declaration").length ?? 0;
  } else {
    // A record or a class with a primary constructor takes its parameters there.
    const primary = declaration.namedChildren.find((child) => child.type === "parameter_list");
    interfaceSize += primary?.namedChildren.filter((child) => child.type === "parameter").length ?? 0;
    for (const member of declaration.childForFieldName("body")?.namedChildren ?? []) {
      if (member.type === "constructor_declaration") {
        if (isReachable(member, inInterface)) interfaceSize += parameterCounts(member).parameters;
      } else if (memberTypes.has(member.type)) {
        if (isReachable(member, inInterface)) interfaceSize++;
      } else if (declaratorTypes.has(member.type)) {
        if (isReachable(member, inInterface)) interfaceSize += member.descendantsOfType("variable_declarator").length;
      }
    }
  }
  return { nodes: nodeCount(declaration), interfaceSize: Math.max(1, interfaceSize) };
}

const literalTypes = new Set(["string_literal", "integer_literal", "real_literal", "boolean_literal", "null_literal", "character_literal", "verbatim_string_literal", "raw_string_literal", "this_expression"]);

/** Unwraps what does not change what is called: parentheses, `await`, casts and `!`. */
function unwrap(node: Node | null): Node | null {
  let current = node;
  while (current !== null && ["parenthesized_expression", "await_expression", "cast_expression", "postfix_unary_expression"].includes(current.type)) {
    const inner: Node | undefined = current.type === "cast_expression" ? (current.childForFieldName("value") ?? undefined) : current.namedChildren.find((child) => child.type !== "comment");
    current = inner ?? null;
  }
  return current;
}

function isForwarded(argument: Node, parameters: ReadonlySet<string>): boolean {
  const value = argument.namedChildren.find((child) => child.type !== "name_colon" && child.type !== "comment");
  // `this` is a token of the grammar and not a node.
  if (value === undefined) return argument.children.some((child) => child.type === "this");
  if (value.type === "identifier") return parameters.has(value.text);
  return literalTypes.has(value.type);
}

/**
 * The call a function's whole body forwards to, as written (`store.Save`), or undefined. The body must be
 * one statement or expression that is a call, whose every argument is a parameter of the function or a
 * literal, so the function adds nothing between its caller and the callee.
 */
export function passThroughOf(fn: Node, parameterNames: ReadonlySet<string>): string | undefined {
  const body = bodyOf(fn);
  if (body === null) return undefined;
  let expression: Node | null;
  if (body.type === "block") {
    const statements = body.namedChildren.filter((child) => child.type !== "comment");
    if (statements.length !== 1) return undefined;
    const [statement] = statements as [Node];
    if (statement.type !== "return_statement" && statement.type !== "expression_statement") return undefined;
    expression = statement.namedChildren.find((child) => child.type !== "comment") ?? null;
  } else {
    expression = body.namedChildren.find((child) => child.type !== "comment") ?? null;
  }
  const call = unwrap(expression);
  if (call === null || call.type !== "invocation_expression") return undefined;
  const callee = call.childForFieldName("function");
  const args = call.childForFieldName("arguments");
  if (callee === null || args === null) return undefined;
  const forwarded = args.namedChildren.filter((child) => child.type === "argument").every((argument) => isForwarded(argument, parameterNames));
  return forwarded ? callee.text : undefined;
}
