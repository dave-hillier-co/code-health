import type { Node } from "web-tree-sitter";
import type { CallFact, ClassFact, FileCensus, FunctionFact } from "../../census-facts.ts";
import { modifiersOf } from "./interface-shape.ts";
import { lastNameOf } from "./extract-facts.ts";

/**
 * What the census reads from a C# file: the types and their heritage, constructor and method parameter types,
 * calls with their receivers, attributes, and fields that hold a keyed registry. Judging them against the
 * conventions of the ecosystem (containers, MediatR-style handlers, events) is structure's `census/languages/csharp.ts`.
 *
 * A native event is reported through the call that raises it: `Changed?.Invoke(...)` or `Changed(...)` on an
 * event the file declares, as a call of `Invoke` on it. Any other `Invoke` is a delegate call, which is not an event.
 */

const registryName = /(registry|registries|handlers|plugins|strategies|factories|providers|adapters)$/i;
const dictionaryTypes = /^(Dictionary|IDictionary|ConcurrentDictionary|ImmutableDictionary|IReadOnlyDictionary|SortedDictionary|Hashtable|FrozenDictionary)$/;

const classLike = new Set(["class_declaration", "struct_declaration", "record_declaration", "record_struct_declaration"]);

/** Every type name written in a type, with generic arguments, and only the last name of a qualified one. */
function typeNames(node: Node | null, out: Set<string>): void {
  if (node === null) return;
  if (node.type === "identifier") out.add(node.text);
  else if (node.type === "qualified_name") typeNames(node.childForFieldName("name"), out);
  else if (node.type === "generic_name") {
    const name = node.namedChildren[0];
    if (name !== undefined) out.add(name.text);
    for (const list of node.namedChildren.filter((child) => child.type === "type_argument_list")) for (const child of list.namedChildren) typeNames(child, out);
  } else for (const child of node.namedChildren) typeNames(child, out);
}

function parametersOf(list: Node | null): { name: string; type: { callback: boolean; names: string[] } }[] {
  const out: { name: string; type: { callback: boolean; names: string[] } }[] = [];
  for (const parameter of list?.namedChildren ?? []) {
    if (parameter.type !== "parameter") continue;
    const type = parameter.childForFieldName("type");
    if (type === null) continue;
    const names = new Set<string>();
    typeNames(type, names);
    // Whether a type is a callable is the detectors' to say, from its name or its declaration: C# has no structural function types.
    out.push({ name: parameter.childForFieldName("name")?.text ?? "", type: { callback: false, names: [...names].sort() } });
  }
  return out;
}

/** Names of the base types and interfaces, as written without generic arguments. */
function heritageOf(declaration: Node): string[] {
  const out: string[] = [];
  for (const list of declaration.namedChildren.filter((child) => child.type === "base_list")) {
    for (const base of list.namedChildren) {
      const name = lastNameOf(base.type === "primary_constructor_base_type" ? base.namedChildren[0] ?? null : base);
      if (name !== undefined) out.push(name);
    }
  }
  return out;
}

function receiverName(node: Node | null): string | null {
  if (node === null) return null;
  switch (node.type) {
    case "identifier":
      return node.text;
    case "this_expression":
      return "this";
    case "member_access_expression":
      return node.childForFieldName("name")?.text ?? null;
    case "invocation_expression":
      return receiverName(node.childForFieldName("function"));
    case "parenthesized_expression":
    case "postfix_unary_expression":
      return receiverName(node.namedChildren[0] ?? null);
    default:
      return null;
  }
}

/** The method name of a call: `Run`, `Run<T>`, `x.Run`, `x.Run<T>`. */
function methodName(node: Node | null): string | undefined {
  if (node === null) return undefined;
  if (node.type === "identifier") return node.text;
  if (node.type === "generic_name") return node.namedChildren[0]?.text;
  if (node.type === "member_access_expression") return methodName(node.childForFieldName("name"));
  return undefined;
}

