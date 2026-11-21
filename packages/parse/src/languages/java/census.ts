import type { Node } from "web-tree-sitter";
import type { FileCensus, ParameterFact } from "../../census-facts.ts";
import { modifiersOf } from "./extract-facts.ts";

const registryName = /(registry|registries|handlers|plugins|strategies|factories|providers|adapters)$/i;
const mapTypes = /^(Map|HashMap|LinkedHashMap|TreeMap|ConcurrentHashMap|ConcurrentMap|EnumMap|WeakHashMap|SortedMap)$/;

const field = (node: Node, name: string): Node | null => node.childForFieldName(name);
const lastSegment = (name: string): string => name.slice(name.lastIndexOf(".") + 1);

/** The last name of what an expression names (`this.bus.on` gives `bus`), or null when it names nothing. */
function lastName(node: Node | null): string | null {
  if (node === null) return null;
  switch (node.type) {
    case "identifier":
    case "type_identifier":
      return node.text;
    case "this":
      return "this";
    case "field_access":
      return field(node, "field")?.text ?? null;
    case "scoped_type_identifier":
    case "scoped_identifier":
      return lastSegment(node.text.replace(/\s+/g, ""));
    case "generic_type":
      return lastName(node.namedChildren[0] ?? null);
    case "parenthesized_expression":
      return lastName(node.namedChildren[0] ?? null);
    case "method_invocation":
      return field(node, "name")?.text ?? null;
    default:
      return null;
  }
}

/** Every type name a type mentions. Java has no function type: a callback is a functional interface named in the detectors. */
function annotation(node: Node | null): ParameterFact {
  const names = new Set<string>();
  const visit = (current: Node): void => {
    if (current.type === "type_identifier") names.add(current.text);
    for (const child of current.namedChildren) visit(child);
  };
  if (node !== null) visit(node);
  return { callback: false, names: [...names].sort() };
}

function parametersOf(list: Node | null): { name: string; type: ParameterFact }[] {
  const out: { name: string; type: ParameterFact }[] = [];
  for (const parameter of list?.namedChildren ?? []) {
    if (parameter.type !== "formal_parameter") continue;
    out.push({ name: field(parameter, "name")?.text ?? "", type: annotation(field(parameter, "type")) });
  }
  return out;
}

function heritageOf(node: Node): string[] {
  const out: string[] = [];
  const superclass = field(node, "superclass");
  if (superclass !== null) {
    const name = lastName(superclass.namedChildren[0] ?? null);
    if (name !== null) out.push(name);
  }
  for (const clause of node.namedChildren.filter((child) => child.type === "super_interfaces" || child.type === "extends_interfaces")) {
    for (const list of clause.namedChildren) {
      for (const type of list.type === "type_list" ? list.namedChildren : [list]) {
        const name = lastName(type);
        if (name !== null) out.push(name);
      }
    }
  }
  return out;
}

function importOf(node: Node): { local: string; imported: string; specifier: string } | null {
  const name = node.namedChildren.find((child) => child.type === "scoped_identifier" || child.type === "identifier");
  if (name === undefined || node.namedChildren.some((child) => child.type === "asterisk")) return null;
  const specifier = name.text.replace(/\s+/g, "");
  return { local: lastSegment(specifier), imported: lastSegment(specifier), specifier };
}

/** Extracts a file's census facts from its syntax tree. Lines are 1-based. */
export function extractFileCensus(root: Node): FileCensus {
  const facts: FileCensus = { imports: [], types: [], classes: [], functions: [], calls: [], news: [], decorators: [], keyedMaps: [] };

  const visit = (node: Node, className: string | null): void => {
    const line = node.startPosition.row + 1;
    let nextClass = className;

    switch (node.type) {
      case "import_declaration": {
        const entry = importOf(node);
        if (entry !== null) facts.imports.push(entry);
        break;
      }
      case "interface_declaration": {
        const name = field(node, "name")?.text;
        if (name) facts.types.push({ name, kind: "interface", line });
        if (name) nextClass = name;
        break;
      }
      case "class_declaration":
      case "record_declaration":
      case "enum_declaration": {
        const name = field(node, "name")?.text;
        if (name) {
          const body = field(node, "body");
          const constructor = body?.namedChildren.find((member) => member.type === "constructor_declaration");
          const parameters = node.type === "record_declaration" ? field(node, "parameters") : constructor ? field(constructor, "parameters") : null;
          facts.classes.push({ name, line, heritage: heritageOf(node), constructorTypes: parametersOf(parameters).flatMap((p) => p.type.names) });
          if (node.type === "class_declaration" && modifiersOf(node).has("abstract")) facts.types.push({ name, kind: "abstract-class", line });
          nextClass = name;
        }
        break;
      }
      case "method_declaration":
      case "constructor_declaration": {
        const name = field(node, "name")?.text;
        if (name && className) facts.functions.push({ name: `${className}.${name}`, line, parameters: parametersOf(field(node, "parameters")) });
        break;
      }
      case "field_declaration":
      case "local_variable_declaration": {
        const type = field(node, "type");
        const typeNames = annotation(type).names;
        for (const declarator of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
          const name = field(declarator, "name")?.text;
          if (name === undefined || !registryName.test(name)) continue;
          const value = field(declarator, "value");
          const created = value?.type === "object_creation_expression" ? lastName(field(value, "type")) : null;
          if (typeNames.some((t) => mapTypes.test(t)) || (created !== null && mapTypes.test(created))) facts.keyedMaps.push({ line: declarator.startPosition.row + 1, name });
        }
        break;
      }
      case "marker_annotation":
      case "annotation": {
        const name = lastName(field(node, "name"));
        if (name) facts.decorators.push({ line, name });
        break;
      }
      case "object_creation_expression": {
        const name = lastName(field(node, "type"));
        if (name) facts.news.push({ line, name });
        break;
      }
      case "method_invocation": {
        const method = field(node, "name")?.text;
        const object = field(node, "object");
        if (method !== undefined) {
          if (object === null) facts.calls.push({ line, receiver: null, method });
          else {
            const receiver = lastName(object);
            if (receiver) facts.calls.push({ line, receiver, method });
          }
        }
        break;
      }
      default:
    }
    for (const child of node.children) visit(child, nextClass);
  };

  visit(root, null);
  return facts;
}
