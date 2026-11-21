import type { Node } from "web-tree-sitter";
import { codeRowsOf, measureFunction } from "../../unit-metrics.ts";
import type { DeclarationKind, FileFacts, ImportFact, SymbolDeclaration, SymbolReference, UnitFact, UnitKind } from "../../facts.ts";
import { nodeCount } from "../typescript/interface-shape.ts";
import { goMetricRules, receiverNameOf } from "./metric-rules.ts";
import { functionShape, isExported, passThroughOf, typeShape } from "./shape.ts";

/** Bump when the extraction rules change in a way that alters facts for the same source. */
export const extractorVersion = 3;

/**
 * Go facts for the symbol-based dependency model with a resolver of its own (resolve-packages.ts). Imports
 * are kept as written. Names a file declares and the names it refers to are kept as written too, in three
 * forms the resolver tells apart by what the file imports:
 *
 * - `Name`: a package-level name, in this package (or one dot-imported).
 * - `alias.Name`: a name of an imported package.
 * - `Type.method`: a method reached through the method's own receiver, which is the one method call whose
 *   target the syntax alone settles. Methods called on other values need types and are not followed.
 *
 * A function, method or struct or interface type is a unit. A function literal is one only when it is bound
 * to a name (`f := func() {}`, `var f = func() {}`), and any other literal belongs to the function around it.
 * Generated files (`// Code generated ... DO NOT EDIT.`) are excluded: their facts are empty.
 */

const GENERATED = /^\/\/ Code generated .* DO NOT EDIT\.$/;

const predeclared = new Set([
  "any", "bool", "byte", "comparable", "complex64", "complex128", "error", "float32", "float64", "int", "int8", "int16", "int32", "int64",
  "rune", "string", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "true", "false", "iota", "nil", "append", "cap", "clear", "close",
  "complex", "copy", "delete", "imag", "len", "make", "max", "min", "new", "panic", "print", "println", "real", "recover", "_",
]);

interface Context {
  /** Qualified name of the innermost enclosing unit. */
  unit: string | undefined;
  /** Names declared in the enclosing functions, which hide package-level names and imports of the same name. */
  locals: ReadonlySet<string>;
  /** The receiver of the method being walked. */
  receiver?: { name: string; type: string };
}

/** True when a line comment above the package clause says the file was generated. */
export function isGeneratedSource(text: string): boolean {
  for (const line of text.split("\n")) {
    const trimmed = line.trimEnd();
    if (GENERATED.test(trimmed)) return true;
    if (/^package\s/.test(trimmed)) return false;
  }
  return false;
}

function stringValue(literal: Node | null): string {
  if (literal === null) return "";
  return literal.text.slice(1, -1);
}

/** The type a method is declared on, without pointer, parentheses or type arguments. */
function receiverTypeOf(method: Node): string | undefined {
  let type: Node | null = method.childForFieldName("receiver")?.namedChildren.find((child) => child.type === "parameter_declaration")?.childForFieldName("type") ?? null;
  while (type !== null && (type.type === "pointer_type" || type.type === "parenthesized_type")) type = type.namedChildren[0] ?? null;
  if (type?.type === "generic_type") type = type.childForFieldName("type");
  return type?.type === "type_identifier" ? type.text : undefined;
}

/** Names the receiver binds for a generic type: `T` of `func (g G[T]) Get()`. */
function receiverTypeParameters(method: Node): string[] {
  let type: Node | null = method.childForFieldName("receiver")?.namedChildren.find((child) => child.type === "parameter_declaration")?.childForFieldName("type") ?? null;
  while (type !== null && type.type === "pointer_type") type = type.namedChildren[0] ?? null;
  if (type?.type !== "generic_type") return [];
  return (type.childForFieldName("type_arguments")?.descendantsOfType("type_identifier") ?? []).map((name) => name.text);
}

const functionLikes = new Set(["function_declaration", "method_declaration", "func_literal"]);

