import type { Node } from "web-tree-sitter";
import type { ConstructMap, MetricRules, RecursionScope } from "../../metric-rules.ts";

/**
 * The Python mapping onto the metric engine. The definitions are in unit-metrics.ts, with these Python
 * readings:
 * - `if`, `elif` (an `else if`) and `else` are clauses of one `if_statement`. A loop's `else` is not a decision.
 * - Loops are `for` and `while`. Each `case` of a `match` is a decision, except the catch-all `case _`.
 * - `except` is the catch. `try` adds nesting, and `with` does not.
 * - `and`, `or` are the logical operators, chained. `not` and comparison chains are not counted.
 * - The conditional expression `a if c else b` is the ternary.
 * - A comprehension's `for` and `if` clauses (and a `match` guard) add one to cyclomatic and nothing to cognitive.
 * - `lambda` and nested `def` are nested functions, one level deeper.
 */

const constructs: ConstructMap = {
  functionLike: new Set(["function_definition", "lambda"]),
  loops: { for_statement: "for", while_statement: "while" },
  conditional: {
    type: "if_statement",
    condition: "condition",
    consequence: "consequence",
    alternative: "alternative",
    alternativeIsClause: false,
    clauses: { elif: "elif_clause", else: "else_clause" },
  },
  switch: { type: "match_statement", body: "body", caseType: "case_clause" },
  tryType: "try_statement",
  catchType: "except_clause",
  catchBodyType: "block",
  ternary: { type: "conditional_expression", condition: "", consequence: "", alternative: "", positional: true },
  binary: {
    type: "boolean_operator",
    operator: "operator",
    left: "left",
    right: "right",
    logical: new Set(["and", "or"]),
    decisions: new Set(),
  },
  compoundAssignment: { type: "augmented_assignment", operator: "operator", decisions: new Set() },
  parenthesized: "parenthesized_expression",
  labelledJumps: {},
  label: "label",
  cyclomaticOnly: { for_in_clause: "comprehension for", if_clause: "comprehension if" },
  commentTypes: new Set(["comment"]),
};

const statementTypes = new Set(["function_definition", "class_definition"]);

/** A statement node: every `*_statement`, and a nested `def` or `class`. A decorated definition counts through the definition it wraps. */
function isStatement(node: Node): boolean {
  return node.type.endsWith("_statement") || statementTypes.has(node.type);
}

/** The class a function is declared directly in, through its decorators, or null for any other function. */
export function enclosingClass(fn: Node): Node | null {
  let parent = fn.parent;
  if (parent?.type === "decorated_definition") parent = parent.parent;
  if (parent?.type !== "block") return null;
  const owner = parent.parent;
  return owner?.type === "class_definition" ? owner : null;
}

/** True when the function is a method with an implicit first parameter: declared in a class body and not a `staticmethod`. */
export function takesInstance(fn: Node): boolean {
  if (fn.type !== "function_definition" || enclosingClass(fn) === null) return false;
  const wrapper = fn.parent;
  if (wrapper?.type !== "decorated_definition") return true;
  return !wrapper.namedChildren.some((child) => child.type === "decorator" && child.text.replace(/^@\s*/, "") === "staticmethod");
}

const parameterTypes = new Set(["identifier", "default_parameter", "typed_parameter", "typed_default_parameter", "list_splat_pattern", "dictionary_splat_pattern", "tuple_pattern"]);

/** The declared parameters, the implicit `self` or `cls` of a method left out. `*` and `/` separators are not parameters. */
export function parameterNodes(fn: Node): Node[] {
  const list = fn.childForFieldName("parameters");
  const entries = (list?.namedChildren ?? []).filter((entry) => parameterTypes.has(entry.type));
  if (takesInstance(fn) && (entries[0]?.type === "identifier" || entries[0]?.type === "typed_parameter")) entries.shift();
  return entries;
}

/** The name a parameter binds. */
export function parameterName(parameter: Node): string | undefined {
  const named = parameter.childForFieldName("name");
  if (named !== null) return named.text;
  if (parameter.type === "identifier") return parameter.text;
  return parameter.namedChildren.find((child) => child.type === "identifier")?.text;
}

/** True when `name` is bound again inside `fn`: a parameter, an assignment target or a nested function of that name. */
function rebinds(fn: Node, name: string): boolean {
  if (parameterNodes(fn).some((parameter) => parameterName(parameter) === name)) return true;
  for (const nested of fn.descendantsOfType(["function_definition", "assignment"])) {
    if (nested.id === fn.id) continue;
    if (nested.type === "function_definition") {
      if (nested.childForFieldName("name")?.text === name) return true;
    } else if (nested.childForFieldName("left")?.type === "identifier" && nested.childForFieldName("left")?.text === name) return true;
  }
  return false;
}

function recursionScope(fn: Node, name: string | undefined): RecursionScope {
  const own = fn.childForFieldName("name")?.text;
  const names = [...new Set([name, own].filter((candidate): candidate is string => candidate !== undefined))];
  const owner = enclosingClass(fn);
  const member = new Set(names);
  // A method's name is not in scope inside it: only `self.name()` or `Class.name()` reach it.
  const bare = new Set(owner === null ? names.filter((candidate) => !rebinds(fn, candidate)) : []);
  const ownerName = owner?.childForFieldName("name")?.text;
  return { bare, member, ...(ownerName === undefined ? {} : { owner: ownerName }) };
}

function isRecursiveCall(call: Node, scope: RecursionScope): boolean {
  const callee = call.childForFieldName("function");
  if (callee === null) return false;
  if (callee.type === "attribute") {
    const object = callee.childForFieldName("object");
    const attribute = callee.childForFieldName("attribute")?.text ?? "";
    return scope.member.has(attribute) && object?.type === "identifier" && (object.text === "self" || object.text === "cls" || object.text === scope.owner);
  }
  return callee.type === "identifier" && scope.bare.has(callee.text);
}

/** `case _:` with no guard matches whatever is left, like `default`: it is not a decision. */
function isDefaultCase(node: Node): boolean {
  if (node.childForFieldName("guard") !== null) return false;
  const patterns = node.namedChildren.filter((child) => child.type === "case_pattern");
  return patterns.length === 1 && patterns[0]!.text.trim() === "_";
}

export const pythonMetricRules: MetricRules = {
  constructs,
  isStatement,
  hasExpressionBody: (fn) => fn.type === "lambda",
  recursionScope,
  isRecursiveCall,
  isDefaultCase,
  callType: "call",
  parameterCounts(fn) {
    return { parameters: parameterNodes(fn).length, optionCount: 0 };
  },
};
