import type { Node } from "web-tree-sitter";
import type { DeclarationKind, FileFacts, SymbolDeclaration, SymbolReference, UnitFact, UnitKind } from "../../facts.ts";
import type { ExtractOptions } from "../../language-adapter.ts";
import { codeRowsOf, measureFunction } from "../../unit-metrics.ts";
import { functionShape, modifiersOf, nodeCount, passThroughOf, typeShape } from "./interface-shape.ts";
import { bodyOf, csharpMetricRules, parameterInfo } from "./metric-rules.ts";

/** Bump when the extraction rules change in a way that alters facts for the same source, so cached facts are not reused. */
export const extractorVersion = 3;

const typeDeclarations = new Set([
  "class_declaration",
  "struct_declaration",
  "interface_declaration",
  "record_declaration",
  "record_struct_declaration",
  "enum_declaration",
  "delegate_declaration",
]);

const memberFunctions = new Set(["method_declaration", "constructor_declaration", "destructor_declaration", "operator_declaration", "conversion_operator_declaration"]);

interface Context {
  /** Qualified name within the file of the innermost enclosing unit. */
  unit: string | undefined;
  /** Type parameters in scope, which are not references to types. */
  shadow: ReadonlySet<string>;
  /** Whether everything enclosing is visible outside the assembly, so a public type here is exported. */
  visible: boolean;
}

function kindOf(node: Node, modifiers: readonly string[]): DeclarationKind {
  switch (node.type) {
    case "interface_declaration":
      return "interface";
    case "enum_declaration":
      return "enum";
    case "delegate_declaration":
      return "type";
    default:
      return modifiers.includes("abstract") && node.type === "class_declaration" ? "abstract-class" : "class";
  }
}

/** First row of a declaration after its attributes, which are not part of its range. */
function startRow(node: Node): number {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null && child.type !== "attribute_list") return child.startPosition.row;
  }
  return node.startPosition.row;
}

/** The names a qualified or generic name is written with: `A.B<C>.D` is `A`, `B`, `D`. Undefined when it is not a plain chain of names. */
function chainOf(node: Node | null): string[] | undefined {
  if (node === null) return undefined;
  switch (node.type) {
    case "identifier":
      return [node.text];
    case "generic_name":
      return [node.namedChildren[0]?.text ?? ""];
    case "qualified_name": {
      const qualifier = chainOf(node.childForFieldName("qualifier"));
      const name = chainOf(node.childForFieldName("name"));
      return qualifier === undefined || name === undefined ? undefined : [...qualifier, ...name];
    }
    case "member_access_expression": {
      const name = chainOf(node.childForFieldName("name"));
      if (name === undefined) return undefined;
      const target = node.childForFieldName("expression");
      if (target === null) return undefined;
      const qualifier = chainOf(target);
      return qualifier === undefined ? undefined : [...qualifier, ...name];
    }
    default:
      return undefined;
  }
}

/** The last name of a type as written, without namespace or generic arguments. */
export function lastNameOf(node: Node | null): string | undefined {
  const chain = chainOf(node);
  return chain?.at(-1);
}

class Extractor {
  readonly units: UnitFact[] = [];
  private readonly declarations: SymbolDeclaration[] = [];
  private readonly references: SymbolReference[] = [];
  private readonly namespaces: string[] = [];
  private readonly uses: string[] = [];
  private readonly globalUses: string[] = [];
  private readonly aliases = new Map<string, string[]>();
  private readonly nameCounts = new Map<string, number>();
  private namespace = "";
  private codeRows: boolean[] | undefined;
  private root: Node | undefined;
  private readonly explain: boolean;

  constructor(options: ExtractOptions) {
    this.explain = options.explain === true;
  }

  extract(root: Node): FileFacts {
    this.root = root;
    this.usings(root);
    this.members(root, { unit: undefined, shadow: new Set(), visible: true });
    const symbols: NonNullable<FileFacts["symbols"]> = { namespaces: this.namespaces, uses: this.uses, declarations: this.declarations, references: this.references };
    if (this.globalUses.length > 0) symbols.globalUses = this.globalUses;
    return {
      units: this.units,
      imports: [],
      reexports: [],
      exports: [],
      references: [],
      symbols,
      nodes: nodeCount(root, (node) => node.type === "using_directive") - 1,
      hasSyntaxErrors: root.hasError,
    };
  }

