import type { Node } from "web-tree-sitter";
import type { ConstructMap, MetricRules, RecursionScope } from "../../metric-rules.ts";

/**
 * The C# mapping onto the metric engine. The definitions are in unit-metrics.ts, and these are the C#
 * constructs they apply to:
 *
 * - Decisions: `if` (an `else if` is an `if`), `for`, `foreach`, `while`, `do`, each `case` label, each arm of
 *   a switch expression except the catch-all, `catch`, the ternary, `&&`, `||`, `??` and `??=`.
 * - A switch expression costs like a `switch` statement: one flow-breaking structure, one cyclomatic increment
 *   per arm in the per-case mode and one for the whole expression in the modified mode. A `_` arm with no
 *   `when` guard is the default and counts for nothing, as `default:` does.
 * - Pattern combinators `and` and `or` are logical operators: each is a cyclomatic decision, and a run of
 *   like combinators costs one cognitive increment. `not` is negation and costs nothing.
 * - Free: `?.`, `!`, `is` on its own, `await`, `yield`, `goto`, `lock`, `using`, `finally`, relational
 *   patterns, preprocessor directives (both branches of an `#if` are parsed as written).
 * - Lambdas, anonymous methods and local functions are nested functions: their decisions add to the
 *   enclosing function, one level deeper. Accessors, constructors, destructors and operators are functions.
 */

const constructs: ConstructMap = {
  functionLike: new Set([
    "method_declaration",
    "constructor_declaration",
    "destructor_declaration",
    "operator_declaration",
    "conversion_operator_declaration",
    "accessor_declaration",
    "local_function_statement",
    "lambda_expression",
    "anonymous_method_expression",
  ]),
  loops: { for_statement: "for", foreach_statement: "foreach", while_statement: "while", do_statement: "do-while" },
  conditional: { type: "if_statement", condition: "condition", consequence: "consequence", alternative: "alternative", alternativeIsClause: false },
  // A section holds one case per `case` keyword, and none when it is only `default:`.
  switch: { type: "switch_statement", body: "body", caseType: "switch_section", caseCount: (section) => section.children.filter((child) => child.type === "case").length },
  switchExpression: { type: "switch_expression", arm: "switch_expression_arm", isDefaultArm },
  tryType: "try_statement",
  catchType: "catch_clause",
  ternary: { type: "conditional_expression", condition: "condition", consequence: "consequence", alternative: "alternative" },
  binary: { type: "binary_expression", operator: "operator", left: "left", right: "right", logical: new Set(["&&", "||"]), decisions: new Set(["??"]) },
  compoundAssignment: { type: "assignment_expression", operator: "operator", decisions: new Set(["??="]) },
  parenthesized: "parenthesized_expression",
  parenthesizedAlso: new Set(["parenthesized_pattern"]),
  patternCombinators: { and_pattern: "and", or_pattern: "or" },
  labelledJumps: {},
  label: "label",
  commentTypes: new Set(["comment"]),
};

/** An arm of `_ => x` or `var _ => x`, with no guard: it matches whatever the others did not. */
function isDefaultArm(arm: Node): boolean {
  if (arm.namedChildren.some((child) => child.type === "when_clause")) return false;
  const pattern = arm.namedChildren[0];
  return pattern !== undefined && (pattern.type === "discard" || pattern.text.replace(/\s+/g, " ") === "var _");
}

const notStatements = new Set(["empty_statement", "labeled_statement"]);

/** A statement node. Blocks, switch sections and clauses are not statements of their own. */
function isStatement(node: Node): boolean {
  return node.type.endsWith("_statement") && !notStatements.has(node.type) && node.type !== "global_statement";
}

/** The body of a function, or of an expression-bodied property or indexer, which keeps it in `value`. */
export function bodyOf(fn: Node): Node | null {
  return fn.childForFieldName("body") ?? fn.childForFieldName("value");
}

export interface ParameterInfo {
  name: string;
  hasDefault: boolean;
  isParams: boolean;
}

/**
 * The declared parameters of a function, and of the indexer an accessor belongs to. The grammar writes a `params` array inline in the list, without a
 * `parameter` node around it, and a lambda with one bare parameter has an `implicit_parameter` and no list.
 */
