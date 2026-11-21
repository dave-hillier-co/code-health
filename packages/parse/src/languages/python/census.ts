import type { Node } from "web-tree-sitter";
import type { FileCensus, ParameterFact } from "../../census-facts.ts";
import { classKind, lastName } from "./extract-facts.ts";

const registryName = /(registry|registries|handlers|plugins|strategies|factories|providers|adapters)$/i;
const mapConstructors = /^(dict|defaultdict|OrderedDict|WeakValueDictionary|WeakKeyDictionary|ChainMap)$/;
const mapAnnotations = new Set(["dict", "Dict", "Mapping", "MutableMapping", "defaultdict", "DefaultDict", "OrderedDict"]);
const dataclassDecorators = new Set(["dataclass", "define", "frozen", "attrs", "s"]);

function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name);
}

/** The last name of the object a method is called on (`self.bus.emit` gives `bus`), or of what a call evaluates (`get_bus().emit` gives `get_bus`). */
function receiverName(node: Node | null): string | null {
  if (node === null) return null;
  switch (node.type) {
    case "identifier":
      return node.text;
    case "attribute":
      return field(node, "attribute")?.text ?? null;
    case "call":
      return receiverName(field(node, "function"));
    case "subscript":
      return receiverName(field(node, "value"));
    case "parenthesized_expression":
      return receiverName(node.namedChildren[0] ?? null);
    default:
      return null;
  }
}

/** Every name an annotation mentions, and whether it holds a `Callable`, ignoring nothing: a callable inside `Optional[...]` is still a callback. */
function annotation(node: Node | null): ParameterFact {
  const names = new Set<string>();
  let callback = false;
  const visit = (current: Node): void => {
    if (current.type === "identifier") {
      names.add(current.text);
      if (current.text === "Callable") callback = true;
    }
    for (const child of current.namedChildren) visit(child);
  };
  if (node !== null) visit(node);
  return { callback, names: [...names].sort() };
}

function parametersOf(fn: Node): { name: string; type: ParameterFact }[] {
  const out: { name: string; type: ParameterFact }[] = [];
  for (const parameter of field(fn, "parameters")?.namedChildren ?? []) {
    if (parameter.type !== "typed_parameter" && parameter.type !== "typed_default_parameter") continue;
    const type = field(parameter, "type");
    if (type === null) continue;
    const name = parameter.type === "typed_default_parameter" ? (field(parameter, "name")?.text ?? "") : (parameter.namedChildren.find((child) => child.type === "identifier")?.text ?? "");
    out.push({ name, type: annotation(type) });
  }
  return out;
}

/** The names the constructor takes: the annotated parameters of `__init__`, and the annotated fields of a dataclass. */
function constructorTypes(declaration: Node): string[] {
  const body = field(declaration, "body");
  const names: string[] = [];
  const decorated = declaration.parent?.type === "decorated_definition" ? declaration.parent : null;
  const isDataclass = decorated?.namedChildren.some((child) => child.type === "decorator" && dataclassDecorators.has(lastName(child.namedChildren[0] ?? null) ?? "")) === true;
  for (const statement of body?.namedChildren ?? []) {
    if (statement.type === "function_definition" && field(statement, "name")?.text === "__init__") {
      names.push(...parametersOf(statement).flatMap((parameter) => parameter.type.names));
    } else if (isDataclass && statement.type === "expression_statement") {
      const assignment = statement.namedChildren[0];
      const type = assignment?.type === "assignment" ? field(assignment, "type") : null;
      if (type !== null && type !== undefined) names.push(...annotation(type).names);
    }
  }
  return names;
}

/** Whether the right side of a registry-named assignment holds a dictionary of some kind. */
function holdsMap(value: Node | null, type: Node | null): boolean {
  if (value?.type === "dictionary" || value?.type === "dictionary_comprehension") return true;
  if (value?.type === "call" && mapConstructors.test(lastName(value) ?? "")) return true;
  return annotation(type).names.some((name) => mapAnnotations.has(name));
}

