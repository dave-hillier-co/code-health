import type { Node } from "web-tree-sitter";
import type { DeclarationKind, FileFacts, ImportFact, MacroFact, SymbolDeclaration, SymbolReference, UnitFact, UnitKind } from "../../facts.ts";
import { codeRowsOf, measureFunction } from "../../unit-metrics.ts";
import { classAbstraction } from "./abstraction.ts";
import { classShape, functionShape, nodeCount, passThroughOf } from "./interface-shape.ts";
import { cppMetricRules, declaratorName, functionDeclarator } from "./metric-rules.ts";

/**
 * Facts of one C++ file. The preprocessor is not run: `#include` lines become `imports` for the resolver,
 * conditional compilation is read as written (every branch is in the tree), and code a macro would generate
 * is not seen, which is reported in `macroGenerated`.
 *
 * Dependencies are symbol-based. The file declares qualified names (types, functions, namespace-level
 * variables), and references the names it uses as written. Which declaration a name reaches is decided by
 * the resolver from the headers the file includes, so these facts depend on the text alone.
 *
 * Units: classes, structs and unions with a body; function definitions (a member is `Class.name`, written in
 * the class or out of line as `Class::name`); and lambdas bound to a name. Namespaces are not part of a unit's
 * name, which is its name within the file. Anonymous lambdas are part of the function they sit in.
 */

const classTypes = new Set(["class_specifier", "struct_specifier", "union_specifier"]);
const smartPointers = new Set(["unique_ptr", "shared_ptr", "weak_ptr", "optional", "reference_wrapper", "observer_ptr", "not_null"]);
const macroName = /^[A-Z][A-Z0-9_]{2,}$/;

interface Context {
  /** Qualified name of the innermost enclosing unit. */
  unit: string | undefined;
  /** Namespaces the code sits in, outermost first. */
  namespaces: readonly string[];
  /** Classes the code sits in, outermost first, for member names. */
  owners: readonly string[];
  /** The code is in an anonymous namespace, so nothing in it is visible to other files. */
  anonymous: boolean;
  /** The declaration list being read, which decides what a stray macro call is. */
  scope: "file" | "class" | "function";
  /** Whether members of the class being read are public. */
  publicMembers: boolean;
  /** What local variables, parameters and fields were declared as, to resolve the receiver of a member call. */
  types: ReadonlyMap<string, string>;
  /** Parameters and variables declared in the function being read: uses of them are not uses of anything declared elsewhere. */
  locals: ReadonlySet<string>;
}

function startRow(node: Node): number {
  return node.startPosition.row;
}

function plain(node: Node): string {
  return node.text.replace(/\s+/g, "");
}

/** `a::b::C<T>` is `a.b.C`. */
function dotted(node: Node): string {
  switch (node.type) {
    case "qualified_identifier": {
      const scope = node.childForFieldName("scope");
      const name = node.childForFieldName("name");
      const head = scope === null ? "" : dotted(scope);
      const tail = name === null ? "" : dotted(name);
      return head === "" ? tail : `${head}.${tail}`;
    }
    case "template_type":
    case "template_function": {
      const name = node.childForFieldName("name");
      return name === null ? plain(node) : dotted(name);
    }
    case "dependent_type":
    case "type_descriptor": {
      const child = node.namedChildren[0];
      return child === undefined ? plain(node) : dotted(child);
    }
    default:
      return plain(node);
  }
}

/** The type names a type node refers to, smart pointers looked through, for resolving `x.method()`. */
function receiverType(type: Node | null): string | null {
  if (type === null) return null;
  switch (type.type) {
    case "type_identifier":
      return type.text;
    case "qualified_identifier":
    case "template_type": {
      const last = (type.type === "template_type" ? type.childForFieldName("name") : type.childForFieldName("name")) ?? null;
      const name = last === null ? "" : plain(last.type === "template_type" ? (last.childForFieldName("name") ?? last) : last);
      if (type.type === "template_type" && smartPointers.has(name)) return receiverType(firstTemplateArgument(type));
      if (type.type === "qualified_identifier" && last?.type === "template_type" && smartPointers.has(plain(last.childForFieldName("name") ?? last))) return receiverType(firstTemplateArgument(last));
      return dotted(type);
    }
    default:
      return null;
  }
}

function firstTemplateArgument(template: Node): Node | null {
  const list = template.childForFieldName("arguments");
  const descriptor = list?.namedChildren.find((child) => child.type === "type_descriptor");
  return descriptor?.childForFieldName("type") ?? null;
}

