import type { Node } from "web-tree-sitter";
import type { CallFact, FileCensus, ParameterFact } from "../../census-facts.ts";
import { defaultPackageName } from "./go-mod.ts";

/**
 * What the census reads of a Go file. Go has no classes, decorators or inheritance, so the facts take the
 * forms the language has:
 *
 * - A struct type is a class. Its heritage is what it embeds, and its constructor is the function
 *   `New<Name>` (or `New`) of the file, whose parameter types are what it is given.
 * - An interface type is an interface, and a named function type is a function type.
 * - Struct tags stand where decorators do: `inject:"..."` is the decorator `inject`.
 * - `new(T)` is a `new` expression.
 */

const registryName = /(registry|registries|handlers|plugins|strategies|factories|providers|adapters)$/i;

/** The last name of the value a method is called on (`s.bus.Publish` gives `bus`), or null. */
function lastName(node: Node | null): string | null {
  if (node === null) return null;
  switch (node.type) {
    case "identifier":
    case "field_identifier":
    case "package_identifier":
      return node.text;
    case "selector_expression":
      return lastName(node.childForFieldName("field"));
    case "parenthesized_expression":
      return lastName(node.namedChildren[0] ?? null);
    case "call_expression":
      return lastName(node.childForFieldName("function"));
    case "unary_expression":
      return lastName(node.childForFieldName("operand"));
    default:
      return null;
  }
}

/** Every type name an annotation mentions, and whether a function type appears outside a struct or interface type. */
function annotation(node: Node | null): ParameterFact {
  const names = new Set<string>();
  let callback = false;
  const visit = (current: Node, inside: boolean): void => {
    if (current.type === "type_identifier") names.add(current.text);
    if (current.type === "function_type" && !inside) callback = true;
    const nested = inside || current.type === "struct_type" || current.type === "interface_type";
    for (const child of current.namedChildren) visit(child, nested);
  };
  if (node !== null) visit(node, false);
  return { callback, names: [...names].sort() };
}

function parametersOf(list: Node | null): { name: string; type: ParameterFact }[] {
  const out: { name: string; type: ParameterFact }[] = [];
  for (const parameter of list?.namedChildren ?? []) {
    if (parameter.type !== "parameter_declaration" && parameter.type !== "variadic_parameter_declaration") continue;
    const type = annotation(parameter.childForFieldName("type"));
    const names = parameter.childrenForFieldName("name");
    if (names.length === 0) out.push({ name: "", type });
    else for (const name of names) out.push({ name: name.text, type });
  }
  return out;
}

/** The embedded types of a struct, by the name they are reached through: `Base` for `Base`, `*Base` and `pkg.Base`. */
function embeddedTypes(struct: Node): string[] {
  const out: string[] = [];
  for (const field of struct.descendantsOfType("field_declaration")) {
    if (field.childrenForFieldName("name").length > 0) continue;
    let type = field.childForFieldName("type");
    while (type?.type === "pointer_type") type = type.namedChildren[0] ?? null;
    if (type?.type === "generic_type") type = type.childForFieldName("type");
    const name = type?.type === "qualified_type" ? type.childForFieldName("name") : type;
    if (name !== null && name !== undefined) out.push(name.text);
  }
  return out;
}

function receiverTypeOf(method: Node): string | undefined {
  let type: Node | null = method.childForFieldName("receiver")?.namedChildren[0]?.childForFieldName("type") ?? null;
  while (type?.type === "pointer_type") type = type.namedChildren[0] ?? null;
  if (type?.type === "generic_type") type = type.childForFieldName("type");
  return type?.text;
}

