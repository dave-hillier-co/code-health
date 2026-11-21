import type { Node } from "web-tree-sitter";
import type {
  BindingFact,
  ExportFact,
  FileFacts,
  ImportFact,
  ReexportFact,
  ReferenceFact,
  UnitFact,
  UnitKind,
} from "./facts.ts";

/**
 * Bump when the extraction rules change in a way that alters facts for the
 * same source, so cached facts from older rules are not reused.
 */
export const extractorVersion = 1;

interface Context {
  /** Qualified name of the innermost enclosing unit; names of nested units are built from it. */
  unit: string | undefined;
  /** Local names declared in enclosing function and block scopes, which hide imports of the same name. */
  shadow: ReadonlySet<string>;
}

const functionTypes = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
  "function_declaration",
  "generator_function_declaration",
]);
const classTypes = new Set(["class_declaration", "abstract_class_declaration", "class"]);
const blockTypes = new Set(["statement_block", "class_static_block", "switch_body"]);
const intrinsicIdentifierTypes = new Set(["identifier", "type_identifier", "shorthand_property_identifier"]);

function isFunctionValue(node: Node | null): boolean {
  return node !== null && functionTypes.has(node.type);
}

function functionKind(node: Node): UnitKind {
  return node.type === "arrow_function" ? "arrow" : "function";
}

function stringValue(node: Node | null): string | null {
  if (!node || node.type !== "string") return null;
  return node.text.slice(1, -1);
}

function hasToken(node: Node, type: string): boolean {
  for (let i = 0; i < node.childCount; i++) if (node.child(i)?.type === type) return true;
  return false;
}

/** Start row of a node, ignoring decorators that precede its keyword. */
function startRow(node: Node): number {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type !== "decorator") return child.startPosition.row;
  }
  return node.startPosition.row;
}

/** Names bound by a binding pattern, ignoring property keys and default values. */
function patternNames(node: Node | null, out: string[]): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      out.push(node.text);
      return;
    case "pair_pattern":
      patternNames(node.childForFieldName("value"), out);
      return;
    case "assignment_pattern":
    case "object_assignment_pattern":
      patternNames(node.childForFieldName("left"), out);
      return;
    case "object_pattern":
    case "array_pattern":
    case "rest_pattern":
      for (const child of node.namedChildren) patternNames(child, out);
      return;
    default:
  }
}

function parameterNames(parameters: Node | null, out: string[]): void {
  if (!parameters) return;
  if (parameters.type === "identifier") {
    out.push(parameters.text);
    return;
  }
  for (const parameter of parameters.namedChildren) {
    if (parameter.type === "required_parameter" || parameter.type === "optional_parameter") {
      patternNames(parameter.childForFieldName("pattern"), out);
    } else {
      patternNames(parameter, out);
    }
  }
}

function declaredNames(statement: Node, out: string[]): void {
  switch (statement.type) {
    case "lexical_declaration":
    case "variable_declaration":
      for (const declarator of statement.namedChildren) {
        if (declarator.type === "variable_declarator") patternNames(declarator.childForFieldName("name"), out);
      }
      return;
    case "function_declaration":
    case "generator_function_declaration":
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = statement.childForFieldName("name");
      if (name) out.push(name.text);
      return;
    }
    default:
  }
}

function blockNames(block: Node, out: string[]): void {
  for (const statement of block.namedChildren) declaredNames(statement, out);
}

class Extractor {
  readonly units: UnitFact[] = [];
  readonly imports: ImportFact[] = [];
  readonly reexports: ReexportFact[] = [];
  readonly exports: ExportFact[] = [];
  readonly references: ReferenceFact[] = [];
  private readonly nameCounts = new Map<string, number>();

  extract(root: Node): FileFacts {
    const context: Context = { unit: undefined, shadow: new Set() };
    this.visitChildren(root, context);
    const locals = new Set<string>();
    for (const imported of this.imports) for (const binding of imported.bindings) locals.add(binding.local);
    return {
      units: this.units,
      imports: this.imports,
      reexports: this.reexports,
      exports: this.exports,
      references: this.references.filter((reference) => locals.has(reference.local)),
      hasSyntaxErrors: root.hasError,
    };
  }