export function extractFileCensus(root: Node): FileCensus {
  const facts: FileCensus = { imports: [], types: [], classes: [], functions: [], calls: [], news: [], decorators: [], keyedMaps: [] };
  const events = new Set<string>();
  for (const declared of root.descendantsOfType(["event_field_declaration", "event_declaration"])) {
    if (declared.type === "event_declaration") events.add(declared.childForFieldName("name")?.text ?? "");
    else for (const declarator of declared.descendantsOfType("variable_declarator")) events.add(declarator.childForFieldName("name")?.text ?? "");
  }

  const visit = (node: Node, className: string | null): void => {
    const line = node.startPosition.row + 1;
    let nextClass = className;
    switch (node.type) {
      case "interface_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name !== undefined) facts.types.push({ name, kind: "interface", line });
        break;
      }
      case "delegate_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name !== undefined) facts.types.push({ name, kind: "function-type", line });
        break;
      }
      case "class_declaration":
      case "struct_declaration":
      case "record_declaration":
      case "record_struct_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name === undefined || !classLike.has(node.type)) break;
        // The primary constructor of a record or class, and every explicit one, inject what their parameters name.
        const constructors = [node.namedChildren.find((child) => child.type === "parameter_list") ?? null];
        for (const member of node.childForFieldName("body")?.namedChildren ?? []) if (member.type === "constructor_declaration") constructors.push(member.childForFieldName("parameters"));
        const constructorTypes = constructors.flatMap((list) => parametersOf(list).flatMap((parameter) => parameter.type.names));
        const klass: ClassFact = { name, line, heritage: heritageOf(node), constructorTypes };
        facts.classes.push(klass);
        if (node.type === "class_declaration" && modifiersOf(node).includes("abstract")) facts.types.push({ name, kind: "abstract-class", line });
        nextClass = name;
        break;
      }
      case "method_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name !== undefined && className !== null) {
          const fn: FunctionFact = { name: `${className}.${name}`, line, parameters: parametersOf(node.childForFieldName("parameters")) };
          facts.functions.push(fn);
        }
        break;
      }
      case "attribute": {
        const name = lastNameOf(node.childForFieldName("name"));
        if (name !== undefined) facts.decorators.push({ line, name: name.replace(/Attribute$/, "") });
        break;
      }
      case "object_creation_expression": {
        const name = lastNameOf(node.childForFieldName("type"));
        if (name !== undefined) facts.news.push({ line, name });
        break;
      }
      case "variable_declarator": {
        const name = node.childForFieldName("name")?.text;
        const declaration = node.parent;
        const type = declaration?.type === "variable_declaration" ? declaration.childForFieldName("type") : null;
        if (name !== undefined && registryName.test(name) && isDictionary(node, type)) facts.keyedMaps.push({ line, name });
        break;
      }
      case "property_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name !== undefined && registryName.test(name) && isDictionary(node, node.childForFieldName("type"))) facts.keyedMaps.push({ line, name });
        break;
      }
      case "invocation_expression": {
        const call = callOf(node, line, events);
        if (call !== undefined) facts.calls.push(call);
        break;
      }
      default:
    }
    for (const child of node.namedChildren) visit(child, nextClass);
  };
  visit(root, null);
  return facts;
}

function isDictionary(node: Node, type: Node | null): boolean {
  const names = new Set<string>();
  typeNames(type, names);
  if ([...names].some((name) => dictionaryTypes.test(name))) return true;
  const created = node.descendantsOfType("object_creation_expression")[0];
  const createdName = created === undefined ? undefined : lastNameOf(created.childForFieldName("type"));
  return createdName !== undefined && dictionaryTypes.test(createdName);
}

function callOf(node: Node, line: number, events: ReadonlySet<string>): CallFact | undefined {
  const callee = node.childForFieldName("function");
  if (callee === null) return undefined;
  if (callee.type === "conditional_access_expression") {
    // `Changed?.Invoke(...)`
    const event = callee.childForFieldName("condition");
    const binding = callee.namedChildren.find((child) => child.type === "member_binding_expression");
    const method = binding?.childForFieldName("name")?.text;
    const receiver = receiverName(event);
    if (method === undefined || receiver === null) return undefined;
    return method === "Invoke" && !events.has(receiver) ? undefined : { line, receiver, method };
  }
  const method = methodName(callee);
  if (method === undefined) return undefined;
  if (callee.type === "member_access_expression") {
    const target = callee.childForFieldName("expression");
    const keyword = callee.children[0]?.type;
    const receiver = target === null ? (keyword === "this" || keyword === "base" ? keyword : null) : receiverName(target);
    if (receiver === null) return undefined;
    return method === "Invoke" && !events.has(receiver) ? undefined : { line, receiver, method };
  }
  // `Changed(...)` raises a declared event.
  return events.has(method) ? { line, receiver: method, method: "Invoke" } : { line, receiver: null, method };
}
