import type { Node } from "web-tree-sitter";
import { codeRowsOf, measureFunction } from "../../unit-metrics.ts";
import type { BindingFact, DeclarationKind, ExportFact, FileFacts, ImportFact, ReexportFact, ReferenceFact, UnitFact, UnitKind } from "../../facts.ts";
import { boundParameterNames, classShape, functionShape, nodeCount, passThroughOf } from "./interface-shape.ts";
import { enclosingClass, pythonMetricRules } from "./metric-rules.ts";

/** Bump when the extraction rules change in a way that alters facts for the same source, so cached facts from older rules are not reused. */
export const extractorVersion = 4;

interface Context {
  /** Qualified name of the innermost enclosing unit; names of nested units are built from it. */
  unit: string | undefined;
  /** Names bound in the enclosing function scopes, which hide imports of the same name. */
  shadow: ReadonlySet<string>;
}

const importTypes = new Set(["import_statement", "import_from_statement", "future_import_statement"]);
const targetTypes = new Set(["pattern_list", "tuple_pattern", "list_pattern", "list_splat_pattern", "tuple", "list"]);
const comprehensionTypes = new Set(["list_comprehension", "set_comprehension", "dictionary_comprehension", "generator_expression"]);
const enumBases = new Set(["Enum", "IntEnum", "StrEnum", "Flag", "IntFlag", "ReprEnum"]);

/** The last name of a base class or decorator expression: `abc.ABC` gives `ABC`, `Protocol[T]` gives `Protocol`, `deco(x)` gives `deco`. */
export function lastName(node: Node | null): string | undefined {
  if (node === null) return undefined;
  switch (node.type) {
    case "identifier":
      return node.text;
    case "attribute":
      return node.childForFieldName("attribute")?.text;
    case "subscript":
      return lastName(node.childForFieldName("value"));
    case "call":
      return lastName(node.childForFieldName("function"));
    default:
      return undefined;
  }
}

/** The declaration kind of a class from the bases it names: `Protocol` is an interface, `ABC` or `ABCMeta` an abstract class. */
export function classKind(declaration: Node): DeclarationKind {
  const bases = declaration.childForFieldName("superclasses")?.namedChildren ?? [];
  const named = bases.map((base) => (base.type === "keyword_argument" ? `${base.childForFieldName("name")?.text}=${lastName(base.childForFieldName("value"))}` : lastName(base)));
  if (named.includes("Protocol")) return "interface";
  if (named.includes("ABC") || named.includes("metaclass=ABCMeta")) return "abstract-class";
  if (named.some((name) => name !== undefined && enumBases.has(name))) return "enum";
  return "class";
}

/** `if TYPE_CHECKING:`, written bare or as `typing.TYPE_CHECKING`. */
function isTypeChecking(statement: Node): boolean {
  const condition = statement.childForFieldName("condition")?.text;
  return condition === "TYPE_CHECKING" || condition === "typing.TYPE_CHECKING" || condition === "t.TYPE_CHECKING";
}

function insideTypeChecking(node: Node): boolean {
  for (let child = node, parent = node.parent; parent !== null; child = parent, parent = parent.parent) {
    if (parent.type === "if_statement" && isTypeChecking(parent) && parent.childForFieldName("consequence")?.id === child.id) return true;
  }
  return false;
}

/** The string a string-literal node holds, or null when it is not a plain literal (an f-string with holes, a concatenation). */
function stringValue(node: Node | null): string | null {
  if (node === null || node.type !== "string") return null;
  if (node.namedChildren.some((child) => child.type === "interpolation")) return null;
  if (/^[a-zA-Z]*[fF]/.test(node.child(0)?.text ?? "")) return null;
  return node.namedChildren.filter((child) => child.type === "string_content").map((child) => child.text).join("");
}

