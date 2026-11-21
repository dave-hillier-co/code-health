import type { Node } from "web-tree-sitter";
import type { ConstructMap, MetricRules, RecursionScope } from "../../metric-rules.ts";

/**
 * The TypeScript and JavaScript mapping onto the metric engine. The definitions are in unit-metrics.ts:
 * `if` (an `else if` is an `if`), loops, each `case`, `catch`, the ternary, and `&&`, `||`, `??` (also as
 * `&&=`, `||=`, `??=`) are decisions, and optional chaining is not counted.
 */

const constructs: ConstructMap = {
  functionLike: new Set([
    "arrow_function",
    "function_expression",
    "function",
    "generator_function",
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
  ]),
  loops: {
    for_statement: "for",
    for_in_statement: "for-in",
    while_statement: "while",
    do_statement: "do-while",
  },
  conditional: { type: "if_statement", condition: "condition", consequence: "consequence", alternative: "alternative", alternativeIsClause: true },
  switch: { type: "switch_statement", body: "body", caseType: "switch_case" },
  tryType: "try_statement",
  catchType: "catch_clause",
  ternary: { type: "ternary_expression", condition: "condition", consequence: "consequence", alternative: "alternative" },
  binary: {
    type: "binary_expression",
    operator: "operator",
    left: "left",
    right: "right",
    logical: new Set(["&&", "||"]),
    decisions: new Set(["??"]),
  },
  compoundAssignment: { type: "augmented_assignment_expression", operator: "operator", decisions: new Set(["&&=", "||=", "??="]) },
  parenthesized: "parenthesized_expression",
  labelledJumps: { break_statement: "break", continue_statement: "continue" },
  label: "label",
  commentTypes: new Set(["comment"]),
};

/** Statement nodes that are not `*_statement`. Blocks, clauses and labels are not statements of their own. */
const declarationStatements = new Set([
  "lexical_declaration",
  "variable_declaration",
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
]);
const notStatements = new Set(["empty_statement", "labeled_statement"]);

/** A statement node, except the initialiser and condition of a `for`, which the grammar also types as statements. */
function isStatement(node: Node): boolean {
  const type = node.type;
  if (!(type.endsWith("_statement") ? !notStatements.has(type) : declarationStatements.has(type))) return false;
  const parent = node.parent;
  return !(parent?.type === "for_statement" && parent.childForFieldName("body")?.id !== node.id);
}

/** True when `name` is bound again inside `fn`, by a parameter, a variable or a nested function, so a bare `name()` may not mean `fn`. */
function rebinds(fn: Node, name: string): boolean {
  const binders = fn.descendantsOfType(["required_parameter", "optional_parameter", "variable_declarator", "function_declaration", "rest_pattern"]);
  const own = fn.childForFieldName("name");
  return binders.some((binder) => {
    if (binder.id === fn.id) return false;
    if (binder.type === "function_declaration") return binder.childForFieldName("name")?.text === name;
    const target = binder.childForFieldName("pattern") ?? binder.childForFieldName("name") ?? binder;
    return target.descendantsOfType("identifier").some((identifier) => identifier.text === name && identifier.id !== own?.id);
  });
}

/** Parameters that are bare identifiers, as in a JS arrow function or function, are not wrapped in `required_parameter`. */
function rebindsBareParameter(fn: Node, name: string): boolean {
  const parameters = fn.descendantsOfType(["formal_parameters"]);
  return parameters.some((list) => list.namedChildren.some((child) => child.type === "identifier" && child.text === name));
}

function enclosingClassName(fn: Node): string | undefined {
  for (let parent = fn.parent; parent !== null; parent = parent.parent) {
    if (parent.type === "class_declaration" || parent.type === "class" || parent.type === "abstract_class_declaration") {
      return parent.childForFieldName("name")?.text;
    }
    if (parent.type === "program") return undefined;
  }
  return undefined;
}

function recursionScope(fn: Node, name: string | undefined): RecursionScope {
  const member = new Set<string>();
  if (name !== undefined) member.add(name);
  const own = fn.childForFieldName("name");
  if (own !== null) member.add(own.text);
  // A method's name is not in scope inside it: only `this.name()` or `Class.name()` reach it.
  const isMethod = fn.type === "method_definition";
  const bare = new Set<string>();
  if (!isMethod) {
    for (const candidate of own !== null && name === undefined ? [own.text] : [...(name !== undefined ? [name] : []), ...(own !== null ? [own.text] : [])]) {
      if (!rebinds(fn, candidate) && !rebindsBareParameter(fn, candidate)) bare.add(candidate);
    }
  }
  const owner = isMethod ? enclosingClassName(fn) : undefined;
  return { bare, member, ...(owner === undefined ? {} : { owner }) };
}

function isRecursiveCall(call: Node, scope: RecursionScope): boolean {
  const callee = call.childForFieldName("function");
  if (callee === null) return false;
  if (callee.type === "member_expression") {
    const object = callee.childForFieldName("object");
    const property = callee.childForFieldName("property")?.text ?? "";
    return scope.member.has(property) && (object?.type === "this" || (scope.owner !== undefined && object?.type === "identifier" && object.text === scope.owner));
  }
  return callee.type === "identifier" && scope.bare.has(callee.text);
}

export function parameterCounts(fn: Node): { parameters: number; optionCount: number } {
  let parameters = 0;
  let optionCount = 0;
  const single = fn.childForFieldName("parameter");
  const list = fn.childForFieldName("parameters");
  const entries = list === null ? (single === null ? [] : [single]) : list.namedChildren;
  for (const entry of entries) {
    if (entry.type === "comment") continue;
    let pattern: Node | null = entry;
    if (entry.type === "required_parameter" || entry.type === "optional_parameter") pattern = entry.childForFieldName("pattern");
    while (pattern !== null && pattern.type === "assignment_pattern") pattern = pattern.childForFieldName("left");
    if (pattern === null) continue;
    if (pattern.type === "this") continue;
    parameters++;
    if (pattern.type === "object_pattern") {
      optionCount += pattern.namedChildren.filter((property) => property.type !== "comment").length;
    }
  }
  return { parameters, optionCount };
}

export const typescriptMetricRules: MetricRules = {
  constructs,
  isStatement,
  hasExpressionBody(fn) {
    const body = fn.childForFieldName("body");
    return body !== null && fn.type === "arrow_function" && body.type !== "statement_block";
  },
  recursionScope,
  isRecursiveCall,
  callType: "call_expression",
  parameterCounts,
};