/** The identifier a declarator declares, through pointers, references, arrays and initialisers. */
function declaredIdentifier(declarator: Node | null): string | null {
  let current = declarator;
  while (current !== null) {
    if (current.type === "identifier" || current.type === "field_identifier") return current.text;
    const next: Node | null = current.childForFieldName("declarator") ?? current.namedChildren.find((child) => child.type.endsWith("declarator") || child.type === "identifier" || child.type === "field_identifier") ?? null;
    if (next === null || next.id === current.id) return null;
    current = next;
  }
  return null;
}

function hasChildOfType(node: Node, type: string): boolean {
  for (let i = 0; i < node.childCount; i++) if (node.child(i)?.type === type) return true;
  return false;
}

function isStatic(node: Node): boolean {
  return node.namedChildren.some((child) => child.type === "storage_class_specifier" && child.text === "static");
}

class Extractor {
  readonly units: UnitFact[] = [];
  readonly declarations: SymbolDeclaration[] = [];
  readonly references: SymbolReference[] = [];
  readonly imports: ImportFact[] = [];
  readonly macros: MacroFact[] = [];
  readonly namespaces = new Set<string>();
  readonly uses = new Set<string>();
  private readonly nameCounts = new Map<string, number>();
  private codeRows: boolean[] | undefined;
  private root: Node | undefined;
  private readonly explain: boolean;

  constructor(explain: boolean) {
    this.explain = explain;
  }

  extract(root: Node): FileFacts {
    this.root = root;
    this.visitChildren(root, { unit: undefined, namespaces: [], owners: [], anonymous: false, scope: "file", publicMembers: true, types: new Map(), locals: new Set() });
    return {
      units: this.units,
      imports: this.imports,
      reexports: [],
      exports: [],
      references: [],
      symbols: {
        namespaces: [...this.namespaces].sort(),
        uses: [...this.uses].sort(),
        declarations: this.declarations,
        references: this.references,
      },
      ...(this.macros.length === 0 ? {} : { macroGenerated: this.macros }),
      nodes: nodeCount(root, (node) => node.type === "preproc_include") - 1,
      hasSyntaxErrors: root.hasError,
    };
  }

