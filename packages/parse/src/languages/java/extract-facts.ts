import type { Node } from "web-tree-sitter";
import type { DeclarationKind, FileFacts, SymbolDeclaration, SymbolReference, UnitFact } from "../../facts.ts";
import type { ExtractOptions } from "../../language-adapter.ts";
import { codeRowsOf, measureFunction } from "../../unit-metrics.ts";
import { nodeCount, type InterfaceShape } from "../typescript/interface-shape.ts";
import { javaMetricRules, parameterCounts } from "./metric-rules.ts";

const typeDeclarations = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"]);
const functionDeclarations = new Set(["method_declaration", "constructor_declaration", "compact_constructor_declaration"]);
const commentTypes = javaMetricRules.constructs.commentTypes;
const isComment = (node: Node): boolean => commentTypes.has(node.type);
const literalTypes = new Set(["decimal_integer_literal", "hex_integer_literal", "octal_integer_literal", "binary_integer_literal", "decimal_floating_point_literal", "string_literal", "character_literal", "true", "false", "null_literal", "this"]);

interface Context {
  /** Qualified name (within the file) of the innermost enclosing unit. */
  unit: string | undefined;
  /** Name of the innermost enclosing type, for naming constructors. */
  type: string | undefined;
  /** True while inside a type whose members are visible outside the package. */
  exposed: boolean;
  /** The enclosing type is an interface, whose members are implicitly public. */
  inInterface: boolean;
}

/** The modifier keywords of a declaration, such as `public` and `abstract`. */
export function modifiersOf(node: Node): Set<string> {
  const modifiers = node.namedChildren.find((child) => child.type === "modifiers");
  const words = new Set<string>();
  for (const child of modifiers?.children ?? []) if (!child.isNamed) words.add(child.type);
  return words;
}

/** True for a method marked `@Override`. */
function overridesMethod(node: Node): boolean {
  const modifiers = node.namedChildren.find((child) => child.type === "modifiers");
  return (modifiers?.namedChildren ?? []).some((child) => child.type === "marker_annotation" && child.childForFieldName("name")?.text === "Override");
}

/** Start row of a declaration, ignoring annotations that precede its first keyword. */
function startRow(node: Node): number {
  for (const child of node.children) {
    if (child.type === "modifiers") {
      const first = child.children.find((part) => part.type !== "marker_annotation" && part.type !== "annotation");
      if (first !== undefined) return first.startPosition.row;
      continue;
    }
    return child.startPosition.row;
  }
  return node.startPosition.row;
}

function typeKind(node: Node, words: ReadonlySet<string>): DeclarationKind {
  if (node.type === "interface_declaration" || node.type === "annotation_type_declaration") return "interface";
  if (node.type === "enum_declaration") return "enum";
  if (node.type === "class_declaration" && words.has("abstract")) return "abstract-class";
  return "class";
}

/** The dotted text of a name that is an identifier or a chain of them, or undefined for anything else. */
function chainText(node: Node | null): string | undefined {
  if (node === null) return undefined;
  if (node.type === "identifier" || node.type === "type_identifier") return node.text;
  if (node.type === "scoped_identifier" || node.type === "scoped_type_identifier") return node.text.replace(/\s+/g, "");
  if (node.type === "field_access") {
    const object = chainText(node.childForFieldName("object"));
    const field = node.childForFieldName("field")?.text;
    return object !== undefined && field !== undefined ? `${object}.${field}` : undefined;
  }
  return undefined;
}

/** Class interface: the constructor's parameters plus the members a user can reach (not `private`), at least 1. */
function typeShape(declaration: Node): InterfaceShape {
  let interfaceSize = 0;
  const components = declaration.childForFieldName("parameters");
  if (components !== null) interfaceSize += parameterCounts(declaration).parameters;
  const body = declaration.childForFieldName("body");
  const members = declaration.type === "enum_declaration" ? (body?.namedChildren.flatMap((child) => (child.type === "enum_body_declarations" ? child.namedChildren : [child])) ?? []) : (body?.namedChildren ?? []);
  for (const member of members) {
    if (modifiersOf(member).has("private")) continue;
    if (member.type === "constructor_declaration") interfaceSize += parameterCounts(member).parameters;
    else if (member.type === "method_declaration" || member.type === "enum_constant") interfaceSize++;
    else if (member.type === "field_declaration") interfaceSize += member.namedChildren.filter((child) => child.type === "variable_declarator").length;
  }
  return { nodes: nodeCount(declaration, isComment), interfaceSize: Math.max(1, interfaceSize) };
}

function unwrap(node: Node | null): Node | null {
  let current = node;
  while (current !== null && (current.type === "parenthesized_expression" || current.type === "cast_expression")) {
    current = current.type === "cast_expression" ? current.childForFieldName("value") : (current.namedChildren.find((child) => !isComment(child)) ?? null);
  }
  return current;
}

/**
 * The call a method's whole body forwards to, as written (`store.save`), or undefined: one statement that is a
 * call whose every argument is a parameter of the method or a literal.
 */