  // ---- usings ----

  /** `using` directives of the whole file, wherever they sit: scopes are file-wide here, which is the heuristic's price. */
  private usings(root: Node): void {
    for (const directive of root.descendantsOfType("using_directive")) {
      const name = directive.childForFieldName("name");
      const target = directive.namedChildren.find((child) => child.id !== name?.id && (child.type === "qualified_name" || child.type === "identifier" || child.type === "generic_name"));
      const chain = chainOf(target ?? null);
      if (chain === undefined) continue;
      const written = chain.join(".");
      if (name !== null) {
        this.aliases.set(name.text, chain);
        this.references.push({ name: written, kind: "reference", line: directive.startPosition.row + 1 });
        continue;
      }
      if (!this.uses.includes(written)) this.uses.push(written);
      if (directive.children.some((child) => child.type === "global") && !this.globalUses.includes(written)) this.globalUses.push(written);
    }
  }

  // ---- declarations ----

  private members(parent: Node, context: Context): void {
    for (const child of parent.namedChildren) this.member(child, context);
  }

  private member(node: Node, context: Context): void {
    switch (node.type) {
      case "file_scoped_namespace_declaration": {
        this.namespace = chainOf(node.childForFieldName("name"))?.join(".") ?? "";
        this.noteNamespace();
        return;
      }
      case "namespace_declaration": {
        const outer = this.namespace;
        const name = chainOf(node.childForFieldName("name"))?.join(".") ?? "";
        this.namespace = outer === "" ? name : `${outer}.${name}`;
        this.noteNamespace();
        const body = node.childForFieldName("body");
        if (body !== null) this.members(body, context);
        this.namespace = outer;
        return;
      }
      case "global_statement":
        this.expression(node, context);
        return;
      case "preproc_if":
      case "preproc_elif":
      case "preproc_else": {
        // Every branch is read as written: the preprocessor is not run.
        const condition = node.childForFieldName("condition");
        for (const child of node.namedChildren) if (child.id !== condition?.id) this.member(child, context);
        return;
      }
      default:
    }
    if (typeDeclarations.has(node.type)) {
      this.typeDeclaration(node, context);
      return;
    }
    if (memberFunctions.has(node.type)) {
      this.functionMember(node, context);
      return;
    }
    switch (node.type) {
      case "property_declaration":
      case "indexer_declaration":
      case "event_declaration":
        this.propertyMember(node, context);
        return;
      case "using_directive":
        return;
      default:
        this.expression(node, context);
    }
  }

  private noteNamespace(): void {
    if (this.namespace !== "" && !this.namespaces.includes(this.namespace)) this.namespaces.push(this.namespace);
  }

  private unitName(base: string, context: Context): string {
    const qualified = context.unit === undefined ? base : `${context.unit}.${base}`;
    const seen = this.nameCounts.get(qualified) ?? 0;
    this.nameCounts.set(qualified, seen + 1);
    return seen === 0 ? qualified : `${qualified}~${seen + 1}`;
  }

  private typeDeclaration(node: Node, context: Context): void {
    const name = node.childForFieldName("name")?.text;
    if (name === undefined) return;
    const modifiers = modifiersOf(node);
    const qualifiedName = this.unitName(name, context);
    const nested = context.unit !== undefined;
    const visible = nested ? context.visible && modifiers.some((modifier) => modifier === "public" || modifier === "protected") : modifiers.includes("public");
    const kind = kindOf(node, modifiers);
    const unit: UnitFact = {
      qualifiedName,
      kind: "class",
      startLine: startRow(node) + 1,
      endLine: node.endPosition.row + 1,
      source: "structural",
      shape: typeShape(node),
    };
    if (context.unit !== undefined) unit.parent = context.unit;
    this.units.push(unit);
    const written = qualifiedName.replace(/~\d+$/, "");
    const declaredName = this.namespace === "" ? written : `${this.namespace}.${written}`;
    // `Box` and `Box<T>` are written alike in a reference, so they are one declaration: a use would count for both otherwise.
    if (!this.declarations.some((declaration) => declaration.name === declaredName)) {
      this.declarations.push({ name: declaredName, kind, unit: qualifiedName, exported: visible, line: unit.startLine, ...(modifiers.includes("partial") ? { partial: true } : {}) });
    }

    const parameters = new Set<string>();
    for (const parameter of node.descendantsOfType("type_parameter").filter((candidate) => candidate.parent?.parent?.id === node.id)) {
      const text = parameter.childForFieldName("name")?.text;
      if (text !== undefined) parameters.add(text);
    }
    const inner: Context = { unit: qualifiedName, shadow: new Set([...context.shadow, ...parameters]), visible };
    for (const child of node.namedChildren) {
      if (child.type === "attribute_list") this.attributes(child, context);
      else if (child.id === node.childForFieldName("name")?.id || child.type === "modifier" || child.type === "type_parameter_list") continue;
      else if (child.type === "declaration_list" || child.type === "enum_member_declaration_list") this.members(child, inner);
      else this.expression(child, inner);
    }
  }

