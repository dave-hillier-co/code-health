import type { Node } from "web-tree-sitter";
import { countParameters, declaratorName, functionDeclarator } from "./metric-rules.ts";

/**
 * What the interface depth signal needs of a C++ unit (complexity.md, Interface depth), on the same terms as
 * the other languages:
 *
 * - Nodes: named nodes of the unit, itself included, comments left out.
 * - Function interface: its declared parameters, and at least 1.
 * - Class interface: the constructors' parameters plus the members a user of the class can reach, so
 *   everything but `private` members (and `protected` ones, which only a derived class reaches), with the
 *   default of a `struct` or `union` public and of a `class` private. At least 1.
 */

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

/** Members that are declarations a caller can use. Access specifiers, friends, assertions and `using` lines are not. */
const memberTypes = new Set(["field_declaration", "function_definition", "declaration", "class_specifier", "struct_specifier", "union_specifier", "enum_specifier", "alias_declaration", "type_definition"]);

/** The class_specifier, or a function or other declaration, a member node stands for: a template_declaration is looked through. */
function inner(member: Node): Node {
  return member.type === "template_declaration" ? (member.namedChildren.find((child) => child.type !== "template_parameter_list" && child.type !== "comment") ?? member) : member;
}

/** The constructors' own name test: a function whose declared name is the class's. */
function isConstructor(member: Node, className: string): boolean {
  const target = inner(member);
  return declaratorName(functionDeclarator(target))?.name === className;
}

function constructorParameters(member: Node): number {
  return countParameters(functionDeclarator(inner(member))?.childForFieldName("parameters") ?? null);
}

export function classShape(declaration: Node): InterfaceShape {
  const body = declaration.childForFieldName("body");
  const className = declaration.childForFieldName("name")?.text ?? "";
  let access: "public" | "private" | "protected" = declaration.type === "class_specifier" ? "private" : "public";
  let interfaceSize = 0;
  for (const member of body?.namedChildren ?? []) {
    if (member.type === "access_specifier") {
      access = member.text.trim() as typeof access;
      continue;
    }
    if (access !== "public") continue;
    const target = inner(member);
    if (!memberTypes.has(target.type)) continue;
    if (isConstructor(member, className)) interfaceSize += constructorParameters(member);
    else interfaceSize++;
  }
  return { nodes: nodeCount(declaration), interfaceSize: Math.max(1, interfaceSize) };
}

const literalTypes = new Set(["string_literal", "raw_string_literal", "number_literal", "true", "false", "null", "nullptr", "this", "char_literal"]);

function isForwarded(argument: Node, parameters: ReadonlySet<string>): boolean {
  if (argument.type === "identifier") return parameters.has(argument.text);
  return literalTypes.has(argument.type);
}

/**
 * The call a function's whole body forwards to, as written (`store.save`), or undefined. The body must be
 * one statement that is a call (returned or not), whose every argument is a parameter of the function or a
 * literal, so the function adds nothing between its caller and the callee.
 */
export function passThroughOf(fn: Node, parameterNames: ReadonlySet<string>): string | undefined {
  const body = fn.childForFieldName("body");
  if (body === null || body.type !== "compound_statement") return undefined;
  const statements = body.namedChildren.filter((child) => child.type !== "comment");
  if (statements.length !== 1) return undefined;
  const [statement] = statements as [Node];
  if (statement.type !== "return_statement" && statement.type !== "expression_statement") return undefined;
  let expression: Node | null = statement.namedChildren.find((child) => child.type !== "comment") ?? null;
  while (expression !== null && expression.type === "parenthesized_expression") expression = expression.namedChildren[0] ?? null;
  if (expression === null || expression.type !== "call_expression") return undefined;
  const callee = expression.childForFieldName("function");
  const args = expression.childForFieldName("arguments");
  if (callee === null || args === null) return undefined;
  const forwarded = args.namedChildren.filter((child) => child.type !== "comment").every((argument) => isForwarded(argument, parameterNames));
  return forwarded ? callee.text : undefined;
}