/** Names bound by an assignment target, ignoring attribute and subscript targets, which bind nothing. */
function targetNames(node: Node | null, out: string[]): void {
  if (node === null) return;
  if (node.type === "identifier") out.push(node.text);
  else if (targetTypes.has(node.type)) for (const child of node.namedChildren) targetNames(child, out);
}

/** Names bound anywhere in a scope's own statements: assignments, loop and `with` targets, `except ... as`, walrus, imports and nested definitions. Nested scopes are not entered. */
function boundNames(scope: Node, out: Set<string>): void {
  const globals = new Set<string>();
  const walk = (node: Node): void => {
    for (const child of node.namedChildren) {
      switch (child.type) {
        case "function_definition":
        case "class_definition": {
          const name = child.childForFieldName("name")?.text;
          if (name !== undefined) out.add(name);
          continue;
        }
        case "lambda":
          continue;
        case "assignment":
        case "augmented_assignment": {
          const names: string[] = [];
          targetNames(child.childForFieldName("left"), names);
          for (const name of names) out.add(name);
          break;
        }
        case "for_statement":
        case "for_in_clause": {
          const names: string[] = [];
          targetNames(child.childForFieldName("left"), names);
          if (child.type === "for_statement") for (const name of names) out.add(name);
          break;
        }
        case "as_pattern_target":
          for (const identifier of child.namedChildren) if (identifier.type === "identifier") out.add(identifier.text);
          break;
        case "named_expression": {
          const name = child.childForFieldName("name")?.text;
          if (name !== undefined) out.add(name);
          break;
        }
        case "global_statement":
        case "nonlocal_statement":
          for (const identifier of child.namedChildren) globals.add(identifier.text);
          break;
        case "import_statement":
        case "import_from_statement":
          for (const binding of importBindings(child)) out.add(binding.local.split(".")[0]!);
          continue;
        default:
      }
      if (!comprehensionTypes.has(child.type)) walk(child);
    }
  };
  walk(scope);
  for (const name of globals) out.delete(name);
}

/** The names a comprehension binds in its own scope. */
function comprehensionNames(node: Node): string[] {
  const names: string[] = [];
  for (const clause of node.namedChildren) if (clause.type === "for_in_clause") targetNames(clause.childForFieldName("left"), names);
  return names;
}

interface ImportedModule {
  specifier: string;
  bindings: BindingFact[];
}

/** What an import statement binds, one entry per module it imports. A star import has no bindings. */
function importedModules(node: Node): ImportedModule[] {
  if (node.type === "import_statement") {
    const modules: ImportedModule[] = [];
    for (const name of node.childrenForFieldName("name")) {
      const dotted = name.type === "aliased_import" ? name.childForFieldName("name") : name;
      if (dotted === null) continue;
      const alias = name.type === "aliased_import" ? name.childForFieldName("alias") : null;
      modules.push({ specifier: dotted.text, bindings: [{ imported: "*", local: alias?.text ?? dotted.text, typeOnly: false }] });
    }
    return modules;
  }
  const specifier = node.childForFieldName("module_name")?.text;
  if (specifier === undefined) return [];
  const bindings: BindingFact[] = [];
  for (const name of node.childrenForFieldName("name")) {
    const imported = name.type === "aliased_import" ? name.childForFieldName("name") : name;
    const alias = name.type === "aliased_import" ? name.childForFieldName("alias") : null;
    if (imported !== null) bindings.push({ imported: imported.text, local: alias?.text ?? imported.text, typeOnly: false });
  }
  return [{ specifier, bindings }];
}

function importBindings(node: Node): BindingFact[] {
  return importedModules(node).flatMap((module) => module.bindings);
}

/** Start row of a definition, ignoring the decorators that precede its keyword. */
const startRow = (node: Node): number => node.startPosition.row;