  private functionMember(node: Node, context: Context): void {
    // A signature with no body (interface, abstract or extern member, partial declaration) has nothing to measure.
    if (bodyOf(node) === null) {
      this.functionParts(node, context, context);
      return;
    }
    const written = this.memberName(node);
    const qualifiedName = this.unitName(written, context);
    const inner = this.declareFunction(node, qualifiedName, "method", context.unit, node.childForFieldName("name")?.text, context);
    this.functionParts(node, inner, context);
  }

  private memberName(node: Node): string {
    switch (node.type) {
      case "constructor_declaration":
        return node.childForFieldName("name")?.text ?? "constructor";
      case "destructor_declaration":
        return `~${node.childForFieldName("name")?.text ?? ""}`;
      case "operator_declaration": {
        const keyword = node.children.findIndex((child) => child.type === "operator");
        return `operator ${node.children[keyword + 1]?.text ?? ""}`;
      }
      case "conversion_operator_declaration":
        return `operator ${node.childForFieldName("type")?.text ?? ""}`;
      default:
        return node.childForFieldName("name")?.text ?? "";
    }
  }

  /** The parts of a function that are code: its attributes, parameter types and defaults, base call and body. */
  private functionParts(node: Node, inner: Context, outer: Context): void {
    const shadow = new Set(inner.shadow);
    for (const parameter of node.descendantsOfType("type_parameter").filter((candidate) => candidate.parent?.parent?.id === node.id)) {
      const text = parameter.childForFieldName("name")?.text;
      if (text !== undefined) shadow.add(text);
    }
    const context: Context = { ...inner, shadow };
    const skipped = new Set([node.childForFieldName("name")?.id, node.childForFieldName("type_parameters")?.id].filter((id) => id !== undefined));
    for (const child of node.namedChildren) {
      if (child.type === "attribute_list") this.attributes(child, outer);
      else if (child.type === "modifier" || skipped.has(child.id)) continue;
      else this.expression(child, context);
    }
  }

  private propertyMember(node: Node, context: Context): void {
    const name = node.childForFieldName("name")?.text ?? (node.type === "indexer_declaration" ? "this[]" : "");
    const accessors = node.childForFieldName("accessors");
    // An expression-bodied property is one function. One with accessors is a function per accessor that has a body,
    // and the property itself is not a unit: nothing else would measure it.
    if (accessors === null) {
      const propertyUnit = this.unitName(name, context);
      const inner = node.childForFieldName("value") !== null ? this.declareFunction(node, propertyUnit, "method", context.unit, undefined, context) : { ...context, unit: propertyUnit };
      this.functionParts(node, inner, context);
      return;
    }
    const propertyUnit = context.unit === undefined ? name : `${context.unit}.${name}`;
    const inner: Context = { ...context, unit: propertyUnit };
    for (const child of node.namedChildren) {
      if (child.type === "attribute_list") this.attributes(child, context);
      else if (child.type === "modifier" || child.id === node.childForFieldName("name")?.id) continue;
      else if (child.id === accessors.id) {
        for (const accessor of accessors.namedChildren) {
          if (accessor.type !== "accessor_declaration" || accessor.childForFieldName("body") === null) continue;
          const kind = accessor.children.find((token) => !token.isNamed && /^(get|set|init|add|remove)$/.test(token.type))?.type ?? accessor.childForFieldName("name")?.text ?? "accessor";
          const scope = this.declareFunction(accessor, this.unitName(kind, inner), "method", context.unit, undefined, inner);
          this.functionParts(accessor, scope, inner);
        }
      } else this.expression(child, inner);
    }
  }