  private visitChildren(node: Node, context: Context): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.isNamed) this.visit(child, context, node, node.fieldNameForChild(i));
    }
  }

  /** Decorators run where the class is declared, so they belong to the outer scope, not to the class. */
  private classParts(node: Node, outer: Context, inner: Context): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child || !child.isNamed) continue;
      this.visit(child, child.type === "decorator" ? outer : inner, node, node.fieldNameForChild(i));
    }
  }

  private withShadow(context: Context, names: string[]): Context {
    if (names.length === 0) return context;
    return { unit: context.unit, shadow: new Set([...context.shadow, ...names]) };
  }

  private visit(node: Node, context: Context, parent: Node, field: string | null): void {
    switch (node.type) {
      case "import_statement":
        this.importStatement(node);
        return;
      case "export_statement":
        this.exportStatement(node, context);
        return;
      case "function_declaration":
      case "generator_function_declaration": {
        const name = node.childForFieldName("name")?.text;
        const inner = name ? this.declareUnit(name, "function", node, wrapperOf(parent), context) : context;
        this.functionBody(node, inner);
        return;
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = node.childForFieldName("name")?.text;
        const inner = name ? this.declareUnit(name, "class", node, wrapperOf(parent), context) : context;
        this.classParts(node, context, inner);
        return;
      }
      case "method_definition": {
        // Only class members are units here. Object literal methods are handled where the literal is
        // bound to a name, and the rest are anonymous callbacks.
        const name = node.childForFieldName("name");
        const inner =
          name && parent.type === "class_body"
            ? this.declareUnit(name.text, "method", node, undefined, context)
            : context;
        this.functionBody(node, inner);
        return;
      }
      case "public_field_definition": {
        const name = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        if (name && value && isFunctionValue(value)) {
          this.functionBody(value, this.declareUnit(name.text, functionKind(value), node, undefined, context));
        } else if (value) {
          this.visit(value, context, node, "value");
        }
        return;
      }
      case "lexical_declaration":
      case "variable_declaration":
        this.declaration(node, context, parent);
        return;
      case "arrow_function":
      case "function_expression":
      case "function":
      case "generator_function":
        this.functionBody(node, context);
        return;
      case "statement_block":
      case "class_static_block":
      case "switch_body": {
        const names: string[] = [];
        blockNames(node, names);
        this.visitChildren(node, this.withShadow(context, names));
        return;
      }
      case "for_in_statement":
      case "for_statement": {
        const names: string[] = [];
        if (node.type === "for_statement") {
          const initializer = node.childForFieldName("initializer");
          if (initializer) declaredNames(initializer, names);
        } else if (node.childForFieldName("kind")) {
          patternNames(node.childForFieldName("left"), names);
        }
        this.visitChildren(node, this.withShadow(context, names));
        return;
      }
      case "catch_clause": {
        const names: string[] = [];
        patternNames(node.childForFieldName("parameter"), names);
        this.visitChildren(node, this.withShadow(context, names));
        return;
      }
      case "internal_module":
      case "module": {
        const name = node.childForFieldName("name");
        this.visitChildren(node, name ? scopeOf(context, name.text) : context);
        return;
      }
      case "call_expression":
        this.call(node, context);
        return;
      case "new_expression":
        this.newExpression(node, context);
        return;
      case "decorator":
        this.decorator(node, context);
        return;
      case "member_expression":
        this.member(node, context, "reference");
        return;
      case "nested_type_identifier": {
        const module = node.childForFieldName("module");
        const name = node.childForFieldName("name");
        if (module?.type === "identifier" && name) this.reference(module, context, "reference", name.text);
        else if (module) this.visit(module, context, node, "module");
        return;
      }
      case "jsx_opening_element":
      case "jsx_self_closing_element":
        this.jsxElement(node, context);
        return;
      case "export_clause":
      case "import_clause":
        return;
      default:
        if (intrinsicIdentifierTypes.has(node.type)) {
          if (this.isUse(node, parent, field)) this.reference(node, context, "reference");
          return;
        }
        this.visitChildren(node, context);
    }
  }

  /** Whether an identifier node is a use, not a declaration name or a binding position. */
  private isUse(node: Node, parent: Node, field: string | null): boolean {
    if (node.type === "shorthand_property_identifier") return true;
    switch (parent.type) {
      case "variable_declarator":
      case "function_declaration":
      case "generator_function_declaration":
      case "function_expression":
      case "class_declaration":
      case "abstract_class_declaration":
      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration":
      case "internal_module":
      case "module":
      case "type_parameter":
      case "labeled_statement":
        return field !== "name";
      case "required_parameter":
      case "optional_parameter":
        return field !== "pattern";
      case "formal_parameters":
      case "array_pattern":
      case "rest_pattern":
        return false;
      case "assignment_pattern":
        return field !== "left";
      case "arrow_function":
        return field !== "parameter";
      case "pair_pattern":
        return field !== "value";
      case "catch_clause":
        return field !== "parameter";
      case "for_in_statement":
        return !(field === "left" && parent.childForFieldName("kind") !== null);
      default:
        return true;
    }
  }

  private reference(node: Node, context: Context, kind: "call" | "reference", member?: string): void {
    if (context.shadow.has(node.text)) return;
    const fact: ReferenceFact = { local: node.text, kind, line: node.startPosition.row + 1 };
    if (member !== undefined) fact.member = member;
    if (context.unit !== undefined) fact.inUnit = context.unit;
    this.references.push(fact);
  }

  private declareUnit(
    name: string,
    kind: UnitKind,
    node: Node,
    wrapper: Node | undefined,
    context: Context,
  ): Context {
    const base = context.unit === undefined ? name : `${context.unit}.${name}`;
    const seen = this.nameCounts.get(base) ?? 0;
    this.nameCounts.set(base, seen + 1);
    const qualifiedName = seen === 0 ? base : `${base}~${seen + 1}`;
    const extent = wrapper ?? node;
    const unit: UnitFact = {
      qualifiedName,
      kind,
      startLine: startRow(extent) + 1,
      endLine: extent.endPosition.row + 1,
      source: "structural",
    };
    if (context.unit !== undefined) unit.parent = context.unit;
    this.units.push(unit);
    return { unit: qualifiedName, shadow: context.shadow };
  }

  /** Visits a function-like node's parameters and body with its own names in scope. */
  private functionBody(node: Node, context: Context): void {
    const names: string[] = [];
    parameterNames(node.childForFieldName("parameters") ?? node.childForFieldName("parameter"), names);
    if (node.type === "function_expression" || node.type === "generator_function") {
      const own = node.childForFieldName("name");
      if (own) names.push(own.text);
    }
    const body = node.childForFieldName("body");
    if (body?.type === "statement_block") blockNames(body, names);
    this.visitChildren(node, this.withShadow(context, names));
  }

  private declaration(node: Node, context: Context, parent: Node): void {
    const declarators = node.namedChildren.filter((child) => child.type === "variable_declarator");
    const sole = declarators.length === 1;
    for (const declarator of declarators) {
      const name = declarator.childForFieldName("name");
      const value = declarator.childForFieldName("value");
      const annotation = declarator.childForFieldName("type");
      if (annotation) this.visit(annotation, context, declarator, "type");
      const extent = sole ? (parent.type === "export_statement" ? parent : node) : declarator;
      if (name?.type === "identifier" && value) {
        if (this.requireDeclarator(declarator, name, value, context)) continue;
        if (isFunctionValue(value)) {
          this.functionBody(value, this.declareUnit(name.text, functionKind(value), value, extent, context));
          continue;
        }
        if (value.type === "class") {
          this.visitChildren(value, this.declareUnit(name.text, "class", value, extent, context));
          continue;
        }
        if (value.type === "object") {
          this.objectLiteral(value, name.text, context);
          continue;
        }
      } else if (name && value && this.requireDeclarator(declarator, name, value, context)) {
        continue;
      }
      if (name && name.type !== "identifier") this.visit(name, context, declarator, "name");
      if (value) this.visit(value, context, declarator, "value");
    }
  }

  /** `const x = require("y")` and its destructuring forms. Returns true when it was one. */
  private requireDeclarator(declarator: Node, name: Node, value: Node, context: Context): boolean {
    if (value.type !== "call_expression") return false;
    const callee = value.childForFieldName("function");
    if (callee?.type !== "identifier" || callee.text !== "require" || context.shadow.has("require")) return false;
    const args = value.childForFieldName("arguments");
    const specifier = stringValue(args?.namedChildren[0] ?? null);
    if (specifier === null || args?.namedChildren.length !== 1) return false;
    const bindings: BindingFact[] = [];
    if (name.type === "identifier") {
      bindings.push({ imported: "*", local: name.text, typeOnly: false });
    } else if (name.type === "object_pattern") {
      for (const part of name.namedChildren) {
        if (part.type === "shorthand_property_identifier_pattern") {
          bindings.push({ imported: part.text, local: part.text, typeOnly: false });
        } else if (part.type === "object_assignment_pattern") {
          const left = part.childForFieldName("left");
          if (left) bindings.push({ imported: left.text, local: left.text, typeOnly: false });
        } else if (part.type === "pair_pattern") {
          const key = part.childForFieldName("key");
          const local: string[] = [];
          patternNames(part.childForFieldName("value"), local);
          if (key && local[0] !== undefined) bindings.push({ imported: key.text, local: local[0], typeOnly: false });
        }
      }
    }
    this.imports.push({
      specifier,
      kind: "require",
      typeOnly: false,
      line: declarator.startPosition.row + 1,
      bindings,
    });
    return true;
  }

  private objectLiteral(object: Node, name: string, context: Context): void {
    for (const member of object.namedChildren) {
      if (member.type === "method_definition") {
        const key = member.childForFieldName("name");
        const inner = key ? this.declareUnit(key.text, "method", member, undefined, scopeOf(context, name)) : context;
        this.functionBody(member, inner);
        continue;
      }
      if (member.type === "pair") {
        const key = member.childForFieldName("key");
        const value = member.childForFieldName("value");
        if (key && value && isFunctionValue(value)) {
          const inner = this.declareUnit(key.text, functionKind(value), member, undefined, scopeOf(context, name));
          this.functionBody(value, inner);
          continue;
        }
      }
      this.visit(member, context, object, null);
    }
  }

  private importStatement(node: Node): void {
    const clause = node.namedChildren.find((child) => child.type === "import_clause");
    const requireClause = node.namedChildren.find((child) => child.type === "import_require_clause");
    const line = node.startPosition.row + 1;
    if (requireClause) {
      const local = requireClause.namedChildren.find((child) => child.type === "identifier");
      const specifier = stringValue(requireClause.childForFieldName("source"));
      if (local && specifier !== null) {
        this.imports.push({
          specifier,
          kind: "require",
          typeOnly: false,
          line,
          bindings: [{ imported: "*", local: local.text, typeOnly: false }],
        });
      }
      return;
    }
    const specifier = stringValue(node.childForFieldName("source"));
    if (specifier === null) return;
    const typeOnly = hasToken(node, "type");
    const bindings: BindingFact[] = [];
    for (const part of clause?.namedChildren ?? []) {
      if (part.type === "identifier") {
        bindings.push({ imported: "default", local: part.text, typeOnly });
      } else if (part.type === "namespace_import") {
        const local = part.namedChildren.find((child) => child.type === "identifier");
        if (local) bindings.push({ imported: "*", local: local.text, typeOnly });
      } else if (part.type === "named_imports") {
        for (const spec of part.namedChildren) {
          if (spec.type !== "import_specifier") continue;
          const imported = spec.childForFieldName("name");
          const alias = spec.childForFieldName("alias");
          if (!imported) continue;
          const importedName = stringValue(imported) ?? imported.text;
          bindings.push({
            imported: importedName,
            local: alias?.text ?? importedName,
            typeOnly: typeOnly || hasToken(spec, "type"),
          });
        }
      }
    }
    this.imports.push({ specifier, kind: "import", typeOnly, line, bindings });
  }

  private exportStatement(node: Node, context: Context): void {
    const line = node.startPosition.row + 1;
    const source = stringValue(node.childForFieldName("source"));
    const typeOnly = hasToken(node, "type");
    for (const child of node.namedChildren) {
      if (child.type === "decorator") this.visit(child, context, node, "decorator");
    }
    if (source !== null) {
      for (const child of node.namedChildren) {
        if (child.type === "namespace_export") {
          const alias = child.namedChildren.find((part) => part.type === "identifier");
          if (alias) this.reexports.push({ specifier: source, typeOnly, line, imported: "*", exported: alias.text });
        } else if (child.type === "export_clause") {
          for (const spec of child.namedChildren) {
            const name = spec.childForFieldName("name");
            if (spec.type !== "export_specifier" || !name) continue;
            const exported = spec.childForFieldName("alias")?.text ?? name.text;
            this.reexports.push({
              specifier: source,
              typeOnly: typeOnly || hasToken(spec, "type"),
              line,
              imported: name.text,
              exported,
            });
          }
        }
      }
      if (hasToken(node, "*") && !node.namedChildren.some((child) => child.type === "namespace_export")) {
        this.reexports.push({ specifier: source, typeOnly, line, imported: "*", exported: "*" });
      }
      return;
    }
    const clause = node.namedChildren.find((child) => child.type === "export_clause");
    if (clause) {
      for (const spec of clause.namedChildren) {
        const name = spec.childForFieldName("name");
        if (spec.type !== "export_specifier" || !name) continue;
        this.exports.push({ exported: spec.childForFieldName("alias")?.text ?? name.text, local: name.text, line });
      }
      return;
    }
    const declaration = node.childForFieldName("declaration");
    const isDefault = hasToken(node, "default");
    if (declaration) {
      this.exportedDeclaration(node, declaration, isDefault, context, line);
      return;
    }
    const value = node.childForFieldName("value") ?? node.namedChildren.find((child) => child.type !== "decorator");
    if (!value) return;
    const exported = "default"; // `export = x` is seen as the default export by importers
    if (isDefault && (isFunctionValue(value) || value.type === "class")) {
      const kind: UnitKind = value.type === "class" ? "class" : functionKind(value);
      const inner = this.declareUnit("default", kind, value, node, context);
      if (kind === "class") this.visitChildren(value, inner);
      else this.functionBody(value, inner);
      this.exports.push({ exported, local: "default", line });
      return;
    }
    this.exports.push(value.type === "identifier" ? { exported, local: value.text, line } : { exported, line });
    this.visit(value, context, node, "value");
  }

  private exportedDeclaration(
    statement: Node,
    declaration: Node,
    isDefault: boolean,
    context: Context,
    line: number,
  ): void {
    const names: string[] = [];
    declaredNames(declaration, names);
    const name = declaration.childForFieldName("name");
    if (names.length === 0 && name) names.push(name.text);
    // `export import X = N;` names X with its first identifier child rather than a name field.
    const alias = declaration.type === "import_alias" ? declaration.namedChildren.find((c) => c.type === "identifier") : undefined;
    if (names.length === 0 && alias) names.push(alias.text);
    if (isDefault) {
      const anonymous = functionTypes.has(declaration.type) || classTypes.has(declaration.type);
      const unitName = name?.text ?? "default";
      this.exports.push({ exported: "default", local: unitName, line });
      if (anonymous && !name) {
        const kind: UnitKind = classTypes.has(declaration.type) ? "class" : "function";
        const inner = this.declareUnit("default", kind, declaration, statement, context);
        if (kind === "class") this.visitChildren(declaration, inner);
        else this.functionBody(declaration, inner);
        return;
      }
    } else {
      for (const exported of names) this.exports.push({ exported, local: exported, line });
    }
    this.visit(declaration, context, statement, "declaration");
  }

  private call(node: Node, context: Context): void {
    const callee = node.childForFieldName("function");
    const args = node.childForFieldName("arguments");
    if (callee?.type === "import") {
      const first = args?.namedChildren[0] ?? null;
      this.imports.push({
        specifier: stringValue(first),
        kind: "dynamic",
        typeOnly: false,
        line: node.startPosition.row + 1,
        bindings: [],
      });
    } else if (callee?.type === "identifier" && callee.text === "require" && !context.shadow.has("require")) {
      const specifier = args?.namedChildren.length === 1 ? stringValue(args.namedChildren[0] ?? null) : null;
      if (specifier !== null) {
        this.imports.push({
          specifier,
          kind: "require",
          typeOnly: false,
          line: node.startPosition.row + 1,
          bindings: [],
        });
        return;
      }
    }
    if (callee?.type === "identifier") this.reference(callee, context, "call");
    else if (callee?.type === "member_expression") this.member(callee, context, "call");
    else if (callee) this.visit(callee, context, node, "function");
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.isNamed && node.fieldNameForChild(i) !== "function") {
        this.visit(child, context, node, node.fieldNameForChild(i));
      }
    }
  }

  private newExpression(node: Node, context: Context): void {
    const constructor = node.childForFieldName("constructor");
    if (constructor?.type === "identifier") this.reference(constructor, context, "call");
    else if (constructor?.type === "member_expression") this.member(constructor, context, "call");
    else if (constructor) this.visit(constructor, context, node, "constructor");
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.isNamed && node.fieldNameForChild(i) !== "constructor") {
        this.visit(child, context, node, node.fieldNameForChild(i));
      }
    }
  }

  /** `object.property`: a use of `object`, remembering the member for namespace imports. */
  private member(node: Node, context: Context, kind: "call" | "reference"): void {
    const object = node.childForFieldName("object");
    const property = node.childForFieldName("property");
    if (object?.type === "identifier" && property) {
      this.reference(object, context, kind, property.text);
      return;
    }
    if (object) this.visit(object, context, node, "object");
  }

  /** A decorator is a reference, not a call, even when written `@decorate()`. */
  private decorator(node: Node, context: Context): void {
    const target = node.namedChildren[0];
    if (!target) return;
    const callee = target.type === "call_expression" ? target.childForFieldName("function") : target;
    if (callee?.type === "identifier") this.reference(callee, context, "reference");
    else if (callee?.type === "member_expression") this.member(callee, context, "reference");
    if (target.type === "call_expression") {
      const args = target.childForFieldName("arguments");
      if (args) this.visit(args, context, target, "arguments");
    }
  }

  private jsxElement(node: Node, context: Context): void {
    const name = node.childForFieldName("name");
    if (name?.type === "identifier") this.reference(name, context, "reference");
    else if (name?.type === "member_expression" || name?.type === "nested_identifier") {
      const first = name.namedChildren[0];
      const second = name.namedChildren[1];
      if (first?.type === "identifier") this.reference(first, context, "reference", second?.text);
    }
    for (const child of node.namedChildren) {
      if (child.id !== name?.id) this.visit(child, context, node, null);
    }
  }
}

function wrapperOf(parent: Node): Node | undefined {
  return parent.type === "export_statement" ? parent : undefined;
}

function scopeOf(context: Context, name: string): Context {
  const unit = context.unit === undefined ? name : `${context.unit}.${name}`;
  return { unit, shadow: context.shadow };
}

/** Extracts a file's units, imports, exports and references from its syntax tree. */
export function extractFacts(root: Node): FileFacts {
  return new Extractor().extract(root);
}
