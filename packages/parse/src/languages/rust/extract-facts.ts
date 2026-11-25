import type { Node } from "web-tree-sitter";
import type { ExportFact, FileFacts, ImportFact, ReexportFact, ReferenceFact, UnitFact, UnitKind } from "../../facts.ts";
import { codeRowsOf, measureFunction } from "../../unit-metrics.ts";
import { nodeCount } from "../typescript/interface-shape.ts";
import { functionShape, parameterNames, passThroughOf, typeShape } from "./interface-shape.ts";
import { rustMetricRules, typeName } from "./metric-rules.ts";

/**
 * Bump when the extraction rules change in a way that alters facts for the same source, so cached facts from
 * older rules are not reused.
 */
export const extractorVersion = 4;

/**
 * How a Rust file is read, in terms the import model understands (see resolve-path.ts for the specifiers).
 *
 * - A `use` leaf is an import: the specifier is its path up to the item, the binding the item. The item is the
 *   first segment after the module path that starts with a capital (a type, so `use a::Enum::Variant`
 *   imports `Enum`), otherwise the last. `self` and `super` are counted from the file's module, with inline
 *   modules unwound, and a leading name that a `mod` of the same scope declares is that module.
 * - `mod name;` is an import of the module's file, bound to its name, and an export of it, so a path through
 *   the module finds the file. A `use` that is `pub` is an export of its binding, a pass-through as in
 *   TypeScript's `export { a } from`, and a `pub use a::*` is a star re-export.
 * - Every item of a file is an export, flagged `internal` unless it is plain `pub`. Resolution reaches
 *   private items, because a child module may use them, and the public surface does not list them. Items of
 *   inline modules are exported under their own names, after the file's own, so a path that ends in an
 *   inline module still finds them.
 * - Units are functions and closures bound by `let`, methods under the name of the type of their `impl` or
 *   the trait that declares them, and the types and traits themselves, as classes.
 */

interface Context {
  /** Qualified name of the innermost enclosing unit; names of nested units are built from it. */
  unit: string | undefined;
  /** Names of the inline modules around the node, outermost first. */
  mods: readonly string[];
  /** The type of the `impl` block or the trait the node is a member of. */
  owner: string | undefined;
  /** Every enclosing inline module is plain `pub`. */
  exposed: boolean;
  /** Modules declared by the scope the node sits in, whose names start a path. */
  localMods: ReadonlySet<string>;
  /** The node is a member of an `impl Trait for Type` block, so its functions implement the trait's methods. */
  implementsTrait?: boolean;
  /** An enclosing module or impl block is `#[cfg(test)]`. */
  inTests?: boolean;
}

type Visibility = "public" | "restricted" | "private";

function visibilityOf(node: Node): Visibility {
  const modifier = node.namedChildren.find((child) => child.type === "visibility_modifier");
  if (modifier === undefined) return "private";
  return modifier.namedChildren.length === 0 ? "public" : "restricted";
}

const isComment = (node: Node): boolean => node.type === "line_comment" || node.type === "block_comment";

/** Attribute names written on the item, from the attribute items just before it. */
function attributesOf(node: Node): Node[] {
  const out: Node[] = [];
  for (let previous = node.previousNamedSibling; previous !== null && (previous.type === "attribute_item" || isComment(previous)); previous = previous.previousNamedSibling) {
    if (previous.type === "attribute_item") out.push(previous);
  }
  return out;
}

function attributeNamed(node: Node, name: string): Node | undefined {
  return attributesOf(node)
    .map((item) => item.namedChildren.find((child) => child.type === "attribute"))
    .find((attribute) => attribute?.namedChildren[0]?.text === name);
}