  /** Records a function-like node as a unit with its metrics and shape, and returns the context its body is read in. */
  private declareFunction(fn: Node, qualifiedName: string, kind: UnitKind, parent: string | undefined, name: string | undefined, context: Context): Context {
    const startLine = startRow(fn) + 1;
    const endLine = fn.endPosition.row + 1;
    this.codeRows ??= codeRowsOf(this.root!, csharpMetricRules);
    const measured = measureFunction(fn, { name, startLine, endLine, codeRows: this.codeRows, explain: this.explain }, csharpMetricRules);
    const unit: UnitFact = { qualifiedName, kind, startLine, endLine, source: "structural", metrics: measured.metrics, shape: functionShape(fn, measured.metrics.parameters) };
    if (parent !== undefined) unit.parent = parent;
    const forwarded = passThroughOf(fn, new Set(parameterInfo(fn).map((parameter) => parameter.name)));
    if (forwarded !== undefined) unit.passThrough = forwarded;
    if (measured.recursive) unit.recursive = true;
    if (modifiersOf(fn).includes("override")) unit.override = true;
    if (measured.increments !== undefined) unit.increments = measured.increments;
    this.units.push(unit);
    return { ...context, unit: qualifiedName };
  }

  // ---- references ----

  private attributes(list: Node, context: Context): void {
    for (const attribute of list.namedChildren) {
      if (attribute.type !== "attribute") continue;
      const chain = chainOf(attribute.childForFieldName("name"));
      if (chain !== undefined) {
        this.reference(chain, "reference", attribute.startPosition.row + 1, context.unit);
        this.reference([...chain.slice(0, -1), `${chain.at(-1)}Attribute`], "reference", attribute.startPosition.row + 1, context.unit);
      }
      for (const child of attribute.namedChildren) if (child.id !== attribute.childForFieldName("name")?.id) this.expression(child, context);
    }
  }

  /** Emits a reference for each prefix of a chain of names: any of them may be the type, the rest members of it. */
  private reference(chain: readonly string[], kind: SymbolReference["kind"], line: number, unit: string | undefined): void {
    const first = chain[0];
    if (first === undefined) return;
    const aliased = this.aliases.get(first);
    const names = aliased === undefined ? chain : [...aliased, ...chain.slice(1)];
    const base = aliased === undefined ? 0 : aliased.length - 1;
    for (let length = base + 1; length <= names.length; length++) {
      const reference: SymbolReference = { name: names.slice(0, length).join("."), kind, line };
      if (unit !== undefined) reference.inUnit = unit;
      this.references.push(reference);
    }
  }

