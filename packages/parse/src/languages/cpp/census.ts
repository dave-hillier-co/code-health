import type { Node } from "web-tree-sitter";
import type { FileCensus, ParameterFact } from "../../census-facts.ts";
import { classAbstraction } from "./abstraction.ts";
import { countParameters, declaratorName, functionDeclarator } from "./metric-rules.ts";

const registryName = /(registry|registries|handlers|plugins|strategies|factories|providers|adapters)_?$/i;
const mapTypes = /map$/i;
const macroName = /^[A-Z][A-Z0-9_]{2,}$/;

const classTypes = new Set(["class_specifier", "struct_specifier", "union_specifier"]);

function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name);
}

/** The last identifier of a name: `a::b::C<T>` is `C`. */
function lastName(node: Node | null): string | null {
  if (node === null) return null;
  switch (node.type) {
    case "identifier":
    case "field_identifier":
    case "type_identifier":
    case "namespace_identifier":
      return node.text;
    case "this":
      return "this";
    case "qualified_identifier":
      return lastName(field(node, "name"));
    case "template_type":
    case "template_function":
    case "template_method":
      return lastName(field(node, "name"));
    case "field_expression":
      return lastName(field(node, "field"));
    case "parenthesized_expression":
    case "pointer_expression":
      return lastName(node.namedChildren[0] ?? null);
    case "call_expression":
      return lastName(field(node, "function"));
    default:
      return null;
  }
}

/** The type names a declaration mentions, and whether it holds a callable type (`std::function`, or a function pointer). */
function typeFact(type: Node | null, functionPointer: boolean): ParameterFact {
  const names = new Set<string>();
  let callback = functionPointer;
  const visit = (current: Node): void => {
    if (current.type === "type_identifier") {
      names.add(current.text);
      if (current.text === "function" && current.parent?.type === "template_type") callback = true;
    }
    if (current.type === "abstract_function_declarator" || current.type === "function_declarator") callback = true;
    for (const child of current.namedChildren) visit(child);
  };
  if (type !== null) visit(type);
  return { callback, names: [...names].sort() };
}

function parameterFacts(list: Node | null): { name: string; type: ParameterFact }[] {
  const out: { name: string; type: ParameterFact }[] = [];
  for (const parameter of list?.namedChildren ?? []) {
    if (parameter.type !== "parameter_declaration" && parameter.type !== "optional_parameter_declaration") continue;
    const declarator = field(parameter, "declarator");
    let name = "";
    for (let current: Node | null = declarator; current !== null; ) {
      if (current.type === "identifier") {
        name = current.text;
        break;
      }
      current = field(current, "declarator") ?? current.namedChildren.find((child) => child.type.endsWith("declarator") || child.type === "identifier") ?? null;
    }
    out.push({ name, type: typeFact(field(parameter, "type"), declarator !== null && hasFunctionDeclarator(declarator)) });
  }
  return out;
}

function hasFunctionDeclarator(node: Node): boolean {
  return node.type === "function_declarator" || node.descendantsOfType(["function_declarator"]).length > 0;
}

function heritageOf(node: Node): string[] {
  const out: string[] = [];
  const clause = node.namedChildren.find((child) => child.type === "base_class_clause");
  for (const base of clause?.namedChildren ?? []) {
    if (base.type === "access_specifier" || base.type === "virtual_specifier") continue;
    const name = lastName(base);
    if (name !== null) out.push(name);
  }
  return out;
}

function isFunctionTypeAlias(type: Node | null): boolean {
  if (type === null) return false;
  const descriptor = type.type === "type_descriptor" ? type : null;
  const inner = descriptor === null ? type : descriptor;
  if (inner.descendantsOfType(["abstract_function_declarator", "function_declarator"]).length > 0 && inner.descendantsOfType(["template_type"]).length === 0) return true;
  return inner.descendantsOfType(["template_type"]).some((template) => lastName(template) === "function");
}

