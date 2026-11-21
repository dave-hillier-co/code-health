import type { Node } from "web-tree-sitter";
import type { ConstructMap, MetricRules, RecursionScope } from "../../metric-rules.ts";

/**
 * The Java mapping onto the metric engine. Decisions are `if`, loops, each `case` label (not `default`), `catch`,
 * the ternary, and `&&` and `||`. Java has no null-coalescing operator, and a `switch` expression and a `switch`
 * statement are the same node. A lambda is a nested function: one level deeper, its body counted in the enclosing
 * method. A `break` or `continue` with a label costs a flat 1.
 */

const constructs: ConstructMap = {
  functionLike: new Set(["method_declaration", "constructor_declaration", "compact_constructor_declaration", "lambda_expression"]),
  loops: {
    for_statement: "for",
    enhanced_for_statement: "for-each",
    while_statement: "while",
    do_statement: "do-while",
  },
  conditional: { type: "if_statement", condition: "condition", consequence: "consequence", alternative: "alternative", alternativeIsClause: false },
  switch: {
    type: "switch_expression",
    body: "body",
    caseType: "switch_label",
    // `default ->` and `default:` are labels with nothing to match.
    isCase: (label) => label.namedChildCount > 0,
  },
  tryType: "try_statement",
  alsoTryTypes: new Set(["try_with_resources_statement"]),
  catchType: "catch_clause",
  ternary: { type: "ternary_expression", condition: "condition", consequence: "consequence", alternative: "alternative" },
  binary: { type: "binary_expression", operator: "operator", left: "left", right: "right", logical: new Set(["&&", "||"]), decisions: new Set() },
  compoundAssignment: { type: "assignment_expression", operator: "operator", decisions: new Set() },
  parenthesized: "parenthesized_expression",
  labelledJumps: {},
  label: "label",
  labelledJump: (node) => {
    if (node.type !== "break_statement" && node.type !== "continue_statement") return null;
    return node.namedChildren.some((child) => child.type === "identifier") ? node.type.replace("_statement", "") : null;
  },
  commentTypes: new Set(["line_comment", "block_comment"]),
};

/** Statement nodes that are not `*_statement`. Blocks, labels and the heads of a `for` are not statements of their own. */
const declarationStatements = new Set(["local_variable_declaration", "class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "explicit_constructor_invocation"]);
const notStatements = new Set(["labeled_statement"]);

function isStatement(node: Node): boolean {
  const type = node.type;
  const parent = node.parent;
  if (parent === null) return false;
  // A `switch` statement is the `switch` expression node, directly in a block or a case group.
  if (type === "switch_expression") return parent.type === "block" || parent.type === "switch_block_statement_group" || parent.type === "switch_rule";
  if (!(type.endsWith("_statement") ? !notStatements.has(type) : declarationStatements.has(type))) return false;
  // The initialiser of a `for` is a declaration or an expression statement, not a statement of the body.
  return !(parent.type === "for_statement" && parent.childForFieldName("body")?.id !== node.id);
}

function enclosingClassName(fn: Node): string | undefined {
  for (let parent = fn.parent; parent !== null; parent = parent.parent) {
    if (["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"].includes(parent.type)) return parent.childForFieldName("name")?.text;
  }
  return undefined;
}

function recursionScope(fn: Node, name: string | undefined): RecursionScope {
  // A method's own name is in scope inside it, bare or through `this`. A constructor or a lambda is not recursion.
  if (fn.type !== "method_declaration") return { bare: new Set(), member: new Set() };
  const own = fn.childForFieldName("name")?.text ?? name;
  const names = new Set(own === undefined ? [] : [own]);
  const owner = enclosingClassName(fn);
  return { bare: names, member: names, ...(owner === undefined ? {} : { owner }) };
}

function isRecursiveCall(call: Node, scope: RecursionScope): boolean {
  const method = call.childForFieldName("name")?.text;
  if (method === undefined) return false;
  const object = call.childForFieldName("object");
  if (object === null) return scope.bare.has(method);
  return scope.member.has(method) && (object.type === "this" || (scope.owner !== undefined && object.type === "identifier" && object.text === scope.owner));
}

export function parameterCounts(fn: Node): { parameters: number; optionCount: number } {
  const list = fn.childForFieldName("parameters");
  if (list === null) return { parameters: 0, optionCount: 0 };
  // A lambda with one bare parameter holds the identifier itself, and an inferred list holds identifiers.
  if (list.type === "identifier") return { parameters: 1, optionCount: 0 };
  const parameters = list.namedChildren.filter((child) => child.type === "formal_parameter" || child.type === "spread_parameter" || child.type === "identifier").length;
  return { parameters, optionCount: 0 };
}

export const javaMetricRules: MetricRules = {
  constructs,
  isStatement,
  hasExpressionBody(fn) {
    const body = fn.childForFieldName("body");
    return fn.type === "lambda_expression" && body !== null && body.type !== "block";
  },
  recursionScope,
  isRecursiveCall,
  callType: "method_invocation",
  parameterCounts,
};
