import type { Node } from "web-tree-sitter";
import type { DeclarationKind, FileFacts, SymbolDeclaration, SymbolReference, UnitFact } from "../../facts.ts";
import type { ExtractOptions } from "../../language-adapter.ts";
import { codeRowsOf, measureFunction } from "../../unit-metrics.ts";
import { nodeCount, type InterfaceShape } from "../typescript/interface-shape.ts";
import { kotlinMetricRules, parameterCounts } from "./metric-rules.ts";

const commentTypes = kotlinMetricRules.constructs.commentTypes;
const isComment = (node: Node): boolean => commentTypes.has(node.type);
const typeDeclarations = new Set(["class_declaration", "object_declaration", "companion_object"]);
const literalTypes = new Set(["number_literal", "string_literal", "boolean_literal", "null_literal", "character_literal", "this_expression", "real_literal", "integer_literal"]);

/** Identifiers that name something being declared or bound, and are not uses. */
const bindingParents = new Set([
  "variable_declaration",
  "parameter",
  "class_parameter",
  "lambda_parameters",
  "enum_entry",
  "type_alias",
  "function_declaration",
  "class_declaration",
  "object_declaration",
  "companion_object",
  "package_header",
  "qualified_identifier",
  "import",
  "catch_block",
  "labeled_expression",
  "constructor_invocation",
  "secondary_constructor",
  "setter",
  "multi_variable_declaration",
  "user_type",
  "type_parameter",
]);

interface Context {
  /** Qualified name (within the file) of the innermost enclosing unit. */
  unit: string | undefined;
  /** The enclosing unit is a type, so a function directly inside it is a method. */
  inType: boolean;
  /** True while inside types whose members are visible outside the module. */
  exposed: boolean;
  /** True at the top level of the file, outside any type or function. */
  topLevel: boolean;
}

/** The modifier words of a declaration, such as `internal`, `abstract` and `data`. */
export function modifierWords(node: Node): Set<string> {
  const modifiers = node.namedChildren.find((child) => child.type === "modifiers");
  const words = new Set<string>();
  const visit = (current: Node): void => {
    if (current.type === "annotation") return;
    if (current.childCount === 0 && !current.isNamed) words.add(current.type);
    for (const child of current.children) visit(child);
  };
  if (modifiers !== undefined) visit(modifiers);
  return words;
}

/** Start row of a declaration, ignoring annotations that precede its first keyword. */
function startRow(node: Node): number {
  for (const child of node.children) {
    if (child.type === "modifiers") {
      const first = child.children.find((part) => part.type !== "annotation");
      if (first !== undefined) return first.startPosition.row;
      continue;
    }
    return child.startPosition.row;
  }
  return node.startPosition.row;
}

/** `Outer.Inner` from the identifiers of a `user_type` or `qualified_identifier`. */
function dotted(node: Node): string {
  return node.namedChildren
    .filter((child) => child.type === "identifier")
    .map((child) => child.text)
    .join(".");
}

function typeKind(node: Node, words: ReadonlySet<string>): DeclarationKind {
  if (node.type === "object_declaration" || node.type === "companion_object") return "class";
  if (node.children.some((child) => !child.isNamed && child.type === "interface")) return "interface";
  if (words.has("enum")) return "enum";
  if (words.has("abstract") || words.has("sealed")) return "abstract-class";
  return "class";
}

/** The receiver of a navigation chain, all but its last identifier, when that is a plain chain of names. */
function receiverChain(navigation: Node): string | undefined {
  const [receiver] = navigation.namedChildren;
  if (receiver === undefined) return undefined;
  if (receiver.type === "identifier") return receiver.text;
  if (receiver.type === "navigation_expression") {
    const inner = receiverChain(receiver);
    const member = receiver.namedChildren[1];
    return inner !== undefined && member?.type === "identifier" ? `${inner}.${member.text}` : undefined;
  }
  return undefined;
}

