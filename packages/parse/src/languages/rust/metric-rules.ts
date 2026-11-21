import type { Node } from "web-tree-sitter";
import type { ConstructMap, MetricRules, RecursionScope } from "../../metric-rules.ts";

/**
 * The Rust mapping onto the metric engine. The definitions are in unit-metrics.ts, with these readings of
 * Rust's constructs (suite.md, Metric definitions per language):
 *
 * - `if` and `if let` are one decision each, and `else if` is an `if`. `while let` is a `while`. `loop` is a loop.
 * - `match` is a `switch`. Every arm is a case, the wildcard arm included, because a `match` must be
 *   exhaustive and its last arm is not a default that falls outside the choices. Guards are walked, so `&&`
 *   and `||` in them count. `|` between patterns is not a decision.
 * - `&&` and `||` are decisions, also inside a let chain. The `?` operator is not counted: it returns early
 *   on the error path without branching in the source, and `Option` and `Result` handling would otherwise
 *   dominate every function that propagates errors.
 * - A closure is a nested function. A labelled `break` or `continue` costs a flat 1.
 * - Statements are the children of a block that are not comments or labels: `let`, expression statements,
 *   nested items and the tail expression.
 */

const none = "(none)";

const constructs: ConstructMap = {
  functionLike: new Set(["function_item", "closure_expression"]),
  loops: { for_expression: "for", while_expression: "while", loop_expression: "loop" },
  conditional: { type: "if_expression", condition: "condition", consequence: "consequence", alternative: "alternative", alternativeIsClause: true },
  switch: { type: "match_expression", body: "body", caseType: "match_arm" },
  // Rust has no `try` or `catch` statement and no ternary: `?` and `if` expressions are not counted as them.
  tryType: none,
  catchType: none,
  ternary: { type: none, condition: none, consequence: none, alternative: none },
  binary: {
    type: "binary_expression",
    operator: "operator",
    left: "left",
    right: "right",
    logical: new Set(["&&", "||"]),
    decisions: new Set(),
  },
  flatLogical: { type: "let_chain", operators: new Set(["&&"]) },
  compoundAssignment: { type: "compound_assignment_expr", operator: "operator", decisions: new Set() },
  parenthesized: "parenthesized_expression",
  labelledJumps: { break_expression: "break", continue_expression: "continue" },
  label: "label",
  commentTypes: new Set(["line_comment", "block_comment"]),
};

const notStatements = new Set(["line_comment", "block_comment", "label", "empty_statement"]);

/** A named child of a block: a statement, an item or the tail expression. */
function isStatement(node: Node): boolean {
  return node.parent?.type === "block" && !notStatements.has(node.type);
}

function isLabelled(jump: Node): boolean {
  return jump.namedChildren.some((child) => child.type === "label");
}

/** The name of the type an `impl` block or trait declares members of, for `Type::name()` recursion. */
function ownerOf(fn: Node): string | undefined {
  const list = fn.parent;
  const owner = list?.parent;
  if (list?.type !== "declaration_list" || owner === null || owner === undefined) return undefined;
  if (owner.type === "trait_item") return owner.childForFieldName("name")?.text;
  if (owner.type !== "impl_item") return undefined;
  return typeName(owner.childForFieldName("type"));
}

/** The simple name of a type as written in an `impl` header: `Vec<T>`, `&Foo` and `a::Foo` are `Vec`, `Foo` and `Foo`. */
export function typeName(type: Node | null): string | undefined {
  let current = type;
  while (current !== null) {
    switch (current.type) {
      case "type_identifier":
        return current.text;
      case "generic_type":
        current = current.childForFieldName("type");
        break;
      case "scoped_type_identifier":
        current = current.childForFieldName("name");
        break;
      case "reference_type":
      case "pointer_type":
      case "array_type":
      case "slice_type":
        current = current.childForFieldName("type") ?? current.namedChildren[0] ?? null;
        break;
      default:
        return undefined;
    }
  }
  return undefined;
}

function recursionScope(fn: Node, name: string | undefined): RecursionScope {
  const own = fn.childForFieldName("name")?.text ?? name;
  const owner = ownerOf(fn);
  const names = own === undefined || fn.type !== "function_item" ? [] : [own];
  // A method's name is not in scope inside it: only `self.name()` or `Type::name()` reach it.
  const isMember = owner !== undefined;
  return { bare: new Set(isMember ? [] : names), member: new Set(names), ...(owner === undefined ? {} : { owner }) };
}

function isRecursiveCall(call: Node, scope: RecursionScope): boolean {
  let callee = call.childForFieldName("function");
  if (callee?.type === "generic_function") callee = callee.childForFieldName("function");
  if (callee === null) return false;
  if (callee.type === "identifier") return scope.bare.has(callee.text);
  if (callee.type === "field_expression") {
    const receiver = callee.childForFieldName("value");
    return receiver?.type === "self" && scope.member.has(callee.childForFieldName("field")?.text ?? "");
  }
  if (callee.type === "scoped_identifier") {
    const path = callee.childForFieldName("path")?.text;
    const name = callee.childForFieldName("name")?.text ?? "";
    return scope.member.has(name) && (path === "Self" || (scope.owner !== undefined && path === scope.owner));
  }
  return false;
}

/** Declared parameters, `self` excluded. A destructured struct pattern counts once and its fields add to `optionCount`. */
export function parameterCounts(fn: Node): { parameters: number; optionCount: number } {
  let parameters = 0;
  let optionCount = 0;
  const list = fn.childForFieldName("parameters");
  for (const entry of list?.namedChildren ?? []) {
    if (entry.type === "line_comment" || entry.type === "block_comment" || entry.type === "attribute_item" || entry.type === "self_parameter") continue;
    parameters++;
    const pattern = entry.type === "parameter" ? entry.childForFieldName("pattern") : entry;
    const target = pattern?.type === "reference_pattern" || pattern?.type === "mut_pattern" ? (pattern.namedChildren[0] ?? pattern) : pattern;
    if (target?.type === "struct_pattern") {
      optionCount += target.namedChildren.filter((field) => field.type === "field_pattern" || field.type === "shorthand_field_identifier").length;
    }
  }
  return { parameters, optionCount };
}

export const rustMetricRules: MetricRules = {
  constructs,
  isStatement,
  hasExpressionBody(fn) {
    const body = fn.childForFieldName("body");
    return fn.type === "closure_expression" && body !== null && body.type !== "block";
  },
  recursionScope,
  isRecursiveCall,
  isLabelled,
  callType: "call_expression",
  parameterCounts,
};
