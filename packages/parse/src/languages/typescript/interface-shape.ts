import type { Node } from "web-tree-sitter";
import { parameterCounts } from "./metric-rules.ts";

/**
 * What the interface depth signal needs of a unit (complexity.md, Interface depth): the size of its
 * implementation in syntax nodes, the size of its interface, and whether its whole body forwards to one
 * other call. All of it depends only on the syntax tree, so it is cached with the file's facts.
 *
 * - Nodes: named nodes of the unit, itself included, comments left out. The names of a unit's
 *   declaration count, because a long signature is part of what a reader takes in.
 * - Function interface: its declared parameters, and at least 1, because calling a function with no
 *   parameters is still something a caller must know.
 * - Class interface: the constructor's parameters plus the members a user of the class can reach, so
 *   everything but `private` members and `#` fields. At least 1.
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

const memberTypes = new Set([
  "method_definition",
  "public_field_definition",
  "abstract_method_signature",
  "method_signature",
  "index_signature",
  "property_signature",
]);

function isHidden(member: Node): boolean {
  if (member.namedChildren.some((child) => child.type === "accessibility_modifier" && child.text === "private")) return true;
  return member.childForFieldName("name")?.type === "private_property_identifier";
}

export function classShape(declaration: Node): InterfaceShape {
  const body = declaration.childForFieldName("body");
  let interfaceSize = 0;
  for (const member of body?.namedChildren ?? []) {
    if (!memberTypes.has(member.type) || isHidden(member)) continue;
    if (member.type === "method_definition" && member.childForFieldName("name")?.text === "constructor") {
      interfaceSize += parameterCounts(member).parameters;
    } else {
      interfaceSize++;
    }
  }
  return { nodes: nodeCount(declaration), interfaceSize: Math.max(1, interfaceSize) };
}

const literalTypes = new Set(["string", "number", "true", "false", "null", "undefined", "this"]);

/** Unwraps what does not change what is called: parentheses, `await`, `as` and `!`. */
function unwrap(node: Node | null): Node | null {
  let current = node;
  while (current !== null && ["parenthesized_expression", "await_expression", "as_expression", "non_null_expression", "satisfies_expression"].includes(current.type)) {
    current = current.namedChildren.find((child) => child.type !== "comment") ?? null;
  }
  return current;
}

function isForwarded(argument: Node, parameters: ReadonlySet<string>): boolean {
  if (argument.type === "identifier") return parameters.has(argument.text);
  if (argument.type === "spread_element") {
    const spread = argument.namedChildren[0];
    return spread?.type === "identifier" && parameters.has(spread.text);
  }
  return literalTypes.has(argument.type);
}

/**
 * The call a function's whole body forwards to, as written (`store.save`), or undefined. The body must be
 * one statement or expression that is a call, whose every argument is a parameter of the function, a
 * spread of one, or a literal, so the function adds nothing between its caller and the callee. A call with
 * a computed argument, or a body of several statements, is a function doing work of its own.
 */
export function passThroughOf(fn: Node, parameterNames: ReadonlySet<string>): string | undefined {
  const body = fn.childForFieldName("body");
  if (body === null) return undefined;
  let expression: Node | null = body;
  if (body.type === "statement_block") {
    const statements = body.namedChildren.filter((child) => child.type !== "comment");
    if (statements.length !== 1) return undefined;
    const [statement] = statements as [Node];
    if (statement.type !== "return_statement" && statement.type !== "expression_statement") return undefined;
    expression = statement.namedChildren.find((child) => child.type !== "comment") ?? null;
  }
  const call = unwrap(expression);
  if (call === null || call.type !== "call_expression") return undefined;
  const callee = call.childForFieldName("function");
  if (callee === null || callee.type === "import") return undefined;
  const args = call.childForFieldName("arguments");
  if (args === null || args.type !== "arguments") return undefined;
  const forwarded = args.namedChildren.filter((child) => child.type !== "comment").every((argument) => isForwarded(argument, parameterNames));
  return forwarded ? callee.text : undefined;
}