class Extractor {
  readonly units: UnitFact[] = [];
  readonly imports: ImportFact[] = [];
  readonly reexports: ReexportFact[] = [];
  readonly exports: ExportFact[] = [];
  readonly references: ReferenceFact[] = [];
  private readonly nameCounts = new Map<string, number>();
  /** Locals of `import a.b.c` that bind `a` and are used as `a.b.c.name`: the whole dotted name. */
  private readonly dotted: string[] = [];
  private codeRows: boolean[] | undefined;
  private root: Node | undefined;
  private readonly explain: boolean;

  constructor(explain: boolean) {
    this.explain = explain;
  }

  extract(root: Node): FileFacts {
    this.root = root;
    this.collectImports(root);
    this.collectExports(root);
    this.visitChildren(root, { unit: undefined, shadow: new Set() });
    const locals = new Set<string>();
    for (const imported of this.imports) for (const binding of imported.bindings) locals.add(binding.local);
    return {
      units: this.units,
      imports: this.imports,
      reexports: this.reexports,
      exports: this.exports,
      references: this.references.filter((reference) => locals.has(reference.local)),
      nodes: nodeCount(root, (node) => importTypes.has(node.type)) - 1,
      hasSyntaxErrors: root.hasError,
    };
  }

  // ---- imports ----

  private collectImports(root: Node): void {
    const walk = (node: Node): void => {
      for (const child of node.namedChildren) {
        if (importTypes.has(child.type)) {
          this.importStatement(child);
          continue;
        }
        if (child.type === "call") this.dynamicImport(child);
        walk(child);
      }
    };
    walk(root);
  }

  private importStatement(node: Node): void {
    const line = node.startPosition.row + 1;
    const typeOnly = insideTypeChecking(node);
    if (node.type === "future_import_statement") {
      this.imports.push({ specifier: "__future__", kind: "import", typeOnly: false, line, bindings: [] });
      return;
    }
    const isStar = node.namedChildren.some((child) => child.type === "wildcard_import");
    for (const module of importedModules(node)) {
      const bindings = module.bindings.map((binding) => ({ ...binding, typeOnly }));
      for (const binding of bindings) if (binding.local.includes(".")) this.dotted.push(binding.local);
      this.imports.push({ specifier: module.specifier, kind: "import", typeOnly, line, bindings });
      if (isStar) this.reexports.push({ specifier: module.specifier, typeOnly, line, imported: "*", exported: "*" });
    }
  }

  /** `importlib.import_module("x")` and `__import__("x")`: the specifier when it is a plain string, otherwise null. */
  private dynamicImport(call: Node): void {
    const callee = call.childForFieldName("function");
    const name = callee?.type === "identifier" ? callee.text : callee?.type === "attribute" ? callee.text : undefined;
    if (name !== "__import__" && name !== "importlib.import_module" && name !== "import_module") return;
    const first = call.childForFieldName("arguments")?.namedChildren[0] ?? null;
    this.imports.push({ specifier: stringValue(first), kind: "dynamic", typeOnly: false, line: call.startPosition.row + 1, bindings: [] });
  }

  // ---- exports ----

  /** Every name a module defines or imports at its top level, including inside `if` and `try`: what `from module import name` can reach. */
  private collectExports(root: Node): void {
    const seen = new Set<string>();
    const add = (exported: string, line: number, kind?: DeclarationKind, implicit = false): void => {
      if (seen.has(exported) || exported === "__all__") return;
      seen.add(exported);
      this.exports.push({ exported, local: exported, line, ...(kind === undefined ? {} : { kind }), ...(implicit ? { implicit: true } : {}) });
    };
    const walk = (node: Node): void => {
      for (const statement of node.namedChildren) {
        const line = statement.startPosition.row + 1;
        const definition = statement.type === "decorated_definition" ? statement.childForFieldName("definition") : statement;
        switch (definition?.type) {
          case "function_definition":
            add(definition.childForFieldName("name")?.text ?? "", line, "function");
            break;
          case "class_definition":
            add(definition.childForFieldName("name")?.text ?? "", line, classKind(definition));
            break;
          case "expression_statement": {
            const assignment = definition.namedChildren[0];
            if (assignment?.type !== "assignment") break;
            const names: string[] = [];
            targetNames(assignment.childForFieldName("left"), names);
            for (const name of names) add(name, line, "variable");
            break;
          }
          case "type_alias_statement": {
            const name = definition.childForFieldName("left")?.namedChildren[0]?.text;
            if (name !== undefined) add(name, line, "type");
            break;
          }
          case "import_statement":
          case "import_from_statement":
            for (const binding of importBindings(definition)) if (!binding.local.includes(".")) add(binding.local, line, undefined, true);
            break;
          case "if_statement":
          case "try_statement":
          case "with_statement":
            for (const block of definition.namedChildren) {
              if (block.type === "block") walk(block);
              else if (block.type.endsWith("_clause")) for (const inner of block.namedChildren) if (inner.type === "block") walk(inner);
            }
            break;
          default:
        }
      }
    };
    walk(root);
  }

