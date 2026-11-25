import type { Node } from "web-tree-sitter";
import type { FileCensus, ParameterFact } from "../../census-facts.ts";
import { leavesOf, type Leaf } from "./extract-facts.ts";
import { typeName } from "./metric-rules.ts";

/**
 * The syntactic facts the structure census judges, for Rust.
 *
 * - Interfaces are traits, function types are `type` aliases that hold an `fn` or `Fn` type.
 * - Classes are structs, enums and unions, and each `impl Trait for Type` adds an entry for `Type` whose
 *   heritage is the trait, so a trait implemented in another folder shows as an interface in use. A type's
 *   constructor is the `new` function of its inherent `impl`, and its parameter types are what it is given.
 * - A function takes a callback when a parameter's type holds an `fn` or `Fn` type, or is a generic parameter
 *   bounded by one, of the function or of its `impl` or trait.
 * - Calls are method calls (`bus.emit(x)`, receiver `bus`), paths (`Bus::publish(x)`, receiver `Bus`) and
 *   macros and functions called by name. `Name::new(..)` and `Name { .. }` are the news.
 * - Decorators are attributes: `#[inject]` is `inject`, and `#[derive(Injectable)]` is `Injectable`.
 * - A registry is a field, static or variable named like one that holds a map.
 */

const registryName = /(registry|registries|handlers|plugins|strategies|factories|providers|adapters)$/i;
const mapTypes = /^(HashMap|BTreeMap|IndexMap|DashMap)$/;

function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name);
}

const comment = (node: Node): boolean => node.type === "line_comment" || node.type === "block_comment";

/** The last identifier of a path or receiver expression: `self.bus` is `bus`, `a::B` is `B`. */
function lastName(node: Node | null): string | null {
  if (node === null) return null;
  switch (node.type) {
    case "identifier":
    case "type_identifier":
    case "field_identifier":
      return node.text;
    case "self":
      return "self";
    case "scoped_identifier":
    case "scoped_type_identifier":
      return lastName(field(node, "name"));
    case "field_expression":
      return lastName(field(node, "field"));
    case "generic_type":
      return lastName(field(node, "type"));
    case "reference_expression":
    case "parenthesized_expression":
    case "try_expression":
    case "await_expression":
      return lastName(node.namedChildren.find((child) => !comment(child)) ?? null);
    case "call_expression":
      return lastName(field(node, "function"));
    default:
      return null;
  }
}

/** The path that names a trait or type in a header, without its generic arguments. */
function nameOf(node: Node | null): string | null {
  return node === null ? null : (typeName(node) ?? lastName(node));
}

/** Type names that appear, and whether an `fn` or `Fn` type appears anywhere in the annotation. */
function annotation(node: Node | null, callbackParameters: ReadonlySet<string>): ParameterFact {
  const names = new Set<string>();
  let callback = false;
  const visit = (current: Node): void => {
    if (current.type === "type_identifier") {
      names.add(current.text);
      if (callbackParameters.has(current.text)) callback = true;
    }
    if (current.type === "function_type") callback = true;
    for (const child of current.namedChildren) visit(child);
  };
  if (node !== null) visit(node);
  return { callback, names: [...names].sort() };
}

/**
 * Generic parameters of a function or an `impl` that are bounded by an `fn` or `Fn` type, in the list or in a
 * where clause. An `impl`'s are in scope in each of its methods.
 */
function callbackGenerics(fn: Node, inherited: ReadonlySet<string> = new Set()): Set<string> {
  const names = new Set<string>(inherited);
  for (const parameter of field(fn, "type_parameters")?.namedChildren ?? []) {
    const bounds = field(parameter, "bounds");
    const name = field(parameter, "name")?.text;
    if (name !== undefined && bounds?.descendantsOfType("function_type").length) names.add(name);
  }
  for (const predicate of fn.namedChildren.filter((child) => child.type === "where_clause").flatMap((clause) => clause.namedChildren)) {
    const name = field(predicate, "left")?.text;
    if (name !== undefined && field(predicate, "bounds")?.descendantsOfType("function_type").length) names.add(name);
  }
  return names;
}

function parametersOf(fn: Node, inherited: ReadonlySet<string>): { name: string; type: ParameterFact }[] {
  const generics = callbackGenerics(fn, inherited);
  const out: { name: string; type: ParameterFact }[] = [];
  for (const parameter of field(fn, "parameters")?.namedChildren ?? []) {
    if (parameter.type !== "parameter") continue;
    out.push({ name: field(parameter, "pattern")?.text ?? "", type: annotation(field(parameter, "type"), generics) });
  }
  return out;
}

function attributeNames(attribute: Node): string[] {
  const name = attribute.namedChildren[0];
  if (name === undefined) return [];
  const own = nameOf(name) ?? lastName(name);
  if (own === "derive") return field(attribute, "arguments")?.namedChildren.filter((child) => child.type === "identifier").map((child) => child.text) ?? [];
  return own === null ? [] : [own];
}