function passThroughOf(fn: Node, parameters: ReadonlySet<string>): string | undefined {
  const body = fn.childForFieldName("body");
  if (body === null || body.type !== "block") return undefined;
  const statements = body.namedChildren.filter((child) => !isComment(child));
  if (statements.length !== 1) return undefined;
  const [statement] = statements as [Node];
  if (statement.type !== "return_statement" && statement.type !== "expression_statement") return undefined;
  const call = unwrap(statement.namedChildren.find((child) => !isComment(child)) ?? null);
  if (call === null || call.type !== "method_invocation") return undefined;
  const args = call.childForFieldName("arguments");
  if (args === null) return undefined;
  const forwarded = args.namedChildren.filter((child) => !isComment(child)).every((argument) => (argument.type === "identifier" ? parameters.has(argument.text) : literalTypes.has(argument.type)));
  if (!forwarded) return undefined;
  const name = call.childForFieldName("name")!.text;
  const object = call.childForFieldName("object");
  return object === null ? name : `${object.text}.${name}`;
}

function parameterNames(fn: Node): Set<string> {
  const names = new Set<string>();
  const list = fn.childForFieldName("parameters");
  for (const parameter of list?.namedChildren ?? []) {
    const name = parameter.type === "spread_parameter" ? parameter.namedChildren.find((child) => child.type === "variable_declarator")?.childForFieldName("name") : parameter.childForFieldName("name");
    if (name !== null && name !== undefined) names.add(name.text);
  }
  return names;
}

class Extractor {
  readonly units: UnitFact[] = [];
  readonly declarations: SymbolDeclaration[] = [];
  readonly references: SymbolReference[] = [];
  readonly uses = new Set<string>();
  /** Simple names an import makes visible, to the name they stand for. */
  private readonly imported = new Map<string, string>();
  private packageName = "";
  private readonly nameCounts = new Map<string, number>();
  private codeRows: boolean[] | undefined;
  private root!: Node;
  private readonly explain: boolean;

  constructor(options: ExtractOptions) {
    this.explain = options.explain === true;
  }

  extract(root: Node): FileFacts {
    this.root = root;
    const context: Context = { unit: undefined, type: undefined, exposed: true, inInterface: false };
    // Imports are read first, so every name written in the file is known to be imported or not.
    for (const child of root.namedChildren) {
      if (child.type === "package_declaration") this.packageName = chainText(child.namedChildren.find((part) => part.type !== "marker_annotation" && part.type !== "annotation" && !isComment(part)) ?? null) ?? "";
      else if (child.type === "import_declaration") this.importDeclaration(child);
    }
    for (const child of root.namedChildren) if (child.type !== "package_declaration" && child.type !== "import_declaration") this.visit(child, context);
    return {
      units: this.units,
      imports: [],
      reexports: [],
      exports: [],
      references: [],
      symbols: { namespaces: this.packageName === "" ? [] : [this.packageName], uses: [...this.uses], declarations: this.declarations, references: this.references },
      nodes: nodeCount(root, (node) => isComment(node) || node.type === "import_declaration") - 1,
      hasSyntaxErrors: root.hasError,
    };
  }

  /** `import a.b.C;` reaches the type `a.b.C` and makes `C` mean it; `import a.b.*;` brings `a.b` in; a static import reaches the class that holds the member. */
  private importDeclaration(node: Node): void {
    const name = chainText(node.namedChildren.find((child) => child.type === "scoped_identifier" || child.type === "identifier") ?? null);
    if (name === undefined) return;
    const isStatic = node.children.some((child) => child.type === "static");
    const wildcard = node.namedChildren.some((child) => child.type === "asterisk");
    const line = node.startPosition.row + 1;
    const parent = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "";
    if (!wildcard) this.imported.set(name.slice(name.lastIndexOf(".") + 1), name);
    if (wildcard) {
      this.uses.add(name);
      if (isStatic) this.references.push({ name, kind: "reference", line });
      return;
    }
    if (isStatic) {
      if (parent !== "") this.references.push({ name: parent, kind: "reference", line });
      return;
    }
    this.references.push({ name, kind: "reference", line });
  }

  private qualified(chain: string): string {
    return this.packageName === "" ? chain : `${this.packageName}.${chain}`;
  }

  private reference(written: string, kind: "call" | "reference", node: Node, context: Context): void {
    const head = written.split(".")[0]!;
    const imported = this.imported.get(head);
    const name = imported === undefined ? written : `${imported}${written.slice(head.length)}`;
    const fact: SymbolReference = { name, kind, line: node.startPosition.row + 1 };
    if (context.unit !== undefined) fact.inUnit = context.unit;
    this.references.push(fact);
  }

  private visitChildren(node: Node, context: Context): void {
    for (const child of node.namedChildren) this.visit(child, context);
  }