function typeShape(declaration: Node): InterfaceShape {
  let interfaceSize = 0;
  const primary = declaration.namedChildren.find((child) => child.type === "primary_constructor");
  interfaceSize += primary?.namedChildren.find((child) => child.type === "class_parameters")?.namedChildren.filter((child) => child.type === "class_parameter").length ?? 0;
  const body = declaration.namedChildren.find((child) => child.type === "class_body" || child.type === "enum_class_body");
  for (const member of body?.namedChildren ?? []) {
    if (modifierWords(member).has("private")) continue;
    if (member.type === "secondary_constructor") interfaceSize += parameterCounts(member).parameters;
    else if (member.type === "function_declaration" || member.type === "enum_entry") interfaceSize++;
    else if (member.type === "property_declaration") interfaceSize += Math.max(1, member.namedChildren.filter((child) => child.type === "variable_declaration").length);
  }
  return { nodes: nodeCount(declaration, isComment), interfaceSize: Math.max(1, interfaceSize) };
}

function parameterNames(fn: Node): Set<string> {
  const names = new Set<string>();
  for (const list of fn.namedChildren.filter((child) => child.type === "function_value_parameters")) {
    for (const parameter of list.namedChildren) {
      const name = parameter.type === "parameter" ? parameter.namedChildren.find((child) => child.type === "identifier") : undefined;
      if (name !== undefined) names.add(name.text);
    }
  }
  return names;
}

function unwrap(node: Node | null): Node | null {
  let current = node;
  while (current !== null && current.type === "parenthesized_expression") current = current.namedChildren.find((child) => !isComment(child)) ?? null;
  return current;
}

/**
 * The call a function's whole body forwards to, as written (`store.save`), or undefined: a single call, as an
 * expression body or the only statement of a block, whose every argument is a parameter or a literal.
 */
function passThroughOf(fn: Node, parameters: ReadonlySet<string>): string | undefined {
  const body = fn.namedChildren.find((child) => child.type === "function_body");
  if (body === undefined) return undefined;
  let expression: Node | null = body.namedChildren.find((child) => !isComment(child)) ?? null;
  if (expression?.type === "block") {
    const statements = expression.namedChildren.filter((child) => !isComment(child));
    if (statements.length !== 1) return undefined;
    expression = statements[0]!;
    if (expression.type === "return_expression") expression = expression.namedChildren.find((child) => !isComment(child)) ?? null;
  }
  const call = unwrap(expression);
  if (call === null || call.type !== "call_expression") return undefined;
  const callee = call.namedChildren[0];
  if (callee === undefined) return undefined;
  const args = call.namedChildren.find((child) => child.type === "value_arguments");
  if (args === undefined || call.namedChildren.some((child) => child.type === "annotated_lambda")) return undefined;
  const forwarded = args.namedChildren
    .filter((child) => !isComment(child))
    .every((argument) => {
      const value = argument.namedChildren.at(-1);
      return value !== undefined && argument.namedChildren.length === 1 && (value.type === "identifier" ? parameters.has(value.text) : literalTypes.has(value.type));
    });
  return forwarded ? callee.text.replace(/\s+/g, "") : undefined;
}

