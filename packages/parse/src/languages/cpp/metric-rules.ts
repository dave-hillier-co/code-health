import type { Node } from "web-tree-sitter";
import type { ConstructMap, MetricRules, RecursionScope } from "../../metric-rules.ts";

/**
 * The C++ mapping onto the metric engine. The definitions are in unit-metrics.ts, with these C++ readings:
 *
 * - Decisions: `if` (an `else if` is an `if`), `for`, range-`for`, `while`, `do`, each `case` (not
 *   `default`, which the grammar also types as a case), `catch`, the ternary, and `&&`, `||` (and their
 *   alternative tokens `and`, `or`).
 * - A lambda is a nested function: its body is one level deeper and adds to the enclosing function, and it
 *   adds no base 1 of its own.
 * - `goto` costs a flat 1 in cognitive complexity, like a labelled `break`, and nothing in cyclomatic. `break`
 *   and `continue` have no labels in C++, so they cost nothing.
 * - Preprocessor branches (`#if`, `#ifdef`, `#else`) are not decisions. Conditional compilation is parsed as
 *   written, so the statements of every branch are in the tree and are counted like any others.
 */

const constructs: ConstructMap = {
  functionLike: new Set(["function_definition", "lambda_expression"]),
  loops: {
    for_statement: "for",
    for_range_loop: "range-for",
    while_statement: "while",
    do_statement: "do-while",
  },
  conditional: { type: "if_statement", condition: "condition", consequence: "consequence", alternative: "alternative", alternativeIsClause: true },
  switch: {
    type: "switch_statement",
    body: "body",
    caseType: "case_statement",
    // `default:` is a case_statement with no value.
    isCase: (node) => node.childForFieldName("value") !== null,
  },
  tryType: "try_statement",
  catchType: "catch_clause",
  ternary: { type: "conditional_expression", condition: "condition", consequence: "consequence", alternative: "alternative" },
  binary: {
    type: "binary_expression",
    operator: "operator",
    left: "left",
    right: "right",
    logical: new Set(["&&", "||", "and", "or"]),
    decisions: new Set(),
  },
  compoundAssignment: { type: "assignment_expression", operator: "operator", decisions: new Set() },
  parenthesized: "parenthesized_expression",
  labelledJumps: { goto_statement: "goto" },
  label: "label",
  commentTypes: new Set(["comment"]),
};

const notStatements = new Set(["compound_statement", "labeled_statement", "case_statement"]);

/** A statement node. Local declarations count, and so does a range `for`. The initialiser of a `for` and the declaration in a condition do not. */
function isStatement(node: Node): boolean {
  const type = node.type;
  if (notStatements.has(type)) return false;
  if (type === "expression_statement") return node.namedChildCount > 0;
  if (type === "declaration") {
    const parent = node.parent;
    return !(parent?.type === "for_statement" || parent?.type === "condition_clause" || parent?.type === "for_range_loop");
  }
  return type.endsWith("_statement") || type === "for_range_loop";
}

/** The function_declarator of a function node, through pointer, reference and parenthesised declarators. */
export function functionDeclarator(fn: Node): Node | null {
  let current = fn.childForFieldName("declarator");
  while (current !== null && current.type !== "function_declarator" && current.type !== "abstract_function_declarator") {
    const next: Node | null = current.childForFieldName("declarator") ?? current.namedChildren.find((child) => child.type.endsWith("declarator")) ?? null;
    if (next === null || next.id === current.id) return null;
    current = next;
  }
  return current;
}

export interface DeclaratorName {
  /** Scopes written before the name, `Invoice` for `Invoice::total`, without template arguments. */
  qualifier: string[];
  name: string;
}

function plainName(node: Node): string {
  const text = node.type === "template_type" ? (node.childForFieldName("name")?.text ?? node.text) : node.text;
  return text.replace(/\s+/g, "");
}

/** The name a function declarator declares, with the scopes it is qualified by. Null for an anonymous one. */
export function declaratorName(declarator: Node | null): DeclaratorName | null {
  if (declarator === null) return null;
  const qualifier: string[] = [];
  let current: Node | null = declarator.childForFieldName("declarator");
  while (current !== null && current.type === "qualified_identifier") {
    const scope = current.childForFieldName("scope");
    if (scope !== null) qualifier.push(plainName(scope));
    current = current.childForFieldName("name");
  }
  if (current === null) return null;
  if (current.type === "template_function" || current.type === "template_method") current = current.childForFieldName("name") ?? current;
  return { qualifier, name: plainName(current) };
}

function ownerOf(fn: Node, qualifier: readonly string[]): string | undefined {
  if (qualifier.length > 0) return qualifier.at(-1);
  for (let parent = fn.parent; parent !== null; parent = parent.parent) {
    if (parent.type === "class_specifier" || parent.type === "struct_specifier" || parent.type === "union_specifier") {
      const name = parent.childForFieldName("name");
      return name === null ? undefined : plainName(name);
    }
    if (parent.type === "function_definition" || parent.type === "translation_unit") return undefined;
  }
  return undefined;
}

function recursionScope(fn: Node, name: string | undefined): RecursionScope {
  if (fn.type === "lambda_expression") return { bare: new Set(), member: new Set() };
  const named = declaratorName(functionDeclarator(fn));
  const own = named?.name ?? name;
  // A member function's own name is in scope inside it, so a bare call recurses, and so does `this->name()`.
  const names = new Set(own === undefined ? [] : [own]);
  const owner = named === null ? undefined : ownerOf(fn, named.qualifier);
  return { bare: names, member: names, ...(owner === undefined ? {} : { owner }) };
}

function isRecursiveCall(call: Node, scope: RecursionScope): boolean {
  const callee = call.childForFieldName("function");
  if (callee === null) return false;
  switch (callee.type) {
    case "identifier":
      return scope.bare.has(callee.text);
    case "field_expression": {
      const object = callee.childForFieldName("argument");
      const field = callee.childForFieldName("field")?.text ?? "";
      return scope.member.has(field) && object?.type === "this";
    }
    case "qualified_identifier": {
      const name = callee.childForFieldName("name");
      const last = name === null ? "" : plainName(name);
      const scopeName = callee.childForFieldName("scope");
      if (!scope.bare.has(last)) return false;
      return scope.owner === undefined || (scopeName !== null && plainName(scopeName) === scope.owner);
    }
    default:
      return false;
  }
}

/** Declared parameters of a parameter_list, `f(void)` counting none. */
export function countParameters(list: Node | null): number {
  const entries = (list?.namedChildren ?? []).filter((entry) => entry.type !== "comment");
  // `f(void)` declares no parameter.
  if (entries.length === 1 && entries[0]!.type === "parameter_declaration" && entries[0]!.text.trim() === "void") return 0;
  return entries.length;
}

export function parameterCounts(fn: Node): { parameters: number; optionCount: number } {
  return { parameters: countParameters(functionDeclarator(fn)?.childForFieldName("parameters") ?? null), optionCount: 0 };
}

export const cppMetricRules: MetricRules = {
  constructs,
  isStatement,
  hasExpressionBody: () => false,
  recursionScope,
  isRecursiveCall,
  callType: "call_expression",
  parameterCounts,
};