/** Extracts a file's census facts from its syntax tree. Lines are 1-based. */
export function extractFileCensus(root: Node): FileCensus {
  const facts: FileCensus = { imports: [], types: [], classes: [], functions: [], calls: [], news: [], decorators: [], keyedMaps: [] };
  const constructors = new Map<string, string[]>();

  // `generics` are the callback-bounded type parameters of the enclosing `impl` or trait.
  const visit = (node: Node, owner: string | null, generics: ReadonlySet<string>): void => {
    const line = node.startPosition.row + 1;
    let nextOwner = owner;
    let nextGenerics = generics;
    switch (node.type) {
      case "use_declaration": {
        // The names a `use` binds, for finding where a trait came from.
        const leaves: Leaf[] = [];
        leavesOf(field(node, "argument"), [], leaves);
        for (const leaf of leaves) {
          if (leaf.glob || leaf.segments.length === 0) continue;
          const imported = leaf.segments.at(-1)!;
          facts.imports.push({ local: leaf.alias ?? imported, imported, specifier: leaf.segments.slice(0, -1).join("::") });
        }
        return;
      }
      case "trait_item": {
        const name = field(node, "name")?.text;
        if (name !== undefined) facts.types.push({ name, kind: "interface", line });
        nextOwner = name ?? owner;
        nextGenerics = callbackGenerics(node);
        break;
      }
      case "type_item": {
        const name = field(node, "name")?.text;
        const value = field(node, "type");
        if (name !== undefined && value !== null && (value.type === "function_type" || value.descendantsOfType("function_type").length > 0)) facts.types.push({ name, kind: "function-type", line });
        break;
      }
      case "struct_item":
      case "enum_item":
      case "union_item": {
        const name = field(node, "name")?.text;
        if (name !== undefined) {
          facts.classes.push({ name, line, heritage: [], constructorTypes: [] });
          nextOwner = name;
        }
        break;
      }
      case "impl_item": {
        const type = nameOf(field(node, "type"));
        const trait = nameOf(field(node, "trait"));
        nextGenerics = callbackGenerics(node);
        if (type !== null && trait !== null) facts.classes.push({ name: type, line, heritage: [trait], constructorTypes: [] });
        if (type !== null && trait === null) {
          const body = field(node, "body");
          const constructor = body?.namedChildren.find((member) => member.type === "function_item" && field(member, "name")?.text === "new");
          if (constructor !== undefined) constructors.set(type, [...(constructors.get(type) ?? []), ...parametersOf(constructor, nextGenerics).flatMap((parameter) => parameter.type.names)]);
        }
        nextOwner = type;
        break;
      }
      case "function_item": {
        const name = field(node, "name")?.text;
        if (name !== undefined) facts.functions.push({ name: owner === null ? name : `${owner}.${name}`, line, parameters: parametersOf(node, generics) });
        // An item inside the body does not see the enclosing generics.
        nextGenerics = new Set();
        break;
      }
      case "attribute_item": {
        const attribute = node.namedChildren.find((child) => child.type === "attribute");
        if (attribute !== undefined) for (const name of attributeNames(attribute)) facts.decorators.push({ line, name });
        return;
      }
      case "field_declaration":
      case "static_item":
      case "const_item":
      case "let_declaration": {
        const nameNode = field(node, node.type === "let_declaration" ? "pattern" : "name");
        const name = nameNode?.type === "identifier" || nameNode?.type === "field_identifier" ? nameNode.text : undefined;
        if (name !== undefined && registryName.test(name)) {
          const declared = field(node, "type");
          const value = field(node, "value");
          const typeNames = annotation(declared, new Set()).names;
          const constructs = value?.type === "call_expression" && mapTypes.test(nameOf(field(field(value, "function") ?? value, "path")) ?? "");
          if (typeNames.some((type) => mapTypes.test(type)) || constructs) facts.keyedMaps.push({ line, name });
        }
        break;
      }
      case "call_expression": {
        const callee = field(node, "function");
        if (callee?.type === "identifier") facts.calls.push({ line, receiver: null, method: callee.text });
        else if (callee?.type === "field_expression") {
          const method = lastName(field(callee, "field"));
          const receiver = lastName(field(callee, "value"));
          if (method !== null && receiver !== null) facts.calls.push({ line, receiver, method });
        } else if (callee?.type === "scoped_identifier") {
          const method = lastName(field(callee, "name"));
          const receiver = lastName(field(callee, "path"));
          if (method !== null && receiver !== null) {
            facts.calls.push({ line, receiver, method });
            if (method === "new" || method === "default") facts.news.push({ line, name: receiver });
          }
        }
        break;
      }
      case "macro_invocation": {
        const name = lastName(field(node, "macro"));
        if (name !== null) facts.calls.push({ line, receiver: null, method: name });
        break;
      }
      case "struct_expression": {
        const name = nameOf(field(node, "name"));
        if (name !== null) facts.news.push({ line, name });
        break;
      }
      default:
    }
    for (const child of node.children) visit(child, nextOwner, nextGenerics);
  };

  visit(root, null, new Set());
  for (const klass of facts.classes) {
    if (klass.heritage.length === 0) klass.constructorTypes = [...new Set(constructors.get(klass.name) ?? [])].sort();
  }
  return facts;
}