  private visitChildren(node: Node, context: Context): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null && child.isNamed) this.visit(child, context, node, node.fieldNameForChild(i));
    }
  }

  private visit(node: Node, context: Context, parent: Node, field: string | null): void {
    switch (node.type) {
      case "preproc_include":
        this.include(node);
        return;
      case "preproc_def":
      case "preproc_function_def":
        this.macroDefinition(node);
        return;
      case "namespace_definition":
        this.namespace(node, context);
        return;
      case "linkage_specification":
        this.visitChildren(node, context);
        return;
      case "using_declaration":
        this.usingDeclaration(node);
        return;
      case "template_declaration":
        this.templated(node, context);
        return;
      case "class_specifier":
      case "struct_specifier":
      case "union_specifier":
        this.classLike(node, node, context);
        return;
      case "enum_specifier":
        this.enumeration(node, context);
        return;
      case "alias_declaration": {
        const name = node.childForFieldName("name");
        if (name !== null) this.addDeclaration(name.text, "type", undefined, context, node.startPosition.row + 1, true);
        this.visitChildren(node, context);
        return;
      }
      case "type_definition": {
        const name = declaredIdentifier(node.childForFieldName("declarator")) ?? node.childForFieldName("declarator")?.text;
        if (name !== undefined && name !== null) this.addDeclaration(name, "type", undefined, context, node.startPosition.row + 1, true);
        this.visitChildren(node, context);
        return;
      }
      case "function_definition":
        this.functionDefinition(node, node, context);
        return;
      case "declaration":
        this.declaration(node, context);
        return;
      case "field_declaration":
        this.fieldDeclaration(node, context);
        return;
      case "access_specifier":
        return;
      case "expression_statement":
        if (context.scope !== "function") this.strayStatement(node);
        this.visitChildren(node, context);
        return;
      case "call_expression":
        this.call(node, context);
        return;
      case "new_expression": {
        const type = node.childForFieldName("type");
        if (type !== null) this.typeUse(type, context);
        const args = node.childForFieldName("arguments");
        if (args !== null) this.visit(args, context, node, "arguments");
        return;
      }
      case "qualified_identifier":
        // The name of an out-of-line definition declares; it does not use.
        if (!(parent.type === "function_declarator" && field === "declarator")) this.qualified(node, context);
        return;
      case "type_identifier":
        if (this.isUse(node, parent, field)) this.reference(node.text, "reference", node, context);
        return;
      case "identifier":
        if (!context.locals.has(node.text) && this.isUse(node, parent, field)) this.reference(node.text, "reference", node, context);
        return;
      case "field_expression": {
        // The object is a use; the field names a member, which needs the object's type to resolve.
        const object = node.childForFieldName("argument");
        if (object !== null) this.visit(object, context, node, "argument");
        return;
      }
      case "init_declarator": {
        const value = node.childForFieldName("value");
        const name = declaredIdentifier(node.childForFieldName("declarator"));
        if (value?.type === "lambda_expression" && name !== null) this.namedLambda(node, value, name, context);
        else this.visitChildren(node, context);
        return;
      }
      default:
        this.visitChildren(node, context);
    }
  }

  // ---- includes, macros, namespaces ----

  private include(node: Node): void {
    const path = node.childForFieldName("path");
    if (path === null) return;
    const text = path.type === "system_lib_string" ? path.text : (path.namedChildren.find((child) => child.type === "string_content")?.text ?? path.text.slice(1, -1));
    this.imports.push({ specifier: text, kind: "import", typeOnly: false, line: node.startPosition.row + 1, bindings: [] });
  }

  /** A macro whose body holds declarations, or braces and statements, generates code the grammar never sees. */
  private macroDefinition(node: Node): void {
    const value = node.childForFieldName("value")?.text ?? "";
    const name = node.childForFieldName("name")?.text ?? "";
    if (/[{};]/.test(value) && /\b(class|struct|union|enum|namespace|template|void|int|bool|return|if|for|while)\b|##/.test(value)) {
      this.macros.push({ line: node.startPosition.row + 1, name, kind: "definition" });
    }
  }

  /** A macro invoked where a declaration belongs, so what it declares is invisible. */
  private strayStatement(node: Node): void {
    const call = node.namedChildren[0];
    if (call?.type !== "call_expression") return;
    const callee = call.childForFieldName("function");
    if (callee?.type !== "identifier") return;
    this.macros.push({ line: node.startPosition.row + 1, name: callee.text, kind: "invocation" });
  }

  private namespace(node: Node, context: Context): void {
    const name = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (body === null) return;
    if (name === null) {
      this.visitChildren(body, { ...context, anonymous: true });
      return;
    }
    const parts = name.text.replace(/\binline\b/g, "").split("::").map((part) => part.trim()).filter((part) => part !== "");
    const namespaces = [...context.namespaces, ...parts];
    this.namespaces.add(namespaces.join("."));
    this.visitChildren(body, { ...context, namespaces });
  }

  private usingDeclaration(node: Node): void {
    const isNamespace = hasChildOfType(node, "namespace");
    const target = node.namedChildren.find((child) => child.type === "qualified_identifier" || child.type === "identifier");
    if (target === undefined) return;
    const name = dotted(target);
    if (isNamespace) this.uses.add(name);
    else if (name.includes(".")) this.uses.add(name.slice(0, name.lastIndexOf(".")));
  }

  // ---- declarations ----

  private qualify(context: Context, ...parts: string[]): string {
    return [...context.namespaces, ...context.owners, ...parts].join(".");
  }

  private addDeclaration(name: string, kind: DeclarationKind, unit: string | undefined, context: Context, line: number, exported: boolean, qualifier: readonly string[] = []): void {
    this.declarations.push({
      name: this.qualify(context, ...qualifier, name),
      kind,
      ...(unit === undefined ? {} : { unit }),
      exported: exported && !context.anonymous && context.publicMembers,
      line,
    });
  }

  private enumeration(node: Node, context: Context): void {
    const name = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (name !== null && body !== null) this.addDeclaration(plain(name), "enum", undefined, context, node.startPosition.row + 1, true);
    this.visitChildren(node, context);
  }

  private templated(node: Node, context: Context): void {
    const target = node.namedChildren.find((child) => child.type !== "template_parameter_list" && child.type !== "comment");
    if (target === undefined) return;
    switch (target.type) {
      case "function_definition":
        this.functionDefinition(target, node, context);
        return;
      case "class_specifier":
      case "struct_specifier":
      case "union_specifier":
        this.classLike(target, node, context);
        return;
      case "declaration":
        this.declaration(target, context);
        return;
      case "template_declaration":
        this.templated(target, context);
        return;
      default:
        this.visit(target, context, node, null);
    }
  }

  private classLike(node: Node, extent: Node, context: Context): void {
    const nameNode = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (nameNode === null || body === null) {
      // A forward declaration, or an elaborated type in a declaration, declares and uses nothing here.
      this.visitChildren(node, context);
      return;
    }
    const name = plain(nameNode.type === "template_type" ? (nameNode.childForFieldName("name") ?? nameNode) : nameNode);
    const kind: DeclarationKind = classAbstraction(node);
    const unitName = this.uniqueName(context.unit === undefined ? name : `${context.unit}.${name}`);
    const unit: UnitFact = {
      qualifiedName: unitName,
      kind: "class",
      startLine: startRow(extent) + 1,
      endLine: extent.endPosition.row + 1,
      source: "structural",
      shape: classShape(node),
    };
    if (context.unit !== undefined) unit.parent = context.unit;
    this.units.push(unit);
    this.addDeclaration(name, kind, unitName, context, node.startPosition.row + 1, true);

    const inner: Context = { ...context, unit: unitName, owners: [...context.owners, name], scope: "class", publicMembers: true, types: this.fieldTypes(body, context.types) };
    for (let i = 0; i < node.childCount; i++) {
      const part = node.child(i);
      if (part !== null && part.isNamed && part.id !== body.id) this.visit(part, inner, node, node.fieldNameForChild(i));
    }
    let publicMembers = node.type !== "class_specifier";
    for (let i = 0; i < body.childCount; i++) {
      const member = body.child(i);
      if (member === null || !member.isNamed) continue;
      if (member.type === "access_specifier") {
        publicMembers = member.text.trim() === "public";
        continue;
      }
      this.visit(member, { ...inner, publicMembers: publicMembers && context.publicMembers }, body, null);
    }
  }

  /** The declared type of each data member of a class body, by name. */
  private fieldTypes(body: Node, outer: ReadonlyMap<string, string>): Map<string, string> {
    const types = new Map(outer);
    for (const member of body.namedChildren) {
      if (member.type !== "field_declaration") continue;
      const type = receiverType(member.childForFieldName("type"));
      if (type === null) continue;
      for (let i = 0; i < member.childCount; i++) {
        if (member.fieldNameForChild(i) !== "declarator") continue;
        const name = declaredIdentifier(member.child(i));
        if (name !== null) types.set(name, type);
      }
    }
    return types;
  }

  private uniqueName(base: string): string {
    const seen = this.nameCounts.get(base) ?? 0;
    this.nameCounts.set(base, seen + 1);
    return seen === 0 ? base : `${base}~${seen + 1}`;
  }

  /** `auto f = [](...) {...};` binds a lambda to a name, which makes it a unit like a function. */
  private namedLambda(declarator: Node, lambda: Node, name: string, context: Context): void {
    const declaration = declarator.parent;
    const sole = declaration?.type === "declaration" && declaration.namedChildren.filter((child) => child.type === "init_declarator").length === 1;
    const extent = sole ? declaration : declarator;
    const qualifiedName = this.uniqueName(context.unit === undefined ? name : `${context.unit}.${name}`);
    this.units.push(this.measuredUnit(qualifiedName, "arrow", lambda, extent, undefined, context));
    this.visitChildren(lambda, { ...context, unit: qualifiedName, scope: "function" });
  }

  private functionDefinition(fn: Node, extent: Node, context: Context): void {
    const body = fn.childForFieldName("body");
    const declarator = functionDeclarator(fn);
    const named = declaratorName(declarator);
    if (body === null || declarator === null || named === null) {
      this.visitChildren(fn, context);
      return;
    }
    const insideClass = context.scope === "class";
    const owner = named.qualifier.length > 0 ? named.qualifier.at(-1)! : insideClass ? context.owners.at(-1) : undefined;
    const isMember = owner !== undefined;
    const base = named.qualifier.length > 0 ? `${named.qualifier.at(-1)}.${named.name}` : context.unit === undefined || !insideClass ? named.name : `${context.unit}.${named.name}`;
    const qualifiedName = this.uniqueName(base);
    const kind: UnitKind = isMember ? "method" : "function";
    const unit = this.measuredUnit(qualifiedName, kind, fn, extent, named.name, context);
    this.units.push(unit);
    const exported = !isStatic(fn);
    this.addDeclaration(named.name, "function", qualifiedName, context, fn.startPosition.row + 1, exported, named.qualifier);
    this.functionBody(fn, { ...context, unit: qualifiedName, scope: "function", types: this.parameterTypes(declarator, context.types) });
  }

  private measuredUnit(qualifiedName: string, kind: UnitKind, fn: Node, extent: Node, name: string | undefined, context: Context): UnitFact {
    this.codeRows ??= codeRowsOf(this.root!, cppMetricRules);
    const unit: UnitFact = {
      qualifiedName,
      kind,
      startLine: startRow(extent) + 1,
      endLine: extent.endPosition.row + 1,
      source: "structural",
    };
    if (context.unit !== undefined) unit.parent = context.unit;
    const measured = measureFunction(fn, { ...(name === undefined ? {} : { name }), startLine: unit.startLine, endLine: unit.endLine, codeRows: this.codeRows, explain: this.explain }, cppMetricRules);
    unit.metrics = measured.metrics;
    unit.shape = functionShape(fn, measured.metrics.parameters);
    const parameters = new Set(this.parameterNames(functionDeclarator(fn) ?? fn.childForFieldName("declarator")));
    const forwarded = passThroughOf(fn, parameters);
    if (forwarded !== undefined) unit.passThrough = forwarded;
    if (measured.increments !== undefined) unit.increments = measured.increments;
    return unit;
  }

  private parameterNames(declarator: Node | null): string[] {
    const list = declarator?.childForFieldName("parameters");
    const names: string[] = [];
    for (const parameter of list?.namedChildren ?? []) {
      const name = declaredIdentifier(parameter.childForFieldName("declarator"));
      if (name !== null) names.push(name);
    }
    return names;
  }

  private parameterTypes(declarator: Node, outer: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
    const list = declarator.childForFieldName("parameters");
    if (list === null) return outer;
    const types = new Map(outer);
    for (const parameter of list.namedChildren) {
      const type = receiverType(parameter.childForFieldName("type"));
      const name = declaredIdentifier(parameter.childForFieldName("declarator"));
      if (type !== null && name !== null) types.set(name, type);
    }
    return types;
  }

  /** Reads a function's parameters, initialisers and body, with its locals' types noted as they are declared. */
  private functionBody(fn: Node, context: Context): void {
    const types = new Map(context.types);
    const names = new Set(context.locals);
    const declares = new Set(["declaration", "for_range_loop", "parameter_declaration", "optional_parameter_declaration"]);
    const walk = (node: Node): void => {
      if (declares.has(node.type)) {
        const type = node.type === "declaration" ? receiverType(node.childForFieldName("type")) : null;
        for (let i = 0; i < node.childCount; i++) {
          if (node.fieldNameForChild(i) !== "declarator") continue;
          const name = declaredIdentifier(node.child(i));
          if (name === null) continue;
          names.add(name);
          if (type !== null) types.set(name, type);
        }
      }
      for (const child of node.namedChildren) walk(child);
    };
    walk(fn);
    this.visitChildren(fn, { ...context, types, locals: names });
  }

  private declaration(node: Node, context: Context): void {
    const type = node.childForFieldName("type");
    // A namespace-level function prototype is a declaration of a function defined elsewhere.
    if (context.scope === "file") {
      const declarator = functionDeclarator(node);
      const named = declaratorName(declarator);
      if (declarator !== null && declarator.type === "function_declarator" && named !== null && named.qualifier.length === 0) {
        this.addDeclaration(named.name, "function", named.name, context, node.startPosition.row + 1, !isStatic(node));
      } else if (declarator === null || named === null) {
        for (let i = 0; i < node.childCount; i++) {
          if (node.fieldNameForChild(i) !== "declarator") continue;
          const name = declaredIdentifier(node.child(i));
          if (name !== null && type !== null) this.addDeclaration(name, "variable", undefined, context, node.startPosition.row + 1, !isStatic(node) && !hasQualifier(node, "constexpr"));
        }
      }
    }
    this.visitChildren(node, context);
  }

  private fieldDeclaration(node: Node, context: Context): void {
    if (context.scope === "class") {
      const type = node.childForFieldName("type");
      // A macro such as Q_OBJECT leaves a type with no declarator of its own.
      if (type?.type === "type_identifier" && macroName.test(type.text)) this.macros.push({ line: node.startPosition.row + 1, name: type.text, kind: "invocation" });
    }
    this.visitChildren(node, context);
  }

  // ---- references ----

  private reference(name: string, kind: "call" | "reference", node: Node, context: Context): void {
    const fact: SymbolReference = { name, kind, line: node.startPosition.row + 1 };
    if (context.unit !== undefined) fact.inUnit = context.unit;
    this.references.push(fact);
  }

  /** A type written in an expression: the name, and the arguments of a template. */
  private typeUse(type: Node, context: Context): void {
    if (type.type === "qualified_identifier") this.qualified(type, context);
    else this.visit(type, context, type.parent ?? type, "type");
  }

  private qualified(node: Node, context: Context): void {
    const name = dotted(node);
    if (name !== "") this.reference(name.replace(/^\./, ""), "reference", node, context);
    // Template arguments inside the scope or the name are uses of their own.
    for (const found of node.descendantsOfType(["template_argument_list"])) this.visitChildren(found, context);
  }

  private call(node: Node, context: Context): void {
    const callee = node.childForFieldName("function");
    const args = node.childForFieldName("arguments");
    if (callee !== null) {
      switch (callee.type) {
        case "identifier":
          if (!context.locals.has(callee.text)) this.reference(callee.text, "call", callee, context);
          break;
        case "qualified_identifier": {
          const name = dotted(callee);
          this.reference(name.replace(/^\./, ""), "call", callee, context);
          for (const found of callee.descendantsOfType(["template_argument_list"])) this.visitChildren(found, context);
          break;
        }
        case "template_function": {
          const name = callee.childForFieldName("name");
          if (name !== null) this.reference(dotted(name), "call", callee, context);
          const list = callee.childForFieldName("arguments");
          if (list !== null) this.visitChildren(list, context);
          break;
        }
        case "field_expression": {
          const receiver = callee.childForFieldName("argument");
          const type = receiver === null ? undefined : this.typeOfReceiver(receiver, context);
          if (type !== undefined) this.reference(type, "call", callee, context);
          if (receiver !== null) this.visit(receiver, context, callee, "argument");
          break;
        }
        default:
          this.visit(callee, context, node, "function");
      }
    }
    if (args !== null) this.visit(args, context, node, "arguments");
  }

  /** The declared type of `x` in `x.m()`, `x->m()` and `this->x->m()`, when this file declared it. */
  private typeOfReceiver(receiver: Node, context: Context): string | undefined {
    if (receiver.type === "identifier") return context.types.get(receiver.text);
    if (receiver.type === "field_expression") {
      const object = receiver.childForFieldName("argument");
      const field = receiver.childForFieldName("field");
      if (object?.type === "this" && field !== null) return context.types.get(field.text);
    }
    if (receiver.type === "parenthesized_expression" || receiver.type === "pointer_expression") {
      const inner = receiver.namedChildren[0];
      return inner === undefined ? undefined : this.typeOfReceiver(inner, context);
    }
    return undefined;
  }

  /** Whether an identifier node is a use, not a name being declared. */
  private isUse(node: Node, parent: Node, field: string | null): boolean {
    switch (parent.type) {
      case "function_declarator":
      case "init_declarator":
      case "pointer_declarator":
      case "reference_declarator":
      case "array_declarator":
      case "parenthesized_declarator":
      case "parameter_declaration":
      case "optional_parameter_declaration":
      case "variadic_parameter_declaration":
      case "field_declaration":
      case "declaration":
        return field !== "declarator";
      case "class_specifier":
      case "struct_specifier":
      case "union_specifier":
      case "enum_specifier":
      case "alias_declaration":
      case "namespace_definition":
      case "type_parameter_declaration":
      case "variadic_type_parameter_declaration":
      case "enumerator":
      case "labeled_statement":
      case "goto_statement":
      case "preproc_def":
      case "preproc_function_def":
      case "preproc_params":
      case "using_declaration":
      case "namespace_alias_definition":
      case "lambda_capture_specifier":
        return field !== "name" && field !== "label" && parent.type !== "preproc_params" && parent.type !== "using_declaration" && parent.type !== "lambda_capture_specifier" && parent.type !== "goto_statement";
      case "template_type":
        return field !== "name" || node.type !== "type_identifier";
      case "type_definition":
        return field !== "declarator";
      case "preproc_if":
      case "preproc_ifdef":
      case "preproc_elif":
        return field !== "condition" && field !== "name";
      case "attribute":
      case "attribute_declaration":
        return false;
      default:
        return true;
    }
  }
}

function hasQualifier(node: Node, text: string): boolean {
  return node.namedChildren.some((child) => child.type === "type_qualifier" && child.text === text);
}

export function extractFacts(root: Node, options: { explain?: boolean }): FileFacts {
  return new Extractor(options.explain === true).extract(root);
}