/** Names declared anywhere in a function, not looking inside nested function literals or type expressions. */
function declaredIn(fn: Node): Set<string> {
  const names = new Set<string>();
  const add = (node: Node | null): void => {
    for (const identifier of node?.type === "identifier" ? [node] : (node?.namedChildren ?? [])) if (identifier.type === "identifier") names.add(identifier.text);
  };
  const addParameters = (list: Node | null): void => {
    for (const parameter of list?.namedChildren ?? []) for (const name of parameter.childrenForFieldName("name")) names.add(name.text);
  };
  addParameters(fn.childForFieldName("receiver"));
  addParameters(fn.childForFieldName("parameters"));
  const result = fn.childForFieldName("result");
  if (result?.type === "parameter_list") addParameters(result);
  for (const parameter of fn.childForFieldName("type_parameters")?.namedChildren ?? []) for (const name of parameter.childrenForFieldName("name")) names.add(name.text);
  for (const name of fn.type === "method_declaration" ? receiverTypeParameters(fn) : []) names.add(name);

  const walk = (node: Node): void => {
    for (const child of node.namedChildren) {
      switch (child.type) {
        case "func_literal":
        case "function_type":
        case "interface_type":
          continue;
        case "short_var_declaration":
          add(child.childForFieldName("left"));
          break;
        case "range_clause":
          add(child.childForFieldName("left"));
          break;
        case "receive_statement":
          add(child.childForFieldName("left"));
          break;
        case "type_switch_statement":
          add(child.childForFieldName("alias"));
          break;
        case "var_spec":
        case "const_spec":
          for (const name of child.childrenForFieldName("name")) names.add(name.text);
          break;
        case "type_spec":
        case "type_alias": {
          const name = child.childForFieldName("name");
          if (name !== null) names.add(name.text);
          break;
        }
        default:
      }
      walk(child);
    }
  };
  const body = fn.childForFieldName("body");
  if (body !== null) walk(body);
  return names;
}

class Extractor {
  readonly units: UnitFact[] = [];
  readonly imports: ImportFact[] = [];
  readonly declarations: SymbolDeclaration[] = [];
  readonly references: SymbolReference[] = [];
  /** The node each reference was read from, in step with `references`, kept only when asked for. */
  readonly referenceNodes: Node[] | undefined;
  private readonly nameCounts = new Map<string, number>();
  private codeRows: boolean[] | undefined;
  private root!: Node;
  private readonly explain: boolean;
  /** Struct and interface types the file declares, so a method of one is its child. */
  private readonly typeUnits = new Set<string>();
  /** Exported methods per receiver type, for the interface size of a struct. */
  private readonly exportedMethods = new Map<string, number>();

  constructor(explain: boolean, keepNodes = false) {
    this.explain = explain;
    this.referenceNodes = keepNodes ? [] : undefined;
  }

  extract(root: Node): FileFacts {
    this.root = root;
    let packageName = "";
    for (const child of root.namedChildren) {
      if (child.type === "package_clause") packageName = child.namedChildren[0]?.text ?? "";
    }
    if (isGeneratedSource(root.text)) {
      return { generated: true, units: [], imports: [], reexports: [], exports: [], references: [], symbols: { namespaces: [packageName], uses: [], declarations: [], references: [] }, nodes: 0, hasSyntaxErrors: root.hasError };
    }
    for (const child of root.namedChildren) {
      if (child.type === "type_declaration") {
        for (const spec of child.namedChildren) {
          const type = spec.childForFieldName("type");
          const name = spec.childForFieldName("name")?.text;
          if (spec.type === "type_spec" && name !== undefined && (type?.type === "struct_type" || type?.type === "interface_type")) this.typeUnits.add(name);
        }
      } else if (child.type === "method_declaration") {
        const type = receiverTypeOf(child);
        const name = child.childForFieldName("name")?.text;
        if (type !== undefined && name !== undefined && isExported(name)) this.exportedMethods.set(type, (this.exportedMethods.get(type) ?? 0) + 1);
      }
    }
    const context: Context = { unit: undefined, locals: new Set() };
    for (const child of root.namedChildren) this.topLevel(child, context);
    return {
      units: this.units,
      imports: this.imports,
      reexports: [],
      exports: [],
      references: [],
      symbols: { namespaces: [packageName], uses: [], declarations: this.declarations, references: this.references },
      nodes: nodeCount(root, (node) => node.type === "import_declaration") - 1,
      hasSyntaxErrors: root.hasError,
    };
  }