  // ---- traversal ----

  private visitChildren(node: Node, context: Context): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null && child.isNamed) this.visit(child, context, node, node.fieldNameForChild(i));
    }
  }

  private visit(node: Node, context: Context, parent: Node, field: string | null): void {
    switch (node.type) {
      case "import_statement":
      case "import_from_statement":
      case "future_import_statement":
      case "wildcard_import":
      case "global_statement":
      case "nonlocal_statement":
      case "case_pattern":
      case "as_pattern_target":
        return;
      case "decorated_definition": {
        for (const child of node.namedChildren) {
          if (child.type === "decorator") this.decorator(child, context);
          else this.visit(child, context, node, null);
        }
        return;
      }
      case "function_definition":
        this.functionDefinition(node, context);
        return;
      case "class_definition":
        this.classDefinition(node, context);
        return;
      case "lambda":
        this.functionBody(node, context);
        return;
      case "assignment":
        this.assignment(node, context, parent);
        return;
      case "augmented_assignment":
        this.target(node.childForFieldName("left"), context);
        this.visitOptional(node.childForFieldName("right"), context, node, "right");
        return;
      case "for_statement":
        this.target(node.childForFieldName("left"), context);
        for (const child of node.namedChildren) if (child.id !== node.childForFieldName("left")?.id) this.visit(child, context, node, null);
        return;
      case "named_expression":
        this.visitOptional(node.childForFieldName("value"), context, node, "value");
        return;
      case "keyword_argument":
        this.visitOptional(node.childForFieldName("value"), context, node, "value");
        return;
      case "as_pattern":
        // `x as name` binds name, and x is a use.
        for (const child of node.namedChildren) if (child.type !== "as_pattern_target") this.visit(child, context, node, null);
        return;
      case "call":
        this.call(node, context);
        return;
      case "attribute":
        this.member(node, context, "reference");
        return;
      case "identifier":
        if (this.isUse(node, parent, field)) this.reference(node, context, "reference");
        return;
      case "list_comprehension":
      case "set_comprehension":
      case "dictionary_comprehension":
      case "generator_expression": {
        const names = comprehensionNames(node);
        this.visitChildren(node, names.length === 0 ? context : { unit: context.unit, shadow: new Set([...context.shadow, ...names]) });
        return;
      }
      case "for_in_clause":
        // The target binds in the comprehension's scope, which the enclosing comprehension already shadowed.
        this.visitOptional(node.childForFieldName("right"), context, node, "right");
        return;
      default:
        this.visitChildren(node, context);
    }
  }

  private visitOptional(node: Node | null, context: Context, parent: Node, field: string): void {
    if (node !== null) this.visit(node, context, parent, field);
  }

  /** Whether an identifier is a use: not a name being declared or a parameter. Identifiers in parameters and targets are reached through their own handlers. */
  private isUse(node: Node, parent: Node, field: string | null): boolean {
    switch (parent.type) {
      case "function_definition":
      case "class_definition":
        return field !== "name";
      case "keyword_argument":
        return field !== "name";
      case "dotted_name":
      case "aliased_import":
      case "relative_import":
        return false;
      default:
        return true;
    }
  }

  private reference(node: Node, context: Context, kind: "call" | "reference", member?: string, local: string = node.text): void {
    if (context.shadow.has(node.text)) return;
    const fact: ReferenceFact = { local, kind, line: node.startPosition.row + 1 };
    if (member !== undefined) fact.member = member;
    if (context.unit !== undefined) fact.inUnit = context.unit;
    this.references.push(fact);
  }

  /** The chain of an attribute expression as written (`a.b.c` gives `[a, b, c]`), or undefined when it does not start at a name. */
  private chain(node: Node): { root: Node; names: string[] } | undefined {
    const names: string[] = [];
    let current: Node | null = node;
    while (current !== null && current.type === "attribute") {
      names.unshift(current.childForFieldName("attribute")?.text ?? "");
      current = current.childForFieldName("object");
    }
    return current?.type === "identifier" ? { root: current, names: [current.text, ...names] } : undefined;
  }

  /** `object.member` as a use of `object` remembering the member for namespace imports, or of a dotted import (`a.b.c.member`). */
  private member(node: Node, context: Context, kind: "call" | "reference"): void {
    const chain = this.chain(node);
    if (chain === undefined) {
      const object = node.childForFieldName("object");
      if (object !== null) this.visit(object, context, node, "object");
      return;
    }
    const written = chain.names;
    const dotted = this.dotted.filter((local) => local.split(".").every((part, index) => written[index] === part)).sort((a, b) => b.length - a.length)[0];
    const depth = dotted === undefined ? 1 : dotted.split(".").length;
    const member = written[depth];
    // A call counts when the callee is exactly the binding and one member: `ns.f()`. `ns.f.g()` uses `f`.
    this.reference(chain.root, context, kind === "call" && written.length === depth + 1 ? "call" : "reference", member, dotted ?? chain.root.text);
  }

  private call(node: Node, context: Context): void {
    const callee = node.childForFieldName("function");
    if (callee?.type === "identifier") this.reference(callee, context, "call");
    else if (callee?.type === "attribute") this.member(callee, context, "call");
    else if (callee !== null) this.visit(callee, context, node, "function");
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null && child.isNamed && node.fieldNameForChild(i) !== "function") this.visit(child, context, node, node.fieldNameForChild(i));
    }
  }

  /** A decorator is a reference, not a call, even when written `@decorate()`. */
  private decorator(node: Node, context: Context): void {
    const target = node.namedChildren[0];
    if (target === undefined) return;
    const callee = target.type === "call" ? target.childForFieldName("function") : target;
    if (callee?.type === "identifier") this.reference(callee, context, "reference");
    else if (callee?.type === "attribute") this.member(callee, context, "reference");
    if (target.type === "call") {
      const args = target.childForFieldName("arguments");
      if (args !== null) this.visit(args, context, target, "arguments");
    }
  }

  /** An assignment target: a name binds, an attribute or subscript uses what it starts from. */
  private target(node: Node | null, context: Context): void {
    if (node === null || node.type === "identifier") return;
    if (targetTypes.has(node.type)) {
      for (const child of node.namedChildren) this.target(child, context);
      return;
    }
    this.visit(node, context, node.parent!, "left");
  }

  private assignment(node: Node, context: Context, parent: Node): void {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    const annotation = node.childForFieldName("type");
    this.target(left, context);
    if (annotation !== null) this.visit(annotation, context, node, "type");
    if (right === null) return;
    // `name = lambda ...` is a unit named for what it is bound to.
    if (left?.type === "identifier" && right.type === "lambda" && parent.type === "expression_statement") {
      this.functionBody(right, this.declareUnit(left.text, "arrow", parent, context, right));
      return;
    }
    this.visit(right, context, node, "right");
  }

  private functionDefinition(node: Node, context: Context): void {
    const name = node.childForFieldName("name")?.text;
    const kind: UnitKind = enclosingClass(node) !== null ? "method" : "function";
    const inner = name === undefined ? context : this.declareUnit(name, kind, node, context, node);
    this.functionBody(node, inner);
  }

  private classDefinition(node: Node, context: Context): void {
    const name = node.childForFieldName("name")?.text;
    const inner = name === undefined ? context : this.declareUnit(name, "class", node, context);
    const superclasses = node.childForFieldName("superclasses");
    if (superclasses !== null) this.visit(superclasses, context, node, "superclasses");
    const body = node.childForFieldName("body");
    if (body === null) return;
    const names = new Set<string>();
    boundNames(body, names);
    // Class-level names hide imports for the class's own statements, not for the methods inside it, which see the enclosing scopes.
    const own: Context = { unit: inner.unit, shadow: new Set([...inner.shadow, ...names]) };
    for (const statement of body.namedChildren) {
      const definition = statement.type === "decorated_definition" ? statement.childForFieldName("definition") : statement;
      const scope = definition?.type === "function_definition" || definition?.type === "class_definition" ? inner : own;
      this.visit(statement, scope, body, null);
    }
  }

  /** Visits a function-like node's parameters and body with its own names in scope. */
  private functionBody(node: Node, context: Context): void {
    const names = new Set<string>(boundParameterNames(node));
    const body = node.childForFieldName("body");
    if (node.type === "function_definition" && body !== null) boundNames(body, names);
    const inner: Context = { unit: context.unit, shadow: new Set([...context.shadow, ...names]) };
    // Defaults and annotations are evaluated where the function is defined, but a parameter of the same name as an import is rare enough to read them in the function's scope.
    for (const child of node.namedChildren) if (child.id !== node.childForFieldName("name")?.id) this.visit(child, inner, node, null);
  }

  private declareUnit(name: string, kind: UnitKind, extent: Node, context: Context, fn?: Node): Context {
    const base = context.unit === undefined ? name : `${context.unit}.${name}`;
    const seen = this.nameCounts.get(base) ?? 0;
    this.nameCounts.set(base, seen + 1);
    const qualifiedName = seen === 0 ? base : `${base}~${seen + 1}`;
    const unit: UnitFact = {
      qualifiedName,
      kind,
      startLine: startRow(extent) + 1,
      endLine: extent.endPosition.row + 1,
      source: "structural",
    };
    if (context.unit !== undefined) unit.parent = context.unit;
    if (name.startsWith("_") && !(name.startsWith("__") && name.endsWith("__"))) unit.hidden = true;
    if (kind === "class") unit.shape = classShape(extent);
    if (fn !== undefined && kind !== "class") {
      this.codeRows ??= codeRowsOf(this.root!, pythonMetricRules);
      const measured = measureFunction(fn, { name, startLine: unit.startLine, endLine: unit.endLine, codeRows: this.codeRows, explain: this.explain }, pythonMetricRules);
      unit.metrics = measured.metrics;
      unit.shape = functionShape(fn, measured.metrics.parameters);
      const forwarded = passThroughOf(fn);
      if (forwarded !== undefined) unit.passThrough = forwarded;
      if (measured.recursive) unit.recursive = true;
      if (fn.parent?.type === "decorated_definition" && fn.parent.namedChildren.some((child) => child.type === "decorator" && /^@\s*(typing(_extensions)?\.)?override\b/.test(child.text))) unit.override = true;
      if (measured.increments !== undefined) unit.increments = measured.increments;
    }
    this.units.push(unit);
    return { unit: qualifiedName, shadow: context.shadow };
  }
}

/**
 * Extracts a file's units, imports, exports and references from its syntax tree. With `explain`, each
 * function unit also carries where its metric increments came from. Cached facts never have them.
 */
export function extractFacts(root: Node, options: { explain?: boolean } = {}): FileFacts {
  return new Extractor(options.explain === true).extract(root);
}