  private visit(node: Node, context: Context): void {
    const type = node.type;
    if (typeDeclarations.has(type)) return this.typeDeclaration(node, context);
    if (functionDeclarations.has(type)) return this.functionDeclaration(node, context);
    switch (type) {
      case "type_identifier":
        if (node.parent?.type !== "type_parameter") this.reference(node.text, "reference", node, context);
        return;
      case "scoped_type_identifier":
        this.reference(node.text.replace(/\s+/g, ""), "reference", node, context);
        return;
      case "marker_annotation":
      case "annotation": {
        const name = chainText(node.childForFieldName("name"));
        if (name !== undefined) this.reference(name, "reference", node, context);
        const args = node.childForFieldName("arguments");
        if (args !== null) this.visitChildren(args, context);
        return;
      }
      case "object_creation_expression": {
        const created = node.childForFieldName("type");
        const target = created?.type === "generic_type" ? created.namedChildren[0] : created;
        if (target !== null && target !== undefined) {
          const name = chainText(target);
          if (name !== undefined) this.reference(name, "call", target, context);
        }
        for (const child of node.namedChildren) if (child.id !== created?.id) this.visit(child, context);
        for (const child of created?.namedChildren ?? []) if (child.id !== target?.id) this.visit(child, context);
        return;
      }
      case "method_invocation": {
        const object = node.childForFieldName("object");
        const name = chainText(object);
        if (name !== undefined) this.reference(name, "call", object!, context);
        for (const child of node.namedChildren) {
          if (child.id === object?.id && name !== undefined) continue;
          if (child.id === node.childForFieldName("name")?.id) continue;
          this.visit(child, context);
        }
        return;
      }
      case "field_access": {
        const object = node.childForFieldName("object");
        const name = chainText(object);
        if (name !== undefined) {
          this.reference(name, "reference", object!, context);
          return;
        }
        this.visitChildren(node, context);
        return;
      }
      case "method_reference": {
        const first = node.namedChildren[0];
        const name = chainText(first ?? null);
        if (first !== undefined && name !== undefined) this.reference(name, "reference", first, context);
        else this.visitChildren(node, context);
        return;
      }
      default:
        this.visitChildren(node, context);
    }
  }

  private unitName(base: string): string {
    const seen = this.nameCounts.get(base) ?? 0;
    this.nameCounts.set(base, seen + 1);
    return seen === 0 ? base : `${base}~${seen + 1}`;
  }

  private typeDeclaration(node: Node, context: Context): void {
    const name = node.childForFieldName("name")?.text;
    if (name === undefined) return this.visitChildren(node, context);
    const words = modifiersOf(node);
    const chain = context.unit === undefined ? name : `${context.unit}.${name}`;
    const qualifiedName = this.unitName(chain);
    const visible = context.unit === undefined ? words.has("public") : context.exposed && (context.inInterface || words.has("public") || words.has("protected"));
    const kind = typeKind(node, words);
    const unit: UnitFact = { qualifiedName, kind: "class", startLine: startRow(node) + 1, endLine: node.endPosition.row + 1, source: "structural" };
    if (context.unit !== undefined) unit.parent = context.unit;
    unit.shape = typeShape(node);
    this.units.push(unit);
    this.declarations.push({ name: this.qualified(chain), kind, unit: qualifiedName, exported: visible, line: node.startPosition.row + 1 });
    const inside: Context = { unit: qualifiedName, type: name, exposed: visible, inInterface: kind === "interface" };
    for (const child of node.namedChildren) this.visit(child, child.type === "modifiers" ? context : inside);
  }

  private functionDeclaration(node: Node, context: Context): void {
    const body = node.childForFieldName("body");
    const name = node.childForFieldName("name")?.text;
    if (body === null || name === undefined) return this.visitChildren(node, context);
    // Constructors take the name of their class, which is the name they are declared with.
    const qualifiedName = this.unitName(context.unit === undefined ? name : `${context.unit}.${name}`);
    const startLine = startRow(node) + 1;
    const endLine = node.endPosition.row + 1;
    this.codeRows ??= codeRowsOf(this.root, javaMetricRules);
    const measured = measureFunction(node, { name, startLine, endLine, codeRows: this.codeRows, explain: this.explain }, javaMetricRules);
    const unit: UnitFact = { qualifiedName, kind: "method", startLine, endLine, source: "structural", metrics: measured.metrics };
    if (context.unit !== undefined) unit.parent = context.unit;
    unit.shape = { nodes: nodeCount(node, isComment), interfaceSize: Math.max(1, measured.metrics.parameters) };
    const forwarded = passThroughOf(node, parameterNames(node));
    if (forwarded !== undefined) unit.passThrough = forwarded;
    if (measured.recursive) unit.recursive = true;
    if (overridesMethod(node)) unit.override = true;
    const words = modifiersOf(node);
    if (!context.inInterface && !words.has("public") && !words.has("protected")) unit.hidden = true;
    if (measured.increments !== undefined) unit.increments = measured.increments;
    this.units.push(unit);
    const inside: Context = { ...context, unit: qualifiedName };
    for (const child of node.namedChildren) this.visit(child, child.type === "modifiers" ? context : inside);
  }
}

export function extractFacts(root: Node, options: ExtractOptions = {}): FileFacts {
  return new Extractor(options).extract(root);
}