/** The item carries `#[cfg(test)]`, `#[test]` or an async runtime's `::test` attribute, so it is test code wherever its file sits. */
function isTestItem(node: Node): boolean {
  return attributesOf(node).some((item) => /^#\[\s*(cfg\s*\(\s*test\s*\)|(\w+::)*test(\s*\(.*\))?)\s*\]$/s.test(item.text.trim()));
}

/** The function is a procedural macro, which the compiler calls by its `#[proc_macro]`, `#[proc_macro_attribute]` or `#[proc_macro_derive]` attribute. */
function isProcMacro(node: Node): boolean {
  return attributesOf(node).some((item) => /^#\[\s*proc_macro(_attribute|_derive)?\b/.test(item.text.trim()));
}

function pathAttribute(node: Node): string | undefined {
  const value = attributeNamed(node, "path")?.childForFieldName("value");
  return value?.namedChildren.find((child) => child.type === "string_content")?.text;
}

const upper = /^[A-Z]/;

export function pathSegments(node: Node | null, out: string[]): boolean {
  if (node === null) return false;
  switch (node.type) {
    case "identifier":
    case "type_identifier":
    case "crate":
    case "self":
    case "super":
    case "metavariable":
      out.push(node.text);
      return true;
    case "scoped_identifier":
    case "scoped_type_identifier":
      return pathSegments(node.childForFieldName("path"), out) && pathSegments(node.childForFieldName("name"), out);
    case "generic_type":
      return pathSegments(node.childForFieldName("type"), out);
    case "bracketed_type":
      return false;
    default:
      return false;
  }
}

export interface Leaf {
  segments: string[];
  alias: string | undefined;
  glob: boolean;
  line: number;
}

/** The imported paths of a `use` argument, each from the root, with lists unfolded. */
export function leavesOf(node: Node | null, prefix: string[], out: Leaf[]): void {
  if (node === null) return;
  const line = node.startPosition.row + 1;
  switch (node.type) {
    case "identifier":
    case "scoped_identifier":
    case "crate":
    case "self":
    case "super": {
      const own: string[] = [];
      if (!pathSegments(node, own)) return;
      // A `self` inside a list names the module the list is under.
      out.push({ segments: node.type === "self" ? prefix : [...prefix, ...own], alias: undefined, glob: false, line });
      return;
    }
    case "use_as_clause": {
      const own: string[] = [];
      if (!pathSegments(node.childForFieldName("path"), own)) return;
      const alias = node.childForFieldName("alias")?.text;
      const path = node.childForFieldName("path")!.type === "self" ? prefix : [...prefix, ...own];
      out.push({ segments: path, alias, glob: false, line });
      return;
    }
    case "use_wildcard": {
      const own: string[] = [];
      const path = node.namedChildren[0] ?? null;
      if (path !== null && !pathSegments(path, own)) return;
      out.push({ segments: [...prefix, ...own], alias: undefined, glob: true, line });
      return;
    }
    case "scoped_use_list": {
      const own: string[] = [];
      const path = node.childForFieldName("path");
      if (path !== null && !pathSegments(path, own)) return;
      leavesOf(node.childForFieldName("list"), [...prefix, ...own], out);
      return;
    }
    case "use_list":
      for (const child of node.namedChildren) leavesOf(child, prefix, out);
      return;
    default:
  }
}

/** Counts `self` and `super` from the file's own module, unwinding the inline modules the use sits in. */
function normalise(segments: readonly string[], context: Context): string[] | undefined {
  const [first, ...rest] = segments;
  if (first === undefined) return undefined;
  if (first === "crate") return [...segments];
  if (first === "self") return ["self", ...context.mods, ...rest];
  if (first === "super") {
    const mods = [...context.mods];
    let up = 0;
    let remainder: string[] = [...segments];
    while (remainder[0] === "super") {
      if (mods.length > 0) mods.pop();
      else up++;
      remainder = remainder.slice(1);
    }
    return up === 0 ? ["self", ...mods, ...remainder] : [...Array<string>(up).fill("super"), ...remainder];
  }
  if (context.localMods.has(first)) return ["self", ...context.mods, ...segments];
  // A capital is a type already in scope (`use Shape::*` after importing Shape), not a crate.
  if (upper.test(first)) return undefined;
  return [...segments];
}

/** True for a path that names the file's own module or one of its inline modules, such as `use super::*` inside `mod tests`. */
function isOwnModule(segments: readonly string[], inlineModules: ReadonlySet<string>): boolean {
  return segments[0] === "self" && (segments.length === 1 || inlineModules.has(segments.slice(1).join("::")));
}

/** The paths of every inline module of the file, from the file's own module: `tests`, `tests::nested`. */
function inlineModulesOf(scope: Node, prefix: readonly string[], out: Set<string>): void {
  for (const child of scope.namedChildren) {
    if (child.type !== "mod_item") continue;
    const body = child.childForFieldName("body");
    const name = child.childForFieldName("name")?.text;
    if (body === null || name === undefined) continue;
    out.add([...prefix, name].join("::"));
    inlineModulesOf(body, [...prefix, name], out);
  }
}

const primitives = new Set(["bool", "char", "str", "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize", "f32", "f64"]);
const builtinCrates = new Set(["std", "core", "alloc", "proc_macro", "test"]);

/** A path written out in code whose first name may be a crate, kept until the file's own names are known. */
interface InlinePath {
  segments: string[];
  line: number;
  kind: "call" | "reference";
  unit: string | undefined;
}

const compareLines = (a: { line: number }, b: { line: number }): number => a.line - b.line;

class Extractor {
  readonly units: UnitFact[] = [];
  readonly imports: ImportFact[] = [];
  readonly reexports: ReexportFact[] = [];
  readonly exports: ExportFact[] = [];
  private readonly innerExports: ExportFact[] = [];
  private readonly references: ReferenceFact[] = [];
  private readonly nameCounts = new Map<string, number>();
  private readonly inlineModules = new Set<string>();
  private readonly inlinePaths: InlinePath[] = [];
  private codeRows: boolean[] | undefined;
  private root: Node | undefined;
  private readonly explain: boolean;

  constructor(explain: boolean) {
    this.explain = explain;
  }

  extract(root: Node): FileFacts {
    this.root = root;
    inlineModulesOf(root, [], this.inlineModules);
    this.visitScope(root, { unit: undefined, mods: [], owner: undefined, exposed: true, localMods: new Set() });
    const names = new Set(this.exports.map((exported) => exported.exported));
    for (const inner of this.innerExports) {
      if (names.has(inner.exported)) continue;
      names.add(inner.exported);
      this.exports.push(inner);
    }
    const locals = new Set<string>();
    for (const imported of this.imports) for (const binding of imported.bindings) locals.add(binding.local);
    this.inlineCrates(root, locals);
    for (const imported of this.imports) for (const binding of imported.bindings) locals.add(binding.local);
    const classes = new Set(this.units.filter((unit) => unit.kind === "class").map((unit) => unit.qualifiedName));
    for (const unit of this.units) {
      const dot = unit.qualifiedName.lastIndexOf(".");
      if (unit.kind === "method" && unit.parent === undefined && dot > 0 && classes.has(unit.qualifiedName.slice(0, dot))) unit.parent = unit.qualifiedName.slice(0, dot);
    }
    return {
      units: this.units,
      imports: this.imports,
      reexports: this.reexports,
      exports: this.exports,
      references: this.references.filter((reference) => locals.has(reference.local)),
      nodes: nodeCount(root, (node) => isComment(node) || node.type === "use_declaration") - 1,
      hasSyntaxErrors: root.hasError,
    };
  }

  /**
   * A path in code that starts with a name the file does not declare or import, such as `serde_json::to_string(x)`
   * or `log::info!(..)`, names a crate. It is imported like a `use` of the same path, under the path as its binding.
   */
  private inlineCrates(root: Node, locals: ReadonlySet<string>): void {
    const modules = new Set(root.descendantsOfType("mod_item").map((item) => item.childForFieldName("name")?.text));
    const known = new Set<string>();
    for (const path of this.inlinePaths) {
      const [first] = path.segments as [string];
      if (locals.has(first) || modules.has(first) || primitives.has(first) || builtinCrates.has(first)) continue;
      let item = path.segments.findIndex((segment, index) => index > 0 && upper.test(segment));
      if (item < 0) item = path.segments.length - 1;
      const local = path.segments.slice(0, item + 1).join("::");
      if (!known.has(local)) {
        known.add(local);
        this.imports.push({ specifier: path.segments.slice(0, item).join("::"), kind: "import", typeOnly: false, line: path.line, bindings: [{ imported: path.segments[item]!, local, typeOnly: false }] });
      }
      const member = path.segments[item + 1];
      const fact: ReferenceFact = { local, kind: path.kind, line: path.line };
      if (member !== undefined) fact.member = member;
      if (path.unit !== undefined) fact.inUnit = path.unit;
      this.references.push(fact);
    }
  }

  private inlinePath(segments: string[], line: number, kind: "call" | "reference", context: Context): void {
    if (segments.length >= 2 && /^[a-z_]/.test(segments[0]!)) this.inlinePaths.push({ segments, line, kind, unit: context.unit });
  }

  /** The modules a scope declares, so a path that starts with one is relative to the scope. */
  private declaredMods(scope: Node): Set<string> {
    const names = new Set<string>();
    for (const child of scope.namedChildren) {
      if (child.type === "mod_item") {
        const name = child.childForFieldName("name")?.text;
        if (name !== undefined) names.add(name);
      }
    }
    return names;
  }

  private visitScope(scope: Node, context: Context): void {
    const inner: Context = { ...context, localMods: this.declaredMods(scope) };
    for (const child of scope.namedChildren) this.visit(child, inner);
  }

  private visitChildren(node: Node, context: Context): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child === null || !child.isNamed) continue;
      // The name a declaration introduces is not a use of anything.
      if (node.fieldNameForChild(i) === "name" && !node.type.startsWith("scoped_")) continue;
      this.visit(child, context);
    }
  }

  private prefix(context: Context): string {
    return context.unit ?? context.mods.join(".");
  }

  private declareUnit(name: string, kind: UnitKind, node: Node, context: Context, fn?: Node, memberOf?: string): string {
    const head = this.prefix(context);
    const base = [head, memberOf, name].filter((part) => part !== undefined && part !== "").join(".");
    const seen = this.nameCounts.get(base) ?? 0;
    this.nameCounts.set(base, seen + 1);
    const qualifiedName = seen === 0 ? base : `${base}~${seen + 1}`;
    const unit: UnitFact = { qualifiedName, kind, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, source: "structural" };
    if (context.unit !== undefined) unit.parent = context.unit;
    if (context.inTests === true || isTestItem(node)) unit.test = true;
    if (fn === undefined) unit.shape = typeShape(node);
    else {
      this.codeRows ??= codeRowsOf(this.root!, rustMetricRules);
      const measured = measureFunction(fn, { name, startLine: unit.startLine, endLine: unit.endLine, codeRows: this.codeRows, explain: this.explain }, rustMetricRules);
      unit.metrics = measured.metrics;
      unit.shape = functionShape(fn, measured.metrics.parameters);
      const forwarded = passThroughOf(fn, new Set(parameterNames(fn)));
      if (forwarded !== undefined) unit.passThrough = forwarded;
      if (measured.recursive) unit.recursive = true;
      if (memberOf !== undefined && context.implementsTrait === true) unit.override = true;
      if (memberOf === undefined && isProcMacro(node)) unit.entryPoint = true;
      if (memberOf !== undefined && context.implementsTrait !== true && visibilityOf(node) !== "public") unit.hidden = true;
      if (measured.increments !== undefined) unit.increments = measured.increments;
    }
    this.units.push(unit);
    return qualifiedName;
  }

  private export(node: Node, name: string, local: string | undefined, kind: ExportFact["kind"], visibility: Visibility, context: Context): void {
    // Members of a type or trait are reached through it, and nested items through their function.
    if (context.owner !== undefined || context.unit !== undefined) return;
    const exposed = visibility === "public" && context.exposed;
    const fact: ExportFact = { exported: name, line: node.startPosition.row + 1 };
    if (local !== undefined) fact.local = local;
    if (kind !== undefined) fact.kind = kind;
    if (!exposed) fact.internal = true;
    (context.mods.length === 0 ? this.exports : this.innerExports).push(fact);
  }

  private visit(node: Node, context: Context): void {
    switch (node.type) {
      case "use_declaration":
        this.useDeclaration(node, context);
        return;
      case "mod_item":
        this.modItem(node, context);
        return;
      case "function_item": {
        const name = node.childForFieldName("name")?.text;
        if (name === undefined) return;
        const member = context.owner;
        const kind: UnitKind = member === undefined ? "function" : "method";
        const qualified = this.declareUnit(name, kind, node, context, node, member);
        this.export(node, name, qualified, "function", visibilityOf(node), context);
        this.functionParts(node, { ...context, unit: qualified, owner: undefined });
        return;
      }
      case "struct_item":
      case "union_item":
      case "enum_item":
      case "trait_item": {
        const name = node.childForFieldName("name")?.text;
        if (name === undefined) return;
        const qualified = this.declareUnit(name, "class", node, context);
        const kind = node.type === "trait_item" ? "interface" : node.type === "enum_item" ? "enum" : "class";
        this.export(node, name, qualified, kind, visibilityOf(node), context);
        if (node.type === "trait_item") {
          const body = node.childForFieldName("body");
          this.visitChildrenExcept(node, body, { ...context, unit: undefined, owner: undefined });
          if (body !== null) this.visitScope(body, { ...context, unit: undefined, owner: name });
        } else this.visitChildren(node, { ...context, owner: undefined });
        return;
      }
      case "impl_item": {
        const owner = typeName(node.childForFieldName("type")) ?? node.childForFieldName("type")?.text.replace(/\s+/g, " ") ?? "_";
        const body = node.childForFieldName("body");
        this.visitChildrenExcept(node, body, { ...context, owner: undefined });
        if (body !== null) this.visitScope(body, { ...context, owner, implementsTrait: node.childForFieldName("trait") !== null, ...(isTestItem(node) ? { inTests: true } : {}) });
        return;
      }
      case "type_item":
      case "const_item":
      case "static_item": {
        const name = node.childForFieldName("name")?.text;
        if (name !== undefined) this.export(node, name, undefined, node.type === "type_item" ? "type" : "variable", visibilityOf(node), context);
        this.visitChildren(node, context);
        return;
      }
      case "macro_definition": {
        const name = node.childForFieldName("name")?.text;
        if (name !== undefined) this.export(node, name, undefined, undefined, attributeNamed(node, "macro_export") === undefined ? "private" : "public", context);
        return;
      }
      case "let_declaration":
        this.letDeclaration(node, context);
        return;
      case "attribute_item":
      case "inner_attribute_item":
        this.attribute(node, context);
        return;
      case "label":
        return;
      case "call_expression":
        this.call(node, context);
        return;
      case "macro_invocation":
        this.macro(node, context);
        return;
      case "scoped_identifier":
      case "scoped_type_identifier":
        this.path(node, context, "reference");
        return;
      case "identifier":
      case "type_identifier":
        this.reference(node.text, node, context, "reference");
        return;
      case "field_expression": {
        const value = node.childForFieldName("value");
        if (value !== null) this.visit(value, context);
        return;
      }
      case "parameter":
      case "closure_parameters":
      case "let_condition":
        this.bindings(node, context);
        return;
      case "for_expression": {
        const pattern = node.childForFieldName("pattern");
        if (pattern !== null) this.patternReferences(pattern, context);
        for (const child of node.namedChildren) if (child.id !== pattern?.id) this.visit(child, context);
        return;
      }
      case "match_pattern": {
        const guard = node.childForFieldName("condition");
        for (const child of node.namedChildren) {
          if (child.id === guard?.id) this.visit(child, context);
          else this.patternReferences(child, context);
        }
        return;
      }
      case "lifetime":
        return;
      default:
        this.visitChildren(node, context);
    }
  }

  /** An attribute names a crate when its path has one (`#[tokio::main]`, `#[derive(thiserror::Error)]`). */
  private attribute(node: Node, context: Context): void {
    for (const attribute of node.namedChildren.filter((child) => child.type === "attribute")) {
      const name = attribute.namedChildren[0];
      if (name?.type === "scoped_identifier") this.path(name, context, "reference");
      const args = attribute.childForFieldName("arguments");
      if (args !== null) this.tokens(args, context);
    }
  }

  private visitChildrenExcept(node: Node, skip: Node | null, context: Context): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child === null || !child.isNamed || child.id === skip?.id) continue;
      if (node.fieldNameForChild(i) === "name") continue;
      this.visit(child, context);
    }
  }

  private functionParts(fn: Node, context: Context): void {
    this.visitChildren(fn, context);
  }

  private modItem(node: Node, context: Context): void {
    const name = node.childForFieldName("name")?.text;
    if (name === undefined) return;
    const visibility = visibilityOf(node);
    const body = node.childForFieldName("body");
    if (body !== null) {
      this.export(node, name, undefined, "namespace", visibility, context);
      this.visitScope(body, { ...context, mods: [...context.mods, name], exposed: context.exposed && visibility === "public", ...(isTestItem(node) ? { inTests: true } : {}) });
      return;
    }
    const written = pathAttribute(node);
    const specifier = `mod ${[...context.mods, name].join("::")}${written === undefined ? "" : `@${written}`}`;
    const line = node.startPosition.row + 1;
    this.imports.push({ specifier, kind: "import", typeOnly: false, line, bindings: [{ imported: "*", local: name, typeOnly: false }] });
    this.export(node, name, name, "namespace", visibility, context);
  }

  private useDeclaration(node: Node, context: Context): void {
    const visibility = visibilityOf(node);
    const leaves: Leaf[] = [];
    leavesOf(node.childForFieldName("argument"), [], leaves);
    for (const leaf of leaves) {
      const segments = normalise(leaf.segments, context);
      if (segments === undefined) continue;
      if (isOwnModule(segments, this.inlineModules)) continue;
      if (leaf.glob) {
        const specifier = segments.join("::");
        if (visibility === "public" && context.mods.length === 0) this.reexports.push({ specifier, typeOnly: false, line: leaf.line, imported: "*", exported: "*" });
        else this.imports.push({ specifier, kind: "import", typeOnly: false, line: leaf.line, bindings: [] });
        continue;
      }
      let item = segments.findIndex((segment, index) => index > 0 && upper.test(segment));
      if (item < 0) item = segments.length - 1;
      if (item < 1) continue;
      if (isOwnModule(segments.slice(0, item), this.inlineModules)) continue;
      const specifier = segments.slice(0, item).join("::");
      const imported = segments[item]!;
      const local = leaf.alias ?? segments.at(-1)!;
      const bindings = local === "_" ? [] : [{ imported, local, typeOnly: false }];
      this.imports.push({ specifier, kind: "import", typeOnly: false, line: leaf.line, bindings });
      if (visibility !== "private" && bindings.length > 0 && context.owner === undefined && context.unit === undefined) {
        const fact: ExportFact = { exported: local, local, line: leaf.line };
        if (visibility === "restricted" || !context.exposed) fact.internal = true;
        (context.mods.length === 0 ? this.exports : this.innerExports).push(fact);
      }
    }
  }

  private letDeclaration(node: Node, context: Context): void {
    const pattern = node.childForFieldName("pattern");
    const value = node.childForFieldName("value");
    if (value?.type === "closure_expression" && pattern?.type === "identifier") {
      const qualified = this.declareUnit(pattern.text, "arrow", node, context, value);
      this.visitChildren(value, { ...context, unit: qualified });
      const alternative = node.childForFieldName("alternative");
      if (alternative !== null) this.visit(alternative, context);
      return;
    }
    if (pattern !== null) this.patternReferences(pattern, context);
    for (const child of node.namedChildren) if (child.id !== pattern?.id) this.visit(child, context);
  }

  /** The type annotations and defaults of a parameter, and the paths in its pattern. Names it binds are not uses. */
  private bindings(node: Node, context: Context): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child === null || !child.isNamed) continue;
      const field = node.fieldNameForChild(i);
      if (field === "pattern" || node.type === "closure_parameters" || (node.type === "let_condition" && field === "pattern")) {
        if (child.type === "parameter") this.bindings(child, context);
        else this.patternReferences(child, context);
      } else this.visit(child, context);
    }
  }

  /** The names a pattern mentions that are not bindings: paths to variants and constants, and capitalised names. */
  private patternReferences(pattern: Node, context: Context): void {
    switch (pattern.type) {
      case "scoped_identifier":
      case "scoped_type_identifier":
        this.path(pattern, context, "reference");
        return;
      case "type_identifier":
        this.reference(pattern.text, pattern, context, "reference");
        return;
      case "identifier":
        if (upper.test(pattern.text)) this.reference(pattern.text, pattern, context, "reference");
        return;
      case "tuple_struct_pattern":
      case "struct_pattern": {
        const type = pattern.childForFieldName("type");
        if (type !== null) this.patternReferences(type, context);
        for (const child of pattern.namedChildren) if (child.id !== type?.id) this.patternReferences(child, context);
        return;
      }
      case "range_pattern":
      case "literal_pattern":
        return;
      default:
        for (const child of pattern.namedChildren) this.patternReferences(child, context);
    }
  }

  private reference(local: string, node: Node, context: Context, kind: "call" | "reference", member?: string): void {
    if (local === "Self" || local === "crate" || local === "self" || local === "super") return;
    const fact: ReferenceFact = { local, kind, line: node.startPosition.row + 1 };
    if (member !== undefined) fact.member = member;
    if (context.unit !== undefined) fact.inUnit = context.unit;
    this.references.push(fact);
  }

  /** A path used as a value or a type: its first name is the reference, the next one its member. */
  private path(node: Node, context: Context, kind: "call" | "reference"): void {
    const segments: string[] = [];
    if (!pathSegments(node, segments)) {
      this.visitChildren(node, context);
      return;
    }
    const [first, second] = segments as [string, string | undefined];
    if (first === "self" || first === "crate" || first === "super" || first === "Self") return;
    this.reference(first, node, context, kind, second);
    this.inlinePath(segments, node.startPosition.row + 1, kind, context);
    // Type arguments inside the path (`Vec::<Foo>::new`) are uses of their own.
    for (const generic of node.descendantsOfType("type_arguments")) this.visitChildren(generic, context);
  }

  private call(node: Node, context: Context): void {
    let callee = node.childForFieldName("function");
    const args = node.childForFieldName("arguments");
    if (callee?.type === "generic_function") {
      for (const generic of callee.namedChildren.filter((child) => child.type === "type_arguments")) this.visitChildren(generic, context);
      callee = callee.childForFieldName("function");
    }
    if (callee?.type === "identifier") this.reference(callee.text, callee, context, "call");
    else if (callee?.type === "scoped_identifier") this.path(callee, context, "call");
    else if (callee !== null && callee !== undefined) this.visit(callee, context);
    if (args !== null) this.visitChildren(args, context);
  }

  private macro(node: Node, context: Context): void {
    const name = node.childForFieldName("macro");
    if (name?.type === "identifier") this.reference(name.text, name, context, "call");
    else if (name?.type === "scoped_identifier") this.path(name, context, "call");
    for (const tree of node.namedChildren.filter((child) => child.type === "token_tree")) this.tokens(tree, context);
  }

  /** Macro arguments are not parsed, so names in them are read from the tokens: `a`, or `a::b`. */
  private tokens(tree: Node, context: Context): void {
    const children = tree.children;
    for (let i = 0; i < children.length; i++) {
      const token = children[i]!;
      if (token.type === "token_tree") this.tokens(token, context);
      else if (token.type === "identifier" || token.type === "type_identifier") {
        const segments = [token.text];
        let next = i + 1;
        while (children[next]?.type === "::" && children[next + 1]?.type === "identifier") {
          segments.push(children[next + 1]!.text);
          next += 2;
        }
        this.reference(token.text, token, context, "reference", segments[1]);
        this.inlinePath(segments, token.startPosition.row + 1, "reference", context);
        // The names after `::` are the path's, not uses of names of their own.
        i = next - 1;
      }
    }
  }
}

export function extractFacts(root: Node, options: { explain?: boolean } = {}): FileFacts {
  const facts = new Extractor(options.explain === true).extract(root);
  facts.exports.sort(compareLines);
  return facts;
}