export function parameterInfo(fn: Node): ParameterInfo[] {
  // The accessors of an indexer take the indexer's parameters.
  const owner = fn.type === "accessor_declaration" && fn.parent?.parent?.type === "indexer_declaration" ? fn.parent.parent : fn;
  const list = owner.childForFieldName("parameters");
  if (list === null) return [];
  if (list.type === "implicit_parameter") return [{ name: list.text, hasDefault: false, isParams: false }];
  const out: ParameterInfo[] = [];
  for (let i = 0; i < list.childCount; i++) {
    const child = list.child(i);
    if (child === null) continue;
    if (child.type === "parameter" || child.type === "implicit_parameter") {
      out.push({ name: child.type === "parameter" ? (child.childForFieldName("name")?.text ?? "") : child.text, hasDefault: child.children.some((part) => part.type === "="), isParams: false });
    } else if (list.fieldNameForChild(i) === "name") out.push({ name: child.text, hasDefault: false, isParams: true });
  }
  return out;
}

export function parameterCounts(fn: Node): { parameters: number; optionCount: number } {
  return { parameters: parameterInfo(fn).length, optionCount: 0 };
}

/** What a recursion check needs beyond names: how many arguments a call to this very overload may pass. */
interface Overload extends RecursionScope {
  arity: { min: number; max: number };
}

function enclosingTypeName(fn: Node): string | undefined {
  for (let parent = fn.parent; parent !== null; parent = parent.parent) {
    if (/^(class|struct|interface|record|record_struct)_declaration$/.test(parent.type)) return parent.childForFieldName("name")?.text;
  }
  return undefined;
}

/**
 * Direct recursion is a call of the function's own name that could be a call of this overload: C# lets one
 * name stand for several methods, so a call passing a number of arguments the parameters cannot take is another
 * overload. A local function is called by its bare name, a method by its bare name, `this.name` or `Type.name`.
 */
function recursionScope(fn: Node, name: string | undefined): Overload {
  const parameters = parameterInfo(fn);
  const params = parameters.some((parameter) => parameter.isParams);
  const optional = parameters.filter((parameter) => parameter.hasDefault).length;
  const callable = fn.type === "method_declaration" || fn.type === "local_function_statement";
  const own = callable ? (fn.childForFieldName("name")?.text ?? name) : undefined;
  const names = new Set(own === undefined ? [] : [own]);
  const owner = fn.type === "method_declaration" ? enclosingTypeName(fn) : undefined;
  return {
    bare: names,
    member: names,
    ...(owner === undefined ? {} : { owner }),
    arity: { min: params ? 0 : parameters.length - optional, max: params ? Number.POSITIVE_INFINITY : parameters.length },
  };
}

/** The name a call is made through: `Name(...)`, `this.Name(...)` or `Type.Name(...)`, with generic arguments set aside. */
function isRecursiveCall(call: Node, scope: RecursionScope): boolean {
  const { arity } = scope as Overload;
  const callee = call.childForFieldName("function");
  if (callee === null) return false;
  const args = call.childForFieldName("arguments")?.namedChildren.filter((child) => child.type === "argument").length ?? 0;
  if (args < arity.min || args > arity.max) return false;
  const simple = (node: Node | null): string | undefined => (node === null ? undefined : node.type === "generic_name" ? node.namedChildren[0]?.text : node.type === "identifier" ? node.text : undefined);
  if (callee.type === "identifier" || callee.type === "generic_name") {
    const name = simple(callee);
    return name !== undefined && scope.bare.has(name);
  }
  if (callee.type === "member_access_expression") {
    const name = simple(callee.childForFieldName("name"));
    if (name === undefined || !scope.member.has(name)) return false;
    const target = callee.childForFieldName("expression");
    if (target === null) return callee.children[0]?.type === "this";
    return scope.owner !== undefined && target.type === "identifier" && target.text === scope.owner;
  }
  return false;
}

export const csharpMetricRules: MetricRules = {
  constructs,
  isStatement,
  hasExpressionBody(fn) {
    const body = bodyOf(fn);
    return body !== null && body.type !== "block";
  },
  recursionScope,
  isRecursiveCall,
  callType: "invocation_expression",
  parameterCounts,
};
