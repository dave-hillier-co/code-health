import type { Node } from "web-tree-sitter";
import { nodeCount, type InterfaceShape } from "../typescript/interface-shape.ts";
import { parameterNodes, parameterName } from "./metric-rules.ts";

export { nodeCount };

/**
 * What the interface depth signal needs of a Python unit, under the definitions of the TypeScript module it
 * shares `nodeCount` with: implementation size in named nodes, interface size, and the call the body forwards to.
 *
 * - Function interface: its declared parameters (`self` and `cls` left out), and at least 1.
 * - Class interface: the `__init__` parameters plus the members a user of the class can reach: methods,
 *   class-level names and nested classes whose name does not start with an underscore, and dunder methods,
 *   which are protocols. Name-mangled and underscore members are private by convention. At least 1.
 */

export function functionShape(fn: Node, parameters: number): InterfaceShape {
  return { nodes: nodeCount(fn), interfaceSize: Math.max(1, parameters) };
}

/** The statements of a class body, with decorated definitions unwrapped to the definition. */
function members(body: Node | null): Node[] {
  return (body?.namedChildren ?? []).map((member) => (member.type === "decorated_definition" ? (member.childForFieldName("definition") ?? member) : member));
}

const isPrivate = (name: string): boolean => name.startsWith("_") && !(name.startsWith("__") && name.endsWith("__"));

/** Names a class-body statement defines: an assignment's targets, or a definition's name. */
function memberNames(member: Node): string[] {
  if (member.type === "function_definition" || member.type === "class_definition") return [member.childForFieldName("name")?.text ?? ""];
  if (member.type !== "expression_statement") return [];
  const assignment = member.namedChildren[0];
  if (assignment?.type !== "assignment") return [];
  const left = assignment.childForFieldName("left");
  if (left === null) return [];
  return left.type === "identifier" ? [left.text] : left.type === "pattern_list" ? left.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text) : [];
}

export function classShape(declaration: Node): InterfaceShape {
  const body = declaration.childForFieldName("body");
  let interfaceSize = 0;
  for (const member of members(body)) {
    for (const name of memberNames(member)) {
      if (name === "" || isPrivate(name)) continue;
      if (name === "__init__" && member.type === "function_definition") interfaceSize += parameterNodes(member).length;
      else interfaceSize++;
    }
  }
  return { nodes: nodeCount(declaration), interfaceSize: Math.max(1, interfaceSize) };
}

const literalTypes = new Set(["string", "concatenated_string", "integer", "float", "true", "false", "none", "ellipsis"]);

/** Unwraps what does not change what is called: parentheses and `await`. */
function unwrap(node: Node | null): Node | null {
  let current = node;
  while (current !== null && (current.type === "parenthesized_expression" || current.type === "await")) {
    current = current.namedChildren.find((child) => child.type !== "comment") ?? null;
  }
  return current;
}

function isForwarded(argument: Node, parameters: ReadonlySet<string>): boolean {
  if (argument.type === "identifier") return parameters.has(argument.text);
  if (argument.type === "list_splat" || argument.type === "dictionary_splat") {
    const spread = argument.namedChildren[0];
    return spread?.type === "identifier" && parameters.has(spread.text);
  }
  if (argument.type === "keyword_argument") {
    const value = argument.childForFieldName("value");
    return value !== null && isForwarded(value, parameters);
  }
  return literalTypes.has(argument.type);
}

/** The names a function's parameters bind, `self` included: a forwarded `self` is a parameter too. */
export function boundParameterNames(fn: Node): Set<string> {
  const names = new Set<string>();
  const list = fn.childForFieldName("parameters");
  for (const entry of list?.namedChildren ?? []) {
    const name = parameterName(entry);
    if (name !== undefined) names.add(name);
  }
  return names;
}

/**
 * The call a function's whole body forwards to, as written (`store.save`), or undefined. The body is one
 * statement that returns or evaluates a call (after an optional docstring), whose every argument is a
 * parameter, a splat of one, a keyword argument of either, or a literal, so the function adds nothing between
 * its caller and the callee. A lambda forwards when its body is such a call.
 */
export function passThroughOf(fn: Node): string | undefined {
  const body = fn.childForFieldName("body");
  if (body === null) return undefined;
  let expression: Node | null = body;
  if (body.type === "block") {
    const statements = body.namedChildren.filter((child) => child.type !== "comment");
    const first = statements[0];
    if (first?.type === "expression_statement" && first.namedChildren[0]?.type === "string" && statements.length > 1) statements.shift();
    if (statements.length !== 1) return undefined;
    const [statement] = statements as [Node];
    if (statement.type !== "return_statement" && statement.type !== "expression_statement") return undefined;
    expression = statement.namedChildren.find((child) => child.type !== "comment") ?? null;
  }
  const call = unwrap(expression);
  if (call === null || call.type !== "call") return undefined;
  const callee = call.childForFieldName("function");
  const args = call.childForFieldName("arguments");
  if (callee === null || args === null || args.type !== "argument_list") return undefined;
  const parameters = boundParameterNames(fn);
  return args.namedChildren.filter((child) => child.type !== "comment").every((argument) => isForwarded(argument, parameters)) ? callee.text : undefined;
}
