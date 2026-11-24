import type { Node } from "web-tree-sitter";
import type { DeclarationKind } from "../../facts.ts";
import { declaratorName, functionDeclarator } from "./metric-rules.ts";

/** The member a template wraps, otherwise the member. */
function target(member: Node): Node {
  return member.type === "template_declaration" ? (member.namedChildren.find((child) => child.type !== "template_parameter_list" && child.type !== "comment") ?? member) : member;
}

/**
 * What a class, struct or union with a body is for Martin's abstractness (docs/languages.md, Packages): an
 * `interface` when every function it declares, apart from constructors and the destructor, is pure virtual
 * (`= 0`) and it holds no data; an `abstract-class` when it has any pure virtual function; a `class` otherwise.
 */
export function classAbstraction(declaration: Node): DeclarationKind {
  const body = declaration.childForFieldName("body");
  const className = declaration.childForFieldName("name")?.text ?? "";
  let pure = 0;
  let other = 0;
  let data = 0;
  for (const member of body?.namedChildren ?? []) {
    const node = target(member);
    if (node.type !== "field_declaration" && node.type !== "declaration" && node.type !== "function_definition") continue;
    const declarator = functionDeclarator(node);
    if (declarator === null) {
      if (node.type === "field_declaration") data++;
      continue;
    }
    const name = declaratorName(declarator)?.name ?? "";
    if (name === className || name === `~${className}`) continue;
    if (node.childForFieldName("default_value")?.text === "0") pure++;
    else other++;
  }
  if (pure === 0) return "class";
  return other === 0 && data === 0 ? "interface" : "abstract-class";
}