/** Extracts a file's census facts from its syntax tree. Lines are 1-based. */
export function extractFileCensus(root: Node): FileCensus {
  const facts: FileCensus = { imports: [], types: [], classes: [], functions: [], calls: [], news: [], decorators: [], keyedMaps: [] };

  const visit = (node: Node, className: string | null, atFileLevel: boolean): void => {
    const line = node.startPosition.row + 1;
    let nextClass = className;
    let nextFileLevel = atFileLevel;

    switch (node.type) {
      case "class_specifier":
      case "struct_specifier":
      case "union_specifier": {
        const nameNode = field(node, "name");
        const body = field(node, "body");
        const name = lastName(nameNode);
        if (name !== null && body !== null) {
          const kind = classAbstraction(node);
          if (kind === "interface" || kind === "abstract-class") facts.types.push({ name, kind, line });
          const constructorTypes = new Set<string>();
          for (const member of body.namedChildren) {
            const target = member.type === "template_declaration" ? (member.namedChildren.find((child) => child.type !== "template_parameter_list") ?? member) : member;
            const declarator = target.type === "function_definition" || target.type === "declaration" || target.type === "field_declaration" ? functionDeclarator(target) : null;
            if (declaratorName(declarator)?.name !== name) continue;
            for (const parameter of parameterFacts(field(declarator!, "parameters"))) for (const type of parameter.type.names) constructorTypes.add(type);
          }
          facts.classes.push({ name, line, heritage: heritageOf(node), constructorTypes: [...constructorTypes].sort() });
          nextClass = name;
        }
        nextFileLevel = false;
        break;
      }
      case "alias_declaration": {
        const name = field(node, "name")?.text;
        if (name !== undefined && isFunctionTypeAlias(field(node, "type"))) facts.types.push({ name, kind: "function-type", line });
        break;
      }
      case "type_definition": {
        const declarator = field(node, "declarator");
        if (declarator !== null && declarator.descendantsOfType(["function_declarator"]).length + (declarator.type === "function_declarator" ? 1 : 0) > 0) {
          let name: string | null = null;
          for (let current: Node | null = declarator; current !== null; current = field(current, "declarator") ?? current.namedChildren.find((child) => child.type.endsWith("declarator") || child.type === "type_identifier") ?? null) {
            if (current.type === "type_identifier") {
              name = current.text;
              break;
            }
          }
          if (name !== null) facts.types.push({ name, kind: "function-type", line });
        }
        break;
      }
      case "function_definition": {
        const declarator = functionDeclarator(node);
        const named = declaratorName(declarator);
        if (declarator !== null && named !== null) {
          const owner = named.qualifier.length > 0 ? named.qualifier.at(-1)! : className;
          facts.functions.push({ name: owner === null || owner === undefined ? named.name : `${owner}.${named.name}`, line, parameters: parameterFacts(field(declarator, "parameters")) });
        }
        nextFileLevel = false;
        break;
      }
      case "declaration": {
        const type = field(node, "type");
        if (type?.type === "type_identifier" && (type.text === "emit" || type.text === "Q_EMIT")) facts.calls.push({ line, receiver: null, method: "emit" });
        if (type?.type === "type_identifier" && macroName.test(type.text)) facts.decorators.push({ line, name: type.text });
        const declarator = functionDeclarator(node);
        const named = declaratorName(declarator);
        if (atFileLevel && declarator?.type === "function_declarator" && named !== null && named.qualifier.length === 0) {
          facts.functions.push({ name: named.name, line, parameters: parameterFacts(field(declarator, "parameters")) });
        }
        collectMap(node, line);
        break;
      }
      case "field_declaration": {
        const type = field(node, "type");
        if (type?.type === "type_identifier" && macroName.test(type.text)) facts.decorators.push({ line, name: type.text });
        collectMap(node, line);
        break;
      }
      case "attribute": {
        const name = lastName(field(node, "name"));
        if (name !== null) facts.decorators.push({ line, name });
        break;
      }
      case "expression_statement": {
        const call = node.namedChildren[0];
        const callee = call?.type === "call_expression" ? field(call, "function") : null;
        if (callee?.type === "identifier" && macroName.test(callee.text)) facts.decorators.push({ line, name: callee.text });
        break;
      }
      case "new_expression": {
        const name = lastName(field(node, "type"));
        if (name !== null) facts.news.push({ line, name });
        break;
      }
      case "call_expression": {
        const callee = field(node, "function");
        if (callee === null) break;
        if (callee.type === "identifier") facts.calls.push({ line, receiver: null, method: callee.text });
        else if (callee.type === "qualified_identifier") {
          const method = lastName(callee);
          const receiver = lastName(field(callee, "scope"));
          if (method !== null) facts.calls.push({ line, receiver: receiver === "std" ? null : receiver, method });
        } else if (callee.type === "field_expression") {
          const method = lastName(field(callee, "field"));
          const receiver = lastName(field(callee, "argument"));
          if (method !== null && receiver !== null) facts.calls.push({ line, receiver, method });
        } else if (callee.type === "template_function") {
          const method = lastName(callee);
          if (method !== null) facts.calls.push({ line, receiver: null, method });
        }
        break;
      }
      case "namespace_definition":
      case "linkage_specification":
      case "translation_unit":
      case "declaration_list":
      case "template_declaration":
      case "preproc_if":
      case "preproc_ifdef":
      case "preproc_else":
      case "preproc_elif":
        break;
      default:
        nextFileLevel = false;
    }
    for (const child of node.children) visit(child, nextClass, nextFileLevel);
  };

  /** Variables and fields that look like a registry and hold a map. */
  const collectMap = (node: Node, line: number): void => {
    const type = field(node, "type");
    const holdsMap = type !== null && (type.type === "template_type" || type.type === "qualified_identifier") && mapTypes.test(lastName(type) ?? "");
    if (!holdsMap) return;
    for (let i = 0; i < node.childCount; i++) {
      if (node.fieldNameForChild(i) !== "declarator") continue;
      let current: Node | null = node.child(i);
      while (current !== null && current.type !== "identifier" && current.type !== "field_identifier") current = field(current, "declarator") ?? current.namedChildren.find((child) => child.type.endsWith("declarator") || child.type === "identifier" || child.type === "field_identifier") ?? null;
      if (current !== null && registryName.test(current.text)) facts.keyedMaps.push({ line, name: current.text });
    }
  };

  visit(root, null, true);
  return facts;
}