  private topLevel(node: Node, context: Context): void {
    switch (node.type) {
      case "import_declaration":
        this.importDeclaration(node);
        return;
      case "function_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name === undefined) return;
        if (name !== "init" && name !== "_") this.addDeclaration(name, "function", name, node.startPosition.row + 1);
        this.functionUnit(name, node, node, undefined, context, "function");
        return;
      }
      case "method_declaration": {
        const name = node.childForFieldName("name")?.text;
        const type = receiverTypeOf(node);
        if (name === undefined) return;
        const qualified = type === undefined ? name : `${type}.${name}`;
        if (type !== undefined) this.addDeclaration(qualified, "function", qualified, node.startPosition.row + 1, false);
        const parent = type !== undefined && this.typeUnits.has(type) ? type : undefined;
        this.functionUnit(qualified, node, node, parent, { ...context, unit: undefined }, "method", name, type);
        return;
      }
      case "type_declaration":
        this.typeDeclaration(node, context);
        return;
      case "var_declaration":
      case "const_declaration":
        this.valueDeclaration(node, context, true);
        return;
      default:
        this.walk(node, context, null, null);
    }
  }

  private importDeclaration(node: Node): void {
    for (const spec of node.descendantsOfType("import_spec")) {
      const path = spec.childForFieldName("path");
      const alias = spec.childForFieldName("name");
      const local = alias === null ? "" : alias.type === "dot" ? "." : alias.text;
      this.imports.push({
        specifier: stringValue(path),
        kind: "import",
        typeOnly: false,
        line: spec.startPosition.row + 1,
        bindings: [{ imported: "*", local, typeOnly: false }],
      });
    }
  }

  private addDeclaration(name: string, kind: DeclarationKind, unit: string | undefined, line: number, exported = isExported(name)): void {
    this.declarations.push({ name, kind, ...(unit === undefined ? {} : { unit }), exported, line });
  }

  private nameOf(base: string): string {
    const seen = this.nameCounts.get(base) ?? 0;
    this.nameCounts.set(base, seen + 1);
    return seen === 0 ? base : `${base}~${seen + 1}`;
  }

  /** Declares a function-like unit and walks it. `fn` is the function-like node and `extent` the node whose lines the unit spans. */
  private functionUnit(qualifiedBase: string, fn: Node, extent: Node, parent: string | undefined, context: Context, kind: UnitKind, methodName?: string, receiverType?: string): void {
    const base = context.unit === undefined || kind === "method" ? qualifiedBase : `${context.unit}.${qualifiedBase}`;
    const qualifiedName = this.nameOf(base);
    const unit: UnitFact = { qualifiedName, kind, startLine: extent.startPosition.row + 1, endLine: extent.endPosition.row + 1, source: "structural" };
    const enclosing = parent ?? context.unit;
    if (enclosing !== undefined) unit.parent = enclosing;
    this.codeRows ??= codeRowsOf(this.root, goMetricRules);
    const measured = measureFunction(fn, { name: methodName ?? qualifiedBase.split(".").at(-1), startLine: unit.startLine, endLine: unit.endLine, codeRows: this.codeRows, explain: this.explain }, goMetricRules);
    unit.metrics = measured.metrics;
    unit.shape = functionShape(fn);
    const forwarded = passThroughOf(fn);
    if (forwarded !== undefined) unit.passThrough = forwarded;
    if (measured.increments !== undefined) unit.increments = measured.increments;
    this.units.push(unit);

    const locals = new Set([...context.locals, ...declaredIn(fn)]);
    const receiverName = fn.type === "method_declaration" ? receiverNameOf(fn) : undefined;
    const inner: Context = {
      unit: qualifiedName,
      locals,
      ...(receiverName !== undefined && receiverType !== undefined ? { receiver: { name: receiverName, type: receiverType } } : context.receiver === undefined ? {} : { receiver: context.receiver }),
    };
    for (let i = 0; i < fn.childCount; i++) {
      const child = fn.child(i);
      if (child !== null && child.isNamed) this.walk(child, inner, fn, fn.fieldNameForChild(i));
    }
  }

  private typeDeclaration(node: Node, context: Context): void {
    const specs = node.namedChildren.filter((child) => child.type === "type_spec" || child.type === "type_alias");
    for (const spec of specs) {
      const name = spec.childForFieldName("name")?.text;
      const type = spec.childForFieldName("type");
      if (name === undefined || type === null) continue;
      const kind: DeclarationKind = type.type === "interface_type" ? "interface" : type.type === "struct_type" ? "class" : "type";
      const isUnit = kind !== "type" && spec.type === "type_spec";
      this.addDeclaration(name, kind, isUnit ? name : undefined, spec.startPosition.row + 1);
      const parameters = new Set((spec.childForFieldName("type_parameters")?.namedChildren ?? []).flatMap((parameter) => parameter.childrenForFieldName("name").map((n) => n.text)));
      let inner = context;
      if (isUnit) {
        const extent = specs.length === 1 ? node : spec;
        const unit: UnitFact = { qualifiedName: this.nameOf(name), kind: "class", startLine: extent.startPosition.row + 1, endLine: extent.endPosition.row + 1, source: "structural" };
        unit.shape = typeShape(extent, type, this.exportedMethods.get(name) ?? 0);
        this.units.push(unit);
        inner = { unit: unit.qualifiedName, locals: new Set([...context.locals, ...parameters]) };
      } else if (parameters.size > 0) inner = { ...context, locals: new Set([...context.locals, ...parameters]) };
      this.walk(type, inner, spec, "type");
    }
  }

  /** `var` and `const` declarations. A name bound to a function literal is a unit, and at package level every name is declared. */
  private valueDeclaration(node: Node, context: Context, packageLevel: boolean): void {
    const specs = node.descendantsOfType(node.type === "var_declaration" ? "var_spec" : "const_spec");
    const sole = specs.length === 1;
    for (const spec of specs) {
      const names = spec.childrenForFieldName("name");
      const values = spec.childForFieldName("value")?.namedChildren ?? [];
      const type = spec.childForFieldName("type");
      if (type !== null) this.walk(type, context, spec, "type");
      names.forEach((name, index) => {
        const value = values[index];
        const bound = value?.type === "func_literal" && names.length === values.length;
        if (packageLevel && name.text !== "_") this.addDeclaration(name.text, bound ? "function" : "variable", bound ? name.text : undefined, name.startPosition.row + 1);
        if (bound && value !== undefined) this.functionUnit(name.text, value, sole ? node : spec, undefined, context, "function");
      });
      values.forEach((value, index) => {
        if (!(value.type === "func_literal" && names.length === values.length && names[index] !== undefined)) this.walk(value, context, spec, "value");
      });
    }
  }

  private reference(name: string, kind: "call" | "reference", node: Node, context: Context): void {
    const fact: SymbolReference = { name, kind, line: node.startPosition.row + 1 };
    if (context.unit !== undefined) fact.inUnit = context.unit;
    this.references.push(fact);
    this.referenceNodes?.push(node);
  }

  private bare(node: Node, context: Context, kind: "call" | "reference"): void {
    const name = node.text;
    if (predeclared.has(name) || context.locals.has(name)) return;
    this.reference(name, kind, node, context);
  }

  private walkChildren(node: Node, context: Context): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null && child.isNamed) this.walk(child, context, node, node.fieldNameForChild(i));
    }
  }

  /** Whether an identifier node is a use, not a name being declared. */
  private isUse(node: Node, parent: Node, field: string | null): boolean {
    switch (parent.type) {
      case "function_declaration":
      case "func_literal":
      case "parameter_declaration":
      case "variadic_parameter_declaration":
      case "type_parameter_declaration":
      case "var_spec":
      case "const_spec":
        return field !== "name";
      case "expression_list": {
        const owner = parent.parent;
        if (owner === null) return true;
        const declaring = owner.type === "short_var_declaration" || owner.type === "range_clause" || owner.type === "receive_statement" ? "left" : owner.type === "type_switch_statement" ? "alias" : null;
        return declaring === null || owner.childForFieldName(declaring)?.id !== parent.id;
      }
      default:
        return true;
    }
  }

  private walk(node: Node, context: Context, parent: Node | null, field: string | null): void {
    switch (node.type) {
      case "identifier":
        if (parent === null || this.isUse(node, parent, field)) {
          const isCallee = parent?.type === "call_expression" && field === "function";
          this.bare(node, context, isCallee ? "call" : "reference");
        }
        return;
      case "type_identifier":
        if (parent?.type === "type_spec" && field === "name") return;
        this.bare(node, context, "reference");
        return;
      case "qualified_type": {
        const pkg = node.childForFieldName("package");
        const name = node.childForFieldName("name");
        if (pkg !== null && name !== null) this.reference(`${pkg.text}.${name.text}`, "reference", node, context);
        return;
      }
      case "selector_expression":
        this.selector(node, context, parent?.type === "call_expression" && field === "function" ? "call" : "reference");
        return;
      case "func_literal": {
        const locals = new Set([...context.locals, ...declaredIn(node)]);
        this.walkChildren(node, { ...context, locals });
        return;
      }
      case "short_var_declaration":
      case "assignment_statement":
        this.binding(node, context);
        return;
      case "var_declaration":
      case "const_declaration":
        this.valueDeclaration(node, context, false);
        return;
      case "type_declaration":
        for (const spec of node.namedChildren) {
          const type = spec.childForFieldName("type");
          if (type !== null) this.walk(type, context, spec, "type");
        }
        return;
      case "composite_literal":
        this.compositeLiteral(node, context);
        return;
      case "field_declaration": {
        const type = node.childForFieldName("type");
        if (type !== null) this.walk(type, context, node, "type");
        return;
      }
      case "method_elem":
        for (const child of node.namedChildren) if (child.type !== "field_identifier") this.walk(child, context, node, null);
        return;
      case "package_identifier":
      case "field_identifier":
      case "label_name":
        return;
      default:
        this.walkChildren(node, context);
    }
  }

  private selector(node: Node, context: Context, kind: "call" | "reference"): void {
    const operand = node.childForFieldName("operand");
    const field = node.childForFieldName("field")?.text;
    if (operand === null || field === undefined) return;
    if (operand.type !== "identifier") {
      this.walk(operand, context, node, "operand");
      return;
    }
    const name = operand.text;
    if (context.receiver !== undefined && context.receiver.name === name) {
      this.reference(`${context.receiver.type}.${field}`, kind, node, context);
      return;
    }
    if (context.locals.has(name) || predeclared.has(name)) return;
    this.reference(`${name}.${field}`, kind, node, context);
    this.reference(name, "reference", operand, context);
  }

  /** `a := func() {}` and `a = func() {}` bind a unit when one name takes one literal. */
  private binding(node: Node, context: Context): void {
    const left = node.childForFieldName("left")?.namedChildren ?? [];
    const right = node.childForFieldName("right")?.namedChildren ?? [];
    const pairs = left.length === right.length;
    for (const target of node.type === "assignment_statement" ? left : []) this.walk(target, context, node.childForFieldName("left"), null);
    right.forEach((value, index) => {
      const name = left[index];
      if (pairs && value.type === "func_literal" && name?.type === "identifier" && name.text !== "_") {
        this.functionUnit(name.text, value, left.length === 1 ? node : value, undefined, context, "function");
      } else this.walk(value, context, node.childForFieldName("right"), null);
    });
  }

  /** Keys of a struct literal name fields, not values, so a bare identifier key is only a use when the literal is a map or a slice. */
  private compositeLiteral(node: Node, context: Context): void {
    const type = node.childForFieldName("type");
    if (type !== null) this.walk(type, context, node, "type");
    const keysAreValues = type !== null && ["map_type", "slice_type", "array_type", "implicit_length_array_type"].includes(type.type);
    const visit = (literal: Node): void => {
      for (const element of literal.namedChildren) {
        if (element.type === "keyed_element") {
          const key = element.childForFieldName("key");
          const value = element.childForFieldName("value");
          const bareKey = key?.namedChildren.length === 1 && key.namedChildren[0]?.type === "identifier";
          if (key !== null && (keysAreValues || !bareKey)) this.walkElement(key, context, visit);
          if (value !== null) this.walkElement(value, context, visit);
        } else this.walkElement(element, context, visit);
      }
    };
    const body = node.childForFieldName("body");
    if (body !== null) visit(body);
  }

  private walkElement(element: Node, context: Context, visit: (literal: Node) => void): void {
    const inner = element.type === "literal_element" ? element.namedChildren : [element];
    for (const child of inner) {
      if (child.type === "literal_value") visit(child);
      else this.walk(child, context, element, null);
    }
  }
}

/**
 * Extracts a file's units, imports and symbols from its syntax tree. With `explain`, each function unit
 * also carries where its metric increments came from. Cached facts never have them.
 */
export function extractFacts(root: Node, options: { explain?: boolean } = {}): FileFacts {
  return new Extractor(options.explain === true).extract(root);
}

/**
 * The facts, with the syntax node each of `symbols.references` was read from (a bare name's identifier, the
 * selector of `alias.Name`, the qualified type of `pkg.Name`), so a mover can rewrite them in place. The
 * nodes are only valid while the tree is.
 */
export function extractFactsWithNodes(root: Node): { facts: FileFacts; nodes: Node[] } {
  const extractor = new Extractor(false, true);
  const facts = extractor.extract(root);
  return { facts, nodes: extractor.referenceNodes ?? [] };
}
