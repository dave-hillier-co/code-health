import type { Node } from "web-tree-sitter";
import type { FileCensus, ParameterFact } from "../../census-facts.ts";
import { modifierWords } from "./extract-facts.ts";

const registryName = /(registry|registries|handlers|plugins|strategies|factories|providers|adapters)$/i;
const mapTypes = /^(Map|MutableMap|HashMap|LinkedHashMap|TreeMap|ConcurrentHashMap|ConcurrentMap|EnumMap|SortedMap)$/;
const mapBuilders = /^(mutableMapOf|hashMapOf|linkedMapOf|sortedMapOf|mapOf|HashMap|LinkedHashMap|TreeMap|ConcurrentHashMap)$/;

const lastSegment = (name: string): string => name.slice(name.lastIndexOf(".") + 1);
const identifiersOf = (node: Node): string[] => node.namedChildren.filter((child) => child.type === "identifier").map((child) => child.text);
const comment = (node: Node): boolean => node.type === "line_comment" || node.type === "block_comment";

/** The last name of what an expression names (`this.bus.emit` gives `bus`), or null when it names nothing. */
function lastName(node: Node | null): string | null {
  if (node === null) return null;
  switch (node.type) {
    case "identifier":
      return node.text;
    case "this_expression":
      return "this";
    case "user_type":
      return identifiersOf(node).at(-1) ?? null;
    case "navigation_expression":
      return lastName(node.namedChildren.at(-1) ?? null);
    case "call_expression":
      return lastName(node.namedChildren[0] ?? null);
    case "parenthesized_expression":
      return lastName(node.namedChildren[0] ?? null);
    default:
      return null;
  }
}

/** Every type name a type mentions, and whether a function type appears outside the type arguments of another type. */
function annotation(node: Node | null): ParameterFact {
  const names = new Set<string>();
  let callback = false;
  const visit = (current: Node): void => {
    if (current.type === "user_type") for (const name of identifiersOf(current).slice(-1)) names.add(name);
    if (current.type === "function_type") callback = true;
    for (const child of current.namedChildren) visit(child);
  };
  if (node !== null) visit(node);
  return { callback, names: [...names].sort() };
}

/** The type of a parameter-like node: the first named child that is a type, after its name. */
function typeOf(parameter: Node): Node | null {
  return parameter.namedChildren.find((child) => ["user_type", "nullable_type", "function_type", "parenthesized_type"].includes(child.type)) ?? null;
}

function parametersOf(list: Node | null): { name: string; type: ParameterFact }[] {
  const out: { name: string; type: ParameterFact }[] = [];
  for (const parameter of list?.namedChildren ?? []) {
    if (parameter.type !== "parameter" && parameter.type !== "class_parameter") continue;
    const type = typeOf(parameter);
    if (type === null) continue;
    out.push({ name: parameter.namedChildren.find((child) => child.type === "identifier")?.text ?? "", type: annotation(type) });
  }
  return out;
}

function heritageOf(node: Node): string[] {
  const out: string[] = [];
  const specifiers = node.namedChildren.find((child) => child.type === "delegation_specifiers");
  for (const specifier of specifiers?.namedChildren ?? []) {
    const target = specifier.namedChildren.find((child) => child.type === "constructor_invocation")?.namedChildren.find((child) => child.type === "user_type") ?? specifier.namedChildren.find((child) => child.type === "user_type");
    const name = lastName(target ?? null);
    if (name !== null) out.push(name);
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
      case "import": {
        const name = identifiersOf(node.namedChildren.find((child) => child.type === "qualified_identifier") ?? node).join(".");
        if (name === "" || node.children.some((child) => !child.isNamed && child.type === "*")) break;
        const alias = node.children.some((child) => !child.isNamed && child.type === "as") ? node.namedChildren.filter((child) => child.type === "identifier").at(-1)?.text : undefined;
        facts.imports.push({ local: alias ?? lastSegment(name), imported: lastSegment(name), specifier: name });
        break;
      }
      case "type_alias": {
        const name = node.childForFieldName("type")?.text;
        if (name && node.namedChildren.some((child) => child.type === "function_type")) facts.types.push({ name, kind: "function-type", line });
        break;
      }
      case "object_declaration":
      case "class_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (!name) break;
        const words = modifierWords(node);
        const isInterface = node.children.some((child) => !child.isNamed && child.type === "interface");
        if (isInterface) facts.types.push({ name, kind: "interface", line });
        else if (node.type === "class_declaration" && (words.has("abstract") || words.has("sealed"))) facts.types.push({ name, kind: "abstract-class", line });
        const primary = node.namedChildren.find((child) => child.type === "primary_constructor");
        const secondary = node.namedChildren.find((child) => child.type === "class_body")?.namedChildren.find((member) => member.type === "secondary_constructor");
        const parameters = primary?.namedChildren.find((child) => child.type === "class_parameters") ?? secondary?.namedChildren.find((child) => child.type === "function_value_parameters") ?? null;
        facts.classes.push({ name, line, heritage: heritageOf(node), constructorTypes: parametersOf(parameters).flatMap((p) => p.type.names) });
        nextClass = name;
        break;
      }
      case "function_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (!name) break;
        const parameters = parametersOf(node.namedChildren.find((child) => child.type === "function_value_parameters") ?? null);
        facts.functions.push({ name: className === null ? name : `${className}.${name}`, line, parameters });
        break;
      }
      case "property_declaration": {
        const variable = node.namedChildren.find((child) => child.type === "variable_declaration");
        const name = variable?.namedChildren.find((child) => child.type === "identifier")?.text;
        if (name === undefined || !registryName.test(name)) break;
        const declared = annotation(variable?.namedChildren.find((child) => child.type === "user_type" || child.type === "nullable_type") ?? null).names;
        const value = node.namedChildren.filter((child) => child.id !== variable?.id && !comment(child) && child.type !== "modifiers").at(-1);
        const built = value?.type === "call_expression" ? lastName(value) : null;
        if (declared.some((type) => mapTypes.test(type)) || (built !== null && mapBuilders.test(built))) facts.keyedMaps.push({ line, name });
        break;
      }
      case "annotation": {
        const name = lastName(node.namedChildren.find((child) => child.type === "user_type") ?? null);
        if (name) facts.decorators.push({ line, name });
        break;
      }
      case "call_expression": {
        const callee = node.namedChildren[0];
        if (callee?.type === "identifier") {
          // A call of a capitalised name is a constructor call, which Kotlin writes without `new`.
          if (/^[A-Z]/.test(callee.text)) facts.news.push({ line, name: callee.text });
          else facts.calls.push({ line, receiver: null, method: callee.text });
        } else if (callee?.type === "navigation_expression") {
          const method = lastName(callee);
          const receiver = lastName(callee.namedChildren[0] ?? null);
          if (method && receiver) facts.calls.push({ line, receiver, method });
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