/** A `Callable[...]` on the right of `Name = ...` or `type Name = ...` makes `Name` a function type. */
function isFunctionType(value: Node | null): boolean {
  if (value === null) return false;
  const base = value.type === "subscript" ? field(value, "value") : value;
  return lastName(base) === "Callable";
}

/** Extracts a file's census facts from its syntax tree. Lines are 1-based. */
export function extractFileCensus(root: Node): FileCensus {
  const facts: FileCensus = { imports: [], types: [], classes: [], functions: [], calls: [], news: [], decorators: [], keyedMaps: [] };

  const visit = (node: Node, owner: string | null): void => {
    const line = node.startPosition.row + 1;
    let nextOwner = owner;

    switch (node.type) {
      case "import_statement":
        for (const name of node.childrenForFieldName("name")) {
          const module = name.type === "aliased_import" ? field(name, "name") : name;
          const alias = name.type === "aliased_import" ? field(name, "alias") : null;
          if (module !== null) facts.imports.push({ local: alias?.text ?? module.text, imported: "*", specifier: module.text });
        }
        return;
      case "import_from_statement": {
        const specifier = field(node, "module_name")?.text ?? "";
        for (const name of node.childrenForFieldName("name")) {
          const imported = name.type === "aliased_import" ? field(name, "name") : name;
          const alias = name.type === "aliased_import" ? field(name, "alias") : null;
          if (imported !== null) facts.imports.push({ local: alias?.text ?? imported.text, imported: imported.text, specifier });
        }
        return;
      }
      case "class_definition": {
        const name = field(node, "name")?.text;
        if (name !== undefined) {
          const qualified = owner === null ? name : `${owner}.${name}`;
          const heritage = (field(node, "superclasses")?.namedChildren ?? []).filter((base) => base.type !== "keyword_argument").map((base) => lastName(base)).filter((base): base is string => base !== undefined);
          facts.classes.push({ name, line, heritage, constructorTypes: constructorTypes(node) });
          const kind = classKind(node);
          if (kind === "interface") facts.types.push({ name, kind: "interface", line });
          else if (kind === "abstract-class") facts.types.push({ name, kind: "abstract-class", line });
          nextOwner = qualified;
        }
        break;
      }
      case "function_definition": {
        const name = field(node, "name")?.text;
        if (name !== undefined) {
          const qualified = owner === null ? name : `${owner}.${name}`;
          const parameters = parametersOf(node);
          facts.functions.push({ name: qualified, line, parameters });
          nextOwner = qualified;
        }
        break;
      }
      case "type_alias_statement": {
        const name = field(node, "left")?.namedChildren[0]?.text;
        if (name !== undefined && isFunctionType(field(node, "right")?.namedChildren[0] ?? null)) facts.types.push({ name, kind: "function-type", line });
        break;
      }
      case "assignment": {
        const left = field(node, "left");
        const value = field(node, "right");
        const type = field(node, "type");
        if (left?.type === "identifier" && isFunctionType(value)) facts.types.push({ name: left.text, kind: "function-type", line });
        const short = left?.type === "attribute" ? field(left, "attribute")?.text : left?.type === "identifier" ? left.text : undefined;
        if (short !== undefined && registryName.test(short) && holdsMap(value, type)) facts.keyedMaps.push({ line, name: short });
        break;
      }
      case "decorator": {
        const expression = node.namedChildren[0] ?? null;
        const name = lastName(expression);
        if (name !== undefined) facts.decorators.push({ line, name });
        break;
      }
      case "call": {
        const callee = field(node, "function");
        if (callee?.type === "identifier") {
          facts.calls.push({ line, receiver: null, method: callee.text });
          if (/^[A-Z]/.test(callee.text)) facts.news.push({ line, name: callee.text });
        } else if (callee?.type === "attribute") {
          const method = field(callee, "attribute")?.text;
          const receiver = receiverName(field(callee, "object"));
          if (method !== undefined && receiver !== null) facts.calls.push({ line, receiver, method });
          if (method !== undefined && /^[A-Z]/.test(method)) facts.news.push({ line, name: method });
        }
        break;
      }
      default:
    }
    for (const child of node.children) visit(child, nextOwner);
  };

  visit(root, null);
  return facts;
}
