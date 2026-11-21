import type { Node } from "web-tree-sitter";
import type { FileCensus, ParameterFact } from "../../census-facts.ts";

const registryName = /(registry|registries|handlers|plugins|strategies|factories|providers|adapters)$/i;

function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name);
}

function lastName(node: Node | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case "identifier":
    case "property_identifier":
    case "type_identifier":
      return node.text;
    case "this":
      return "this";
    case "member_expression":
      return lastName(field(node, "property"));
    case "non_null_expression":
    case "parenthesized_expression":
      return lastName(node.namedChildren[0] ?? null);
    case "call_expression":
      return lastName(field(node, "function"));
    default:
      return null;
  }
}

/** Every type name and whether a function type appears, ignoring function types nested inside object types. */
function annotation(node: Node | null): ParameterFact {
  const names = new Set<string>();
  let callback = false;
  const visit = (current: Node, insideObject: boolean): void => {
    if (current.type === "type_identifier") names.add(current.text);
    if (current.type === "function_type" && !insideObject) callback = true;
    const nested = insideObject || current.type === "object_type";
    for (const child of current.namedChildren) visit(child, nested);
  };
  if (node) visit(node, false);
  return { callback, names: [...names].sort() };
}

function parametersOf(list: Node | null): { name: string; type: ParameterFact }[] {
  const out: { name: string; type: ParameterFact }[] = [];
  for (const parameter of list?.namedChildren ?? []) {
    if (parameter.type !== "required_parameter" && parameter.type !== "optional_parameter") continue;
    const type = parameter.namedChildren.find((child) => child.type === "type_annotation");
    if (!type) continue;
    out.push({ name: field(parameter, "pattern")?.text ?? "", type: annotation(type) });
  }
  return out;
}

function decoratorName(node: Node): string | null {
  const expression = node.namedChildren[0];
  if (!expression) return null;
  return lastName(expression.type === "call_expression" ? field(expression, "function") : expression);
}

function heritageOf(node: Node): string[] {
  const out: string[] = [];
  const heritage = node.namedChildren.find((child) => child.type === "class_heritage");
  for (const clause of heritage?.namedChildren ?? []) {
    if (clause.type === "extends_clause") {
      const value = field(clause, "value");
      const name = lastName(value);
      if (name) out.push(name);
    } else if (clause.type === "implements_clause") {
      for (const type of clause.namedChildren) {
        const name = type.type === "generic_type" ? lastName(field(type, "name")) : lastName(type);
        if (name) out.push(name);
      }
    } else {
      // JavaScript: the heritage holds the expression itself.
      const name = lastName(clause);
      if (name) out.push(name);
    }
  }
  return out;
}

/** Extracts a file's census facts from its syntax tree. Lines are 1-based. */
export function extractFileCensus(root: Node): FileCensus {
  const facts: FileCensus = { imports: [], types: [], classes: [], functions: [], calls: [], news: [], decorators: [], keyedMaps: [] };

  const visit = (node: Node, className: string | null): void => {
    const line = node.startPosition.row + 1;
    let nextClass = className;

    switch (node.type) {
      case "import_statement": {
        const source = field(node, "source");
        const specifier = source?.namedChildren.find((child) => child.type === "string_fragment")?.text ?? "";
        const clause = node.namedChildren.find((child) => child.type === "import_clause");
        for (const part of clause?.namedChildren ?? []) {
          if (part.type === "identifier") facts.imports.push({ local: part.text, imported: "default", specifier });
          else if (part.type === "namespace_import") facts.imports.push({ local: part.namedChildren[0]?.text ?? "", imported: "*", specifier });
          else if (part.type === "named_imports") {
            for (const entry of part.namedChildren) {
              if (entry.type !== "import_specifier") continue;
              const imported = field(entry, "name")?.text ?? "";
              facts.imports.push({ local: field(entry, "alias")?.text ?? imported, imported, specifier });
            }
          }
        }
        break;
      }
      case "interface_declaration": {
        const name = field(node, "name")?.text;
        if (name) facts.types.push({ name, kind: "interface", line });
        break;
      }
      case "type_alias_declaration": {
        const name = field(node, "name")?.text;
        if (name && field(node, "value")?.type === "function_type") facts.types.push({ name, kind: "function-type", line });
        break;
      }
      case "abstract_class_declaration":
      case "class_declaration": {
        const name = field(node, "name")?.text;
        if (name) {
          const body = field(node, "body");
          const constructor = body?.namedChildren.find((member) => member.type === "method_definition" && field(member, "name")?.text === "constructor");
          const constructorTypes = parametersOf(constructor ? field(constructor, "parameters") : null).flatMap((p) => p.type.names);
          facts.classes.push({ name, line, heritage: heritageOf(node), constructorTypes });
          if (node.type === "abstract_class_declaration") facts.types.push({ name, kind: "abstract-class", line });
          nextClass = name;
        }
        break;
      }
      case "function_declaration":
      case "generator_function_declaration": {
        const name = field(node, "name")?.text;
        if (name) {
          facts.functions.push({ name, line, parameters: parametersOf(field(node, "parameters")) });
        }
        break;
      }
      case "method_definition": {
        const name = field(node, "name")?.text;
        if (name && className) {
          const qualified = `${className}.${name}`;
          facts.functions.push({ name: qualified, line, parameters: parametersOf(field(node, "parameters")) });
        }
        break;
      }
      case "variable_declarator":
      case "public_field_definition": {
        const nameNode = field(node, "name");
        const value = field(node, "value");
        const name = nameNode?.text;
        if (name && value && (value.type === "arrow_function" || value.type === "function_expression" || value.type === "function")) {
          if (node.type === "variable_declarator" && className === null) {
            facts.functions.push({ name, line, parameters: parametersOf(field(value, "parameters")) });
            }
        }
        if (name && registryName.test(name)) {
          const typeNames = annotation(node.namedChildren.find((child) => child.type === "type_annotation") ?? null).names;
          const isMap = value?.type === "new_expression" && /^(Map|WeakMap)$/.test(lastName(field(value, "constructor")) ?? "");
          if (isMap || value?.type === "object" || typeNames.some((t) => t === "Record" || t === "Map")) facts.keyedMaps.push({ line, name });
        }
        break;
      }
      case "decorator": {
        const name = decoratorName(node);
        if (name) facts.decorators.push({ line, name });
        break;
      }
      case "new_expression": {
        const name = lastName(field(node, "constructor"));
        if (name) facts.news.push({ line, name });
        break;
      }
      case "call_expression": {
        const callee = field(node, "function");
        if (callee?.type === "identifier") {
          facts.calls.push({ line, receiver: null, method: callee.text });
        } else if (callee?.type === "member_expression") {
          const method = lastName(field(callee, "property"));
          const receiver = lastName(field(callee, "object"));
          if (method && receiver) facts.calls.push({ line, receiver, method });
        }
        break;
      }
    }
    for (const child of node.children) visit(child, nextClass);
  };

  visit(root, null);
  return facts;
}
