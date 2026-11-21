import type { Node } from "web-tree-sitter";
import type { InterfaceShape } from "../typescript/interface-shape.ts";
import { nodeCount } from "../typescript/interface-shape.ts";
import { parameterCounts } from "./metric-rules.ts";

/**
 * What the interface depth signal needs of a Go unit (complexity.md, Interface depth), on the same terms as
 * the other languages: named nodes of the unit, comments left out, and the size of what a user of it has to know.
 *
 * - Function interface: its declared parameters, and at least 1.
 * - Struct interface: its exported fields (an embedded type counts when it is exported) and the exported
 *   methods declared with it in the same file, at least 1. Unexported members are not part of the interface.
 * - Interface type: its methods and embedded interfaces, at least 1.
 */

export function isExported(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

export function functionShape(fn: Node): InterfaceShape {
  return { nodes: nodeCount(fn), interfaceSize: Math.max(1, parameterCounts(fn).parameters) };
}

/** The name an embedded field is reached by: `Base` for `Base`, `*Base` and `pkg.Base`. */
function embeddedName(type: Node | null): string {
  if (type === null) return "";
  if (type.type === "qualified_type") return type.childForFieldName("name")?.text ?? "";
  if (type.type === "pointer_type") return embeddedName(type.namedChildren[0] ?? null);
  if (type.type === "generic_type") return embeddedName(type.childForFieldName("type"));
  return type.text;
}

export function typeShape(declaration: Node, type: Node, exportedMethods: number): InterfaceShape {
  let size = 0;
  if (type.type === "struct_type") {
    for (const field of type.descendantsOfType("field_declaration")) {
      const names = field.childrenForFieldName("name");
      if (names.length === 0) {
        if (isExported(embeddedName(field.childForFieldName("type")))) size++;
      } else {
        size += names.filter((name) => isExported(name.text)).length;
      }
    }
    size += exportedMethods;
  } else if (type.type === "interface_type") {
    size = type.namedChildren.filter((member) => member.type === "method_elem" || member.type === "type_elem").length;
  }
  return { nodes: nodeCount(declaration), interfaceSize: Math.max(1, size) };
}

const literalTypes = new Set([
  "int_literal",
  "float_literal",
  "imaginary_literal",
  "rune_literal",
  "interpreted_string_literal",
  "raw_string_literal",
  "true",
  "false",
  "nil",
]);

function unwrap(node: Node | null): Node | null {
  let current = node;
  while (current !== null && current.type === "parenthesized_expression") current = current.namedChildren.find((child) => child.type !== "comment") ?? null;
  return current;
}

function isForwarded(argument: Node, parameters: ReadonlySet<string>): boolean {
  if (argument.type === "identifier") return parameters.has(argument.text);
  if (argument.type === "variadic_argument") {
    const spread = argument.namedChildren[0];
    return spread?.type === "identifier" && parameters.has(spread.text);
  }
  return literalTypes.has(argument.type);
}

/** Names the function binds as parameters. */
export function parameterNames(fn: Node): Set<string> {
  const names = new Set<string>();
  for (const parameter of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    for (const name of parameter.childrenForFieldName("name")) names.add(name.text);
  }
  return names;
}

/**
 * The call a function's whole body forwards to, as written (`store.Save`), or undefined: the body is one
 * `return call(...)` or `call(...)` whose every argument is a parameter, a spread of one, or a literal.
 */
export function passThroughOf(fn: Node): string | undefined {
  const body = fn.childForFieldName("body");
  const statements = (body?.namedChildren.find((child) => child.type === "statement_list") ?? null)?.namedChildren.filter((child) => child.type !== "comment") ?? [];
  if (statements.length !== 1) return undefined;
  const [statement] = statements as [Node];
  let expression: Node | null;
  if (statement.type === "expression_statement") expression = statement.namedChildren[0] ?? null;
  else if (statement.type === "return_statement") {
    const results = statement.namedChildren.find((child) => child.type === "expression_list");
    if (results === undefined || results.namedChildren.length !== 1) return undefined;
    expression = results.namedChildren[0] ?? null;
  } else return undefined;
  const call = unwrap(expression);
  if (call === null || call.type !== "call_expression") return undefined;
  const callee = call.childForFieldName("function");
  const args = call.childForFieldName("arguments");
  if (callee === null || args === null) return undefined;
  const parameters = parameterNames(fn);
  return args.namedChildren.filter((child) => child.type !== "comment").every((argument) => isForwarded(argument, parameters)) ? callee.text : undefined;
}
