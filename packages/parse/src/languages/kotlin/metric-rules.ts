import type { Node } from "web-tree-sitter";
import type { ConstructMap, MetricRules, RecursionScope } from "../../metric-rules.ts";

/**
 * The Kotlin mapping onto the metric engine. Decisions are `if`, loops, each `when` entry with a condition (the
 * `else` entry is not one), `catch`, and `&&` and `||`. The elvis operator `?:` is null-coalescing, like `??` in
 * TypeScript, and is not counted in cognitive complexity but, unlike `??`, is not a cyclomatic decision either:
 * the specification pins it as free in both. Safe calls `?.` and `!!` are free. `if` is an expression, so Kotlin
 * has no ternary. A lambda, an anonymous function and a local function are nested functions: one level deeper,
 * counted in the enclosing function. `break@label` and `continue@label` cost a flat 1.
 */

const branchPartsOf = (node: Node): { consequence: Node | null; alternative: Node | null } => {
  const condition = node.childForFieldName("condition");
  const parts = node.namedChildren.filter((child) => child.id !== condition?.id && child.type !== "line_comment" && child.type !== "block_comment");
  return { consequence: parts[0] ?? null, alternative: parts[1] ?? null };
};

const nonBody = new Set(["line_comment", "block_comment", "label"]);

/** The body of a loop or `catch`: the last named child that is not its condition, label or comment, and for `do ... while` the first. */
const bodyOf = (node: Node): Node | null => {
  const condition = node.childForFieldName("condition");
  const parts = node.namedChildren.filter((child) => child.id !== condition?.id && !nonBody.has(child.type));
  if (node.type === "do_while_statement") return parts[0] ?? null;
  return parts.at(-1) ?? null;
};

const constructs: ConstructMap = {
  functionLike: new Set(["function_declaration", "secondary_constructor", "anonymous_function", "lambda_literal", "getter", "setter"]),
  loops: { for_statement: "for", while_statement: "while", do_while_statement: "do-while" },
  conditional: { type: "if_expression", condition: "condition", consequence: "", alternative: "", alternativeIsClause: false, branches: branchPartsOf },
  switch: {
    type: "when_expression",
    body: "",
    caseType: "when_entry",
    // The `else` entry has no condition.
    isCase: (entry) => entry.childForFieldName("condition") !== null,
    headTypes: new Set(["when_subject"]),
  },
  tryType: "try_expression",
  catchType: "catch_block",
  bodyOf,
  ternary: { type: "(none)", condition: "", consequence: "", alternative: "" },
  binary: { type: "binary_expression", operator: "operator", left: "left", right: "right", logical: new Set(["&&", "||"]), decisions: new Set() },
  compoundAssignment: { type: "assignment", operator: "operator", decisions: new Set() },
  parenthesized: "parenthesized_expression",
  labelledJumps: {},
  label: "label",
  labelledJump: (node) => {
    if (node.type !== "labeled_expression") return null;
    const label = node.namedChildren.find((child) => child.type === "label")?.text ?? "";
    if (label.startsWith("break@")) return "break";
    if (label.startsWith("continue@")) return "continue";
    return null;
  },
  commentTypes: new Set(["line_comment", "block_comment"]),
};

/** Parents whose children are statements. */
const statementContainers = new Set(["block", "lambda_literal"]);
/** Parents whose single-expression branches are statements when the parent is itself in statement position. */
const branchContainers = new Set(["if_expression", "when_entry", "for_statement", "while_statement", "do_while_statement"]);
const notStatements = new Set(["block", "line_comment", "block_comment", "lambda_parameters", "label", "when_subject"]);

function isBranch(node: Node, parent: Node): boolean {
  if (parent.type === "if_expression" || parent.type === "when_entry") {
    // The condition or conditions are fields, and everything else named is a branch.
    return parent.childrenForFieldName("condition").every((condition) => condition.id !== node.id);
  }
  return bodyOf(parent)?.id === node.id;
}

/** True when `node` sits where a statement can: in a block or lambda, or as the branch of an `if`, `when` or loop that does. */
function inStatementPosition(node: Node): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  if (statementContainers.has(parent.type)) return true;
  // An entry of a `when` is in statement position when the `when` is.
  if (node.type === "when_entry") return inStatementPosition(parent);
  return branchContainers.has(parent.type) && isBranch(node, parent) && inStatementPosition(parent);
}

function isStatement(node: Node): boolean {
  if (notStatements.has(node.type) || !node.isNamed) return false;
  const parent = node.parent;
  if (parent === null) return false;
  if (statementContainers.has(parent.type)) return true;
  // A braceless branch is a statement only where the `if` or `when` it belongs to is one: `val x = if (c) 1 else 2` is one statement.
  return branchContainers.has(parent.type) && isBranch(node, parent) && inStatementPosition(parent);
}

function enclosingClassName(fn: Node): string | undefined {
  for (let parent = fn.parent; parent !== null; parent = parent.parent) {
    if (parent.type === "class_declaration" || parent.type === "object_declaration") return parent.childForFieldName("name")?.text;
  }
  return undefined;
}

function recursionScope(fn: Node, name: string | undefined): RecursionScope {
  if (fn.type !== "function_declaration") return { bare: new Set(), member: new Set() };
  const own = fn.childForFieldName("name")?.text ?? name;
  const names = new Set(own === undefined ? [] : [own]);
  const owner = enclosingClassName(fn);
  return { bare: names, member: names, ...(owner === undefined ? {} : { owner }) };
}

function isRecursiveCall(call: Node, scope: RecursionScope): boolean {
  const callee = call.namedChildren[0];
  if (callee === undefined) return false;
  if (callee.type === "identifier") return scope.bare.has(callee.text);
  if (callee.type !== "navigation_expression") return false;
  const [object, member] = callee.namedChildren;
  if (object === undefined || member === undefined || member.type !== "identifier" || !scope.member.has(member.text)) return false;
  return object.type === "this_expression" || (scope.owner !== undefined && object.type === "identifier" && object.text === scope.owner);
}

export function parameterCounts(fn: Node): { parameters: number; optionCount: number } {
  let parameters = 0;
  let optionCount = 0;
  const lists = fn.type === "lambda_literal" ? fn.namedChildren.filter((child) => child.type === "lambda_parameters") : fn.namedChildren.filter((child) => child.type === "function_value_parameters");
  const entries = fn.type === "setter" ? fn.namedChildren.filter((child) => child.type === "identifier") : lists.flatMap((list) => list.namedChildren);
  for (const entry of entries) {
    if (entry.type === "parameter" || entry.type === "variable_declaration" || entry.type === "identifier") parameters++;
    else if (entry.type === "multi_variable_declaration") {
      // A destructured lambda parameter counts once, and its components add to the option count.
      parameters++;
      optionCount += entry.namedChildren.filter((component) => component.type === "variable_declaration").length;
    }
  }
  return { parameters, optionCount };
}

export const kotlinMetricRules: MetricRules = {
  constructs,
  isStatement,
  hasExpressionBody(fn) {
    if (fn.type === "lambda_literal") return false;
    const body = fn.namedChildren.find((child) => child.type === "function_body");
    return body !== undefined && body.namedChildren.find((child) => child.type !== "line_comment" && child.type !== "block_comment")?.type !== "block";
  },
  recursionScope,
  isRecursiveCall,
  callType: "call_expression",
  parameterCounts,
};
