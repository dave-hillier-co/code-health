import type { Node } from "web-tree-sitter";
import type { ConstructMap, MetricRules, RecursionScope } from "../../metric-rules.ts";

/**
 * The Go mapping onto the metric engine (docs/languages.md, Metric definitions per language). The definitions are in
 * unit-metrics.ts, and Go differs from them in what it has, not in how it counts:
 *
 * - `switch`, the type switch and `select` are switches, and each `case` (an expression, a type or a
 *   communication) is a decision. `default` is not.
 * - `if err != nil` is an ordinary `if`, and `else if` and `else` follow the usual rules.
 * - `for` covers every loop, ranges included. A labelled `break` or `continue`, and every `goto`, cost a flat 1.
 * - `defer` and `go` statements are not counted. A function literal is a nested function, so the code in a
 *   deferred or spawned closure is one level deeper, as for any callback.
 * - Go has no ternary, `try` or compound logical assignment, so those constructs are named by node types the
 *   grammar never produces.
 */

const never = "__none__";

const constructs: ConstructMap = {
  functionLike: new Set(["function_declaration", "method_declaration", "func_literal"]),
  loops: { for_statement: "for" },
  conditional: { type: "if_statement", condition: "condition", consequence: "consequence", alternative: "alternative", alternativeIsClause: false },
  switch: {
    type: "expression_switch_statement",
    body: "",
    caseType: "expression_case",
    moreTypes: new Set(["type_switch_statement", "select_statement"]),
    moreCaseTypes: new Set(["type_case", "communication_case"]),
    clauseTypes: new Set(["expression_case", "type_case", "communication_case", "default_case"]),
  },
  tryType: never,
  catchType: never,
  ternary: { type: never, condition: "condition", consequence: "consequence", alternative: "alternative" },
  binary: { type: "binary_expression", operator: "operator", left: "left", right: "right", logical: new Set(["&&", "||"]), decisions: new Set() },
  compoundAssignment: { type: never, operator: "operator", decisions: new Set() },
  parenthesized: "parenthesized_expression",
  labelledJumps: { break_statement: "break", continue_statement: "continue", goto_statement: "goto" },
  label: "label",
  labelType: "label_name",
  commentTypes: new Set(["comment"]),
};

/** Statements inside a function body. Declarations count as statements there, and blocks, clauses and labels do not. */
const statementTypes = new Set([
  "expression_statement",
  "short_var_declaration",
  "assignment_statement",
  "inc_statement",
  "dec_statement",
  "return_statement",
  "if_statement",
  "for_statement",
  "expression_switch_statement",
  "type_switch_statement",
  "select_statement",
  "go_statement",
  "defer_statement",
  "break_statement",
  "continue_statement",
  "goto_statement",
  "fallthrough_statement",
  "send_statement",
  "var_declaration",
  "const_declaration",
  "type_declaration",
]);

/** A statement node, except the ones that only initialise or advance a clause (`for i := 0; ...; i++`, `if x := f(); ...`, `case v := <-ch`). */
function isStatement(node: Node): boolean {
  if (!statementTypes.has(node.type)) return false;
  const parent = node.parent;
  if (parent === null) return true;
  if (parent.type === "for_clause" || parent.type === "communication_case") return false;
  return parent.childForFieldName("initializer")?.id !== node.id;
}

/** The identifier a method's receiver is bound to, which is how a method calls itself (`r.name()`). */
export function receiverNameOf(fn: Node): string | undefined {
  const receiver = fn.childForFieldName("receiver");
  const name = receiver?.namedChildren.find((child) => child.type === "parameter_declaration")?.childForFieldName("name")?.text;
  return name === undefined || name === "_" ? undefined : name;
}

function recursionScope(fn: Node, name: string | undefined): RecursionScope {
  if (fn.type === "method_declaration") {
    // A method's name is not in scope inside it: only `r.name()` through its receiver reaches it.
    const own = fn.childForFieldName("name")?.text;
    const owner = receiverNameOf(fn);
    return { bare: new Set(), member: new Set(own === undefined ? [] : [own]), ...(owner === undefined ? {} : { owner }) };
  }
  return { bare: new Set(name === undefined ? [] : [name]), member: new Set() };
}

function isRecursiveCall(call: Node, scope: RecursionScope): boolean {
  const callee = call.childForFieldName("function");
  if (callee === null) return false;
  if (callee.type === "selector_expression") {
    const operand = callee.childForFieldName("operand");
    const field = callee.childForFieldName("field")?.text ?? "";
    return scope.member.has(field) && scope.owner !== undefined && operand?.type === "identifier" && operand.text === scope.owner;
  }
  return callee.type === "identifier" && scope.bare.has(callee.text);
}

/** Declared parameters: each name of `a, b int` counts, an unnamed `int` counts once, and the receiver is not a parameter. */
export function parameterCounts(fn: Node): { parameters: number; optionCount: number } {
  let parameters = 0;
  for (const parameter of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    if (parameter.type !== "parameter_declaration" && parameter.type !== "variadic_parameter_declaration") continue;
    parameters += Math.max(1, parameter.childrenForFieldName("name").length);
  }
  return { parameters, optionCount: 0 };
}

export const goMetricRules: MetricRules = {
  constructs,
  isStatement,
  hasExpressionBody: () => false,
  recursionScope,
  isRecursiveCall,
  callType: "call_expression",
  parameterCounts,
};
