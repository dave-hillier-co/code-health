import type { Node } from "web-tree-sitter";

/**
 * How a language's syntax tree maps onto the complexity metrics. The metric engine in unit-metrics.ts owns
 * the definitions (cyclomatic, cognitive, nesting, length, statements, parameters) and asks a language only
 * which of its node types play which role. A language adds a `MetricRules` and never touches the engine.
 *
 * The fields below are tree-sitter node types and field names, so they are data. What cannot be data is a
 * hook: how a statement is recognised, what a recursive call looks like, how parameters are counted.
 */
export interface ConstructMap {
  /** Functions, methods and lambdas. A nested one is one level deeper and adds to the enclosing function's metrics. */
  functionLike: ReadonlySet<string>;
  /** Loop node type to the construct name reported. Each loop's body is its `body` field. */
  loops: Readonly<Record<string, string>>;
  /** `if`. An `else if` is an `if` found in the alternative. */
  conditional: {
    type: string;
    condition: string;
    consequence: string;
    alternative: string;
    /** The alternative field holds a clause node (`else_clause`) whose first named child is the branch. Otherwise the field is the branch. */
    alternativeIsClause: boolean;
    /**
     * The alternative field is repeated and holds clause nodes instead of one branch (Python `elif` and `else`).
     * An `elif` clause has the `condition` and `consequence` fields of the `if`, an `else` clause has a `body`. Neither
     * is a statement of its own, so an `elif` adds no statement.
     */
    clauses?: { elif: string; else: string };
  };
  /** `switch`, and the node that holds one `case` (a `default` is not a case). */
  switch: { type: string; body: string; caseType: string };
  /** `try` adds nesting. `catch` is a decision and its `body` field is walked one level deeper. */
  tryType: string;
  catchType: string;
  /** The clause has no `body` field: its body is its first named child of this node type (Python `except`). */
  catchBodyType?: string;
  /** The ternary, with the fields of its three parts. */
  ternary: {
    type: string;
    condition: string;
    consequence: string;
    alternative: string;
    /** The grammar gives the parts no field names: they are the first three named children, in the order consequence, condition, alternative (Python `a if c else b`). */
    positional?: boolean;
  };
  /** Binary expressions. `logical` operators are chained (one increment per run of like operators), `decisions` add to cyclomatic only. */
  binary: { type: string; operator: string; left: string; right: string; logical: ReadonlySet<string>; decisions: ReadonlySet<string> };
  /** `x ||= y` and friends: decision points when the operator is in `decisions`. */
  compoundAssignment: { type: string; operator: string; decisions: ReadonlySet<string> };
  /** Parentheses, looked through when a chain of logical operators is collected. */
  parenthesized: string;
  /** `break` and `continue` node types to their name. One with a `label` field costs a flat 1. */
  labelledJumps: Readonly<Record<string, string>>;
  label: string;
  /** Node types that add one to cyclomatic only, to the construct name reported (comprehension clauses). They add no cognitive increment and no nesting. */
  cyclomaticOnly?: Readonly<Record<string, string>>;
  /** Node types that hold comments, which are not code for length and are skipped when reading an `else`. */
  commentTypes: ReadonlySet<string>;
}

/** Names a call recurses through, so a call is direct recursion only when it names the function in scope. */
export interface RecursionScope {
  /** Names a bare call `name()` recurses through. */
  bare: ReadonlySet<string>;
  /** Names a member call such as `this.name()` recurses through. */
  member: ReadonlySet<string>;
  /** For a method, the class name, so `Class.method()` recurses too. */
  owner?: string;
}

export interface MetricRules {
  constructs: ConstructMap;
  /** A statement node for the statements metric, so blocks, clauses and labels do not count. */
  isStatement(node: Node): boolean;
  /** A function whose body is a single expression counts one statement (an arrow function). */
  hasExpressionBody(fn: Node): boolean;
  recursionScope(fn: Node, name: string | undefined): RecursionScope;
  /** True when the call node calls the function itself under the scope's names. */
  isRecursiveCall(call: Node, scope: RecursionScope): boolean;
  /** A case that is the catch-all (`default`, or Python's `case _`), which is not a decision. The grammar's `default` is a different node type, so only a language that writes it as a case needs this. */
  isDefaultCase?(node: Node): boolean;
  /** The node type of a call, which `isRecursiveCall` is asked about. */
  callType: string;
  /** Declared parameters, `this` excluded, and the properties destructured out of option-object parameters. */
  parameterCounts(fn: Node): { parameters: number; optionCount: number };
}