class Extractor {
  readonly units: UnitFact[] = [];
  readonly declarations: SymbolDeclaration[] = [];
  readonly references: SymbolReference[] = [];
  readonly uses = new Set<string>();
  /** Simple names an import makes visible, to the name they stand for: the imported name, or its `as` alias. */
  private readonly aliases = new Map<string, string>();
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
    // Imports and the package come first in a file, but aliases must be known before any reference is written.
    for (const child of root.namedChildren) {
      if (child.type === "package_header") this.packageName = dotted(child.namedChildren.find((part) => part.type === "qualified_identifier") ?? child);
      else if (child.type === "import") this.importDirective(child);
    }
    const context: Context = { unit: undefined, inType: false, exposed: true, topLevel: true };
    for (const child of root.namedChildren) if (child.type !== "package_header" && child.type !== "import") this.visit(child, context);
    return {
      units: this.units,
      imports: [],
      reexports: [],
      exports: [],
      references: [],
      symbols: { namespaces: this.packageName === "" ? [] : [this.packageName], uses: [...this.uses], declarations: this.declarations, references: this.references },
      nodes: nodeCount(root, (node) => isComment(node) || node.type === "import") - 1,
      hasSyntaxErrors: root.hasError,
    };
  }

  /** `import a.b.C` reaches `a.b.C` (and its enclosing class for a member) and makes `C` mean it; `import a.b.*` brings `a.b` in; `as` renames. */
  private importDirective(node: Node): void {
    const name = dotted(node.namedChildren.find((child) => child.type === "qualified_identifier") ?? node);
    if (name === "") return;
    const line = node.startPosition.row + 1;
    if (node.children.some((child) => !child.isNamed && child.type === "*")) {
      this.uses.add(name);
      return;
    }
    const parent = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "";
    this.references.push({ name, kind: "reference", line });
    // A member of a class or object (an enum entry, a constant) is reached through its owner.
    if (parent.includes(".")) this.references.push({ name: parent, kind: "reference", line });
    const alias = node.namedChildren.filter((child) => child.type === "identifier").at(-1);
    const renamed = alias !== undefined && node.children.some((child) => !child.isNamed && child.type === "as");
    this.aliases.set(renamed ? alias.text : name.slice(name.lastIndexOf(".") + 1), name);
  }

  private qualified(chain: string): string {
    return this.packageName === "" ? chain : `${this.packageName}.${chain}`;
  }

  private reference(written: string, kind: "call" | "reference", node: Node, context: Context): void {
    const head = written.split(".")[0]!;
    const aliased = this.aliases.get(head);
    const name = aliased === undefined ? written : `${aliased}${written.slice(head.length)}`;
    const fact: SymbolReference = { name, kind, line: node.startPosition.row + 1 };
    if (context.unit !== undefined) fact.inUnit = context.unit;
    this.references.push(fact);
  }

  private visitChildren(node: Node, context: Context, skip?: Node | null): void {
    for (const child of node.namedChildren) if (child.id !== skip?.id) this.visit(child, context);
  }

  private visit(node: Node, context: Context): void {
    const type = node.type;
    if (typeDeclarations.has(type)) return this.typeDeclaration(node, context);
    switch (type) {
      case "function_declaration":
        return this.functionDeclaration(node, context);
      case "secondary_constructor":
        return this.functionDeclaration(node, context);
      case "property_declaration":
        this.propertyDeclaration(node, context);
        return;
      case "user_type": {
        this.reference(dotted(node), "reference", node, context);
        for (const child of node.namedChildren) if (child.type !== "identifier") this.visit(child, context);
        return;
      }
      case "constructor_invocation": {
        const target = node.namedChildren.find((child) => child.type === "user_type");
        if (target !== undefined) this.reference(dotted(target), "call", target, context);
        for (const child of node.namedChildren) if (child.id !== target?.id) this.visit(child, context);
        if (target !== undefined) for (const child of target.namedChildren) if (child.type !== "identifier") this.visit(child, context);
        return;
      }
      case "call_expression": {
        const callee = node.namedChildren[0];
        if (callee?.type === "identifier") {
          this.reference(callee.text, "call", callee, context);
          this.visitChildren(node, context, callee);
          return;
        }
        if (callee?.type === "navigation_expression") {
          const receiver = receiverChain(callee);
          if (receiver !== undefined) this.reference(receiver, "call", callee, context);
          else if (callee.namedChildren[0] !== undefined) this.visit(callee.namedChildren[0], context);
          this.visitChildren(node, context, callee);
          return;
        }
        this.visitChildren(node, context);
        return;
      }
      case "navigation_expression": {
        const receiver = receiverChain(node);
        if (receiver !== undefined) this.reference(receiver, "reference", node, context);
        else if (node.namedChildren[0] !== undefined) this.visit(node.namedChildren[0], context);
        return;
      }
      case "identifier":
        if (node.parent !== null && !bindingParents.has(node.parent.type)) this.reference(node.text, "reference", node, context);
        return;
      case "object_literal":
        // The functions of an anonymous object are its methods.
        this.visitChildren(node, { ...context, inType: true, topLevel: false });
        return;
      case "annotation": {
        // `@Inject` names a type: its user_type is visited like any other.
        this.visitChildren(node, context);
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

  private isVisible(words: ReadonlySet<string>, context: Context): boolean {
    if (words.has("private") || words.has("internal")) return false;
    return context.exposed;
  }

  private typeDeclaration(node: Node, context: Context): void {
    const name = node.type === "companion_object" ? (node.childForFieldName("name")?.text ?? "Companion") : node.childForFieldName("name")?.text;
    if (name === undefined) return this.visitChildren(node, context);
    const words = modifierWords(node);
    const chain = context.unit === undefined ? name : `${context.unit}.${name}`;
    const qualifiedName = this.unitName(chain);
    const visible = this.isVisible(words, context);
    const kind = typeKind(node, words);
    const unit: UnitFact = { qualifiedName, kind: "class", startLine: startRow(node) + 1, endLine: node.endPosition.row + 1, source: "structural", shape: typeShape(node) };
    if (context.unit !== undefined) unit.parent = context.unit;
    this.units.push(unit);
    // A class declared inside a function is not visible to any other file.
    if (context.topLevel || context.inType) this.declarations.push({ name: this.qualified(chain), kind, unit: qualifiedName, exported: visible, line: node.startPosition.row + 1 });
    const inside: Context = { unit: qualifiedName, inType: true, exposed: visible, topLevel: false };
    for (const child of node.namedChildren) this.visit(child, child.type === "modifiers" ? context : inside);
  }

  private functionDeclaration(node: Node, context: Context): void {
    const isConstructor = node.type === "secondary_constructor";
    const name = isConstructor ? "constructor" : node.childForFieldName("name")?.text;
    const hasBody = node.namedChildren.some((child) => child.type === "function_body" || (isConstructor && child.type === "block"));
    if (name === undefined || !hasBody) return this.visitChildren(node, { ...context, topLevel: false });
    const qualifiedName = this.unitName(context.unit === undefined ? name : `${context.unit}.${name}`);
    const startLine = startRow(node) + 1;
    const endLine = node.endPosition.row + 1;
    this.codeRows ??= codeRowsOf(this.root, kotlinMetricRules);
    const measured = measureFunction(node, { name, startLine, endLine, codeRows: this.codeRows, explain: this.explain }, kotlinMetricRules);
    const unit: UnitFact = { qualifiedName, kind: context.inType ? "method" : "function", startLine, endLine, source: "structural", metrics: measured.metrics };
    if (context.unit !== undefined) unit.parent = context.unit;
    unit.shape = { nodes: nodeCount(node, isComment), interfaceSize: Math.max(1, measured.metrics.parameters) };
    const forwarded = passThroughOf(node, parameterNames(node));
    if (forwarded !== undefined) unit.passThrough = forwarded;
    if (measured.recursive) unit.recursive = true;
    if (modifierWords(node).has("override")) unit.override = true;
    if (measured.increments !== undefined) unit.increments = measured.increments;
    this.units.push(unit);
    if (context.topLevel && !isConstructor) {
      const words = modifierWords(node);
      this.declarations.push({ name: this.qualified(name), kind: "function", unit: qualifiedName, exported: this.isVisible(words, context), line: node.startPosition.row + 1 });
    }
    const inside: Context = { unit: qualifiedName, inType: false, exposed: context.exposed, topLevel: false };
    for (const child of node.namedChildren) this.visit(child, child.type === "modifiers" ? context : inside);
  }

  private propertyDeclaration(node: Node, context: Context): void {
    if (context.topLevel) {
      const words = modifierWords(node);
      for (const variable of node.namedChildren.filter((child) => child.type === "variable_declaration")) {
        const name = variable.namedChildren.find((child) => child.type === "identifier")?.text;
        if (name !== undefined) this.declarations.push({ name: this.qualified(name), kind: "variable", exported: this.isVisible(words, context), line: node.startPosition.row + 1 });
      }
    }
    this.visitChildren(node, { ...context, topLevel: false });
  }
}

export function extractFacts(root: Node, options: ExtractOptions = {}): FileFacts {
  return new Extractor(options).extract(root);
}