function tagKeys(tag: Node): string[] {
  const text = tag.text.slice(1, -1);
  return [...text.matchAll(/([A-Za-z_][\w-]*):"/g)].map((match) => match[1]!);
}

function isMapValue(value: Node | null): boolean {
  if (value === null) return false;
  if (value.type === "composite_literal") return value.childForFieldName("type")?.type === "map_type";
  if (value.type === "call_expression") return value.childForFieldName("function")?.text === "make" && value.childForFieldName("arguments")?.namedChildren[0]?.type === "map_type";
  return false;
}

/** Extracts a file's census facts from its syntax tree. Lines are 1-based. */
export function extractFileCensus(root: Node): FileCensus {
  const facts: FileCensus = { imports: [], types: [], classes: [], functions: [], calls: [], news: [], decorators: [], keyedMaps: [] };

  const constructors = new Map<string, string[]>();
  for (const child of root.namedChildren) {
    if (child.type !== "function_declaration") continue;
    const name = child.childForFieldName("name")?.text ?? "";
    if (name.startsWith("New")) constructors.set(name, parametersOf(child.childForFieldName("parameters")).flatMap((parameter) => parameter.type.names));
  }

  const visit = (node: Node): void => {
    const line = node.startPosition.row + 1;
    switch (node.type) {
      case "import_spec": {
        const path = node.childForFieldName("path")?.text.slice(1, -1) ?? "";
        const alias = node.childForFieldName("name");
        if (alias?.type === "dot" || alias?.type === "blank_identifier") break;
        facts.imports.push({ local: alias?.text ?? defaultPackageName(path), imported: "*", specifier: path });
        break;
      }
      case "type_spec": {
        const name = node.childForFieldName("name")?.text;
        const type = node.childForFieldName("type");
        if (name === undefined || type === null) break;
        if (type.type === "interface_type") facts.types.push({ name, kind: "interface", line });
        else if (type.type === "function_type") facts.types.push({ name, kind: "function-type", line });
        else if (type.type === "struct_type") {
          facts.classes.push({ name, line, heritage: embeddedTypes(type), constructorTypes: constructors.get(`New${name}`) ?? constructors.get("New") ?? [] });
        }
        break;
      }
      case "field_declaration": {
        const tag = node.childForFieldName("tag");
        if (tag !== null) for (const key of tagKeys(tag)) facts.decorators.push({ line, name: key });
        const name = node.childrenForFieldName("name")[0]?.text;
        if (name !== undefined && registryName.test(name) && node.childForFieldName("type")?.type === "map_type") facts.keyedMaps.push({ line, name });
        break;
      }
      case "function_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name !== undefined) facts.functions.push({ name, line, parameters: parametersOf(node.childForFieldName("parameters")) });
        break;
      }
      case "method_declaration": {
        const name = node.childForFieldName("name")?.text;
        const type = receiverTypeOf(node);
        if (name !== undefined && type !== undefined) facts.functions.push({ name: `${type}.${name}`, line, parameters: parametersOf(node.childForFieldName("parameters")) });
        break;
      }
      case "var_spec":
      case "const_spec": {
        const values = node.childForFieldName("value")?.namedChildren ?? [];
        const declared = node.childForFieldName("type");
        node.childrenForFieldName("name").forEach((name, index) => {
          if (registryName.test(name.text) && (declared?.type === "map_type" || isMapValue(values[index] ?? null))) facts.keyedMaps.push({ line: name.startPosition.row + 1, name: name.text });
        });
        break;
      }
      case "short_var_declaration": {
        const values = node.childForFieldName("right")?.namedChildren ?? [];
        (node.childForFieldName("left")?.namedChildren ?? []).forEach((name, index) => {
          if (registryName.test(name.text) && isMapValue(values[index] ?? null)) facts.keyedMaps.push({ line, name: name.text });
        });
        break;
      }
      case "call_expression": {
        const callee = node.childForFieldName("function");
        if (callee?.type === "identifier") {
          if (callee.text === "new") {
            const type = node.childForFieldName("arguments")?.namedChildren[0];
            const name = type?.type === "qualified_type" ? type.childForFieldName("name")?.text : type?.text;
            if (name !== undefined) facts.news.push({ line, name });
          }
          facts.calls.push({ line, receiver: null, method: callee.text } satisfies CallFact);
        } else if (callee?.type === "selector_expression") {
          const method = callee.childForFieldName("field")?.text;
          const receiver = lastName(callee.childForFieldName("operand"));
          if (method !== undefined && receiver !== null) facts.calls.push({ line, receiver, method });
        }
        break;
      }
      default:
    }
    for (const child of node.namedChildren) visit(child);
  };

  visit(root);
  return facts;
}