  /** Reads an expression, a type or a statement for the names it uses. Declaration names are not uses. */
  private expression(node: Node, context: Context): void {
    switch (node.type) {
      case "identifier":
        if (!context.shadow.has(node.text)) this.reference([node.text], "reference", node.startPosition.row + 1, context.unit);
        return;
      case "generic_name":
      case "qualified_name":
      case "member_access_expression": {
        const chain = chainOf(node);
        if (chain === undefined) {
          this.walkMembers(node, context);
          return;
        }
        if (!context.shadow.has(chain[0]!)) this.reference(chain, "reference", node.startPosition.row + 1, context.unit);
        this.typeArguments(node, context);
        return;
      }
      case "invocation_expression": {
        const callee = node.childForFieldName("function");
        const chain = chainOf(callee);
        if (chain !== undefined && callee !== null) {
          // `A.B.Run()` calls a member of `A.B`; `Run()` calls nothing a type declares.
          if (chain.length > 1 && !context.shadow.has(chain[0]!)) this.reference(chain.slice(0, -1), "call", node.startPosition.row + 1, context.unit);
          this.typeArguments(callee, context);
        } else if (callee !== null) this.expression(callee, context);
        const args = node.childForFieldName("arguments");
        if (args !== null) this.expression(args, context);
        return;
      }
      case "object_creation_expression": {
        const type = node.childForFieldName("type");
        const chain = chainOf(type);
        if (chain !== undefined && type !== null) {
          this.reference(chain, "call", node.startPosition.row + 1, context.unit);
          this.typeArguments(type, context);
        } else if (type !== null) this.expression(type, context);
        for (const child of node.namedChildren) if (child.id !== type?.id) this.expression(child, context);
        return;
      }
      case "attribute_list":
        this.attributes(node, context);
        return;
      case "parameter": {
        const name = node.childForFieldName("name");
        for (const child of node.namedChildren) if (child.id !== name?.id && child.type !== "modifier") this.expression(child, context);
        return;
      }
      case "variable_declarator":
      case "catch_declaration":
      case "enum_member_declaration":
      case "type_parameter":
      case "labeled_statement": {
        const name = node.childForFieldName("name");
        for (const child of node.namedChildren) if (child.id !== name?.id) this.expression(child, context);
        return;
      }
      case "foreach_statement":
      case "declaration_pattern":
      case "recursive_pattern":
      case "var_pattern": {
        const declared = [node.childForFieldName("name"), node.type === "foreach_statement" ? node.childForFieldName("left") : null];
        const skip = new Set(declared.filter((child): child is Node => child !== null && child.type === "identifier").map((child) => child.id));
        for (const child of node.namedChildren) if (!skip.has(child.id)) this.expression(child, context);
        return;
      }
      case "lambda_expression":
      case "anonymous_method_expression":
      case "local_function_statement":
        this.nested(node, context);
        return;
      case "parameter_list":
        // A `params` array is written inline, so its name is a direct child of the list.
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child !== null && child.isNamed && node.fieldNameForChild(i) !== "name") this.expression(child, context);
        }
        return;
      case "tuple_pattern":
        for (const child of node.namedChildren) if (child.type !== "identifier") this.expression(child, context);
        return;
      case "preproc_if":
      case "preproc_elif":
      case "preproc_else": {
        const condition = node.childForFieldName("condition");
        for (const child of node.namedChildren) if (child.id !== condition?.id) this.expression(child, context);
        return;
      }
      case "name_colon":
      case "member_binding_expression":
      case "implicit_parameter":
      case "predefined_type":
      case "implicit_type":
        return;
      case "assignment_expression": {
        // `new X { Name = 1 }`: the left side of an initializer names a member.
        const left = node.childForFieldName("left");
        for (const child of node.namedChildren) {
          if (child.id === left?.id && left.type === "identifier" && node.parent?.type === "initializer_expression") continue;
          this.expression(child, context);
        }
        return;
      }
      case "type_parameter_constraints_clause":
        for (const child of node.namedChildren.slice(1)) this.expression(child, context);
        return;
      default:
        for (const child of node.namedChildren) this.expression(child, context);
    }
  }

  /** The qualifier of a member access that is not a name chain, such as `Make().Run` or `a[0].Run`. */
  private walkMembers(node: Node, context: Context): void {
    const name = node.childForFieldName("name");
    for (const child of node.namedChildren) if (child.id !== name?.id) this.expression(child, context);
  }

  /** The generic arguments inside a chain of names: `List<Invoice>` references `Invoice`. */
  private typeArguments(node: Node, context: Context): void {
    for (const list of node.descendantsOfType("type_argument_list")) for (const child of list.namedChildren) this.expression(child, context);
  }

  /**
   * A lambda, anonymous method or local function. A local function is a unit under the function it sits in;
   * the others are read as part of their enclosing unit.
   */
  private nested(node: Node, context: Context): void {
    if (node.type === "local_function_statement" && context.unit !== undefined) {
      const name = node.childForFieldName("name")?.text ?? "";
      const qualifiedName = this.unitName(name, context);
      const inner = this.declareFunction(node, qualifiedName, "function", context.unit, name, context);
      this.functionParts(node, inner, context);
      return;
    }
    const shadow = new Set([...context.shadow, ...parameterInfo(node).map((parameter) => parameter.name)]);
    const inner: Context = { ...context, shadow };
    for (const child of node.namedChildren) this.expression(child, inner);
  }
}

export function extractFacts(root: Node, options: ExtractOptions = {}): FileFacts {
  return new Extractor(options).extract(root);
}
