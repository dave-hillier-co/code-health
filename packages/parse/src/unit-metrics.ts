import type { Node } from "web-tree-sitter";
import type { Increment, UnitMetrics } from "./facts.ts";
import type { ConstructMap, MetricRules, RecursionScope } from "./metric-rules.ts";

/**
 * Structural metrics of one function, computed from its syntax tree. Each metric is one decision in one
 * place below, so the definitions in complexity.md can be checked against the code.
 *
 * - Cyclomatic: 1 plus decision points: `if` (an `else if` is an `if`), loops, each `case` (not
 *   `default`), `catch`, the ternary, and `&&`, `||`, `??` (also as `&&=`, `||=`, `??=`). Optional
 *   chaining is not counted. `cyclomaticModified` counts one per `switch` instead of one per `case`.
 *   Decision points inside nested functions count for the enclosing function, but a nested function
 *   adds no base 1 of its own.
 * - Cognitive: the SonarSource specification. Structures that break linear flow cost 1 plus their
 *   nesting level: `if`, ternary, `switch`, loops, `catch`. `else if`, `else`, a labelled `break` or
 *   `continue`, direct recursion and each sequence of like `&&` or `||` operators cost a flat 1.
 *   `??` and `?.` are free. The body of a structure, and any nested function, is one level deeper.
 *   Nested functions add to the enclosing function's score.
 * - Nesting: the deepest nesting of `if`, loop, `switch` and `try` statements, with an `else if` at the
 *   level of its `if`. Nested functions do not add a level, they continue from where they sit.
 * - Length: lines of the unit holding code, so blank and comment-only lines are left out.
 * - Statements: statement nodes, nested functions' included. An expression body counts as one.
 * - Parameters: declared parameters, `this` excluded. A destructured object parameter counts once, and
 *   its properties add to `optionCount`.
 */

export interface MeasureOptions {
  /** The unit's own name, to find direct recursion. */
  name?: string;
  /** 1-based first and last lines of the unit, for length. */
  startLine: number;
  endLine: number;
  /** Rows (0-based) of the file that hold anything but comments and whitespace. */
  codeRows: ReadonlyArray<boolean>;
  /** Also return where each increment came from. */
  explain?: boolean;
}

export interface Measured {
  metrics: UnitMetrics;
  increments?: Increment[];
}

class Measurer {
  cyclomatic = 1;
  cyclomaticModified = 1;
  cognitive = 0;
  nesting = 0;
  statements = 0;
  private recursion = false;
  readonly increments: Increment[] = [];

  private readonly options: MeasureOptions;
  private readonly rules: MetricRules;
  private readonly c: ConstructMap;
  private readonly scope: RecursionScope;

  constructor(options: MeasureOptions, rules: MetricRules, scope: RecursionScope) {
    this.options = options;
    this.rules = rules;
    this.c = rules.constructs;
    this.scope = scope;
  }

  private record(node: Node, metric: Increment["metric"], construct: string, amount: number, nesting: number, switchMode?: Increment["switchMode"]): void {
    if (this.options.explain) {
      this.increments.push({ line: node.startPosition.row + 1, metric, construct, amount, nesting, ...(switchMode === undefined ? {} : { switchMode }) });
    }
  }

  private decision(node: Node, construct: string): void {
    this.cyclomatic++;
    this.cyclomaticModified++;
    this.record(node, "cyclomatic", construct, 1, 0);
  }

  private flow(node: Node, construct: string, level: number): void {
    this.cognitive += 1 + level;
    this.record(node, "cognitive", construct, 1 + level, level);
  }

  private flat(node: Node, construct: string): void {
    this.cognitive += 1;
    this.record(node, "cognitive", construct, 1, 0);
  }

  /** Walks the function's own parameters and body, at level 0. */
  function(fn: Node): void {
    this.statementsOfExpressionBody(fn);
    this.children(fn, 0, 0);
  }

  private statementsOfExpressionBody(fn: Node): void {
    if (this.rules.hasExpressionBody(fn)) this.statements++;
  }

  private children(node: Node, level: number, depth: number, skip?: Node | null): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null && child.isNamed && child.id !== skip?.id) this.visit(child, level, depth);
    }
  }

  private visit(node: Node, level: number, depth: number): void {
    const type = node.type;
    const c = this.c;
    if (this.rules.isStatement(node)) this.statements++;
    if (c.functionLike.has(type)) {
      this.statementsOfExpressionBody(node);
      this.children(node, level + 1, depth);
      return;
    }
    if (type === c.conditional.type) {
      this.ifStatement(node, level, depth, false);
      return;
    }
    if (c.loops[type] !== undefined) {
      this.loop(node, level, depth);
      return;
    }
    if (type === c.switch.type) {
      this.flow(node, "switch", level);
      this.cyclomaticModified++;
      this.record(node, "cyclomatic", "switch", 1, 0, "modified");
      this.nesting = Math.max(this.nesting, depth + 1);
      const body = node.childForFieldName(c.switch.body);
      this.children(node, level, depth, body);
      if (body !== null) this.children(body, level + 1, depth + 1);
      return;
    }
    if (type === c.switch.caseType) {
      if (this.rules.isDefaultCase?.(node) !== true) {
        this.cyclomatic++;
        this.record(node, "cyclomatic", "case", 1, 0, "case");
      }
      this.children(node, level, depth);
      return;
    }
    const only = c.cyclomaticOnly?.[type];
    if (only !== undefined) {
      this.decision(node, only);
      this.children(node, level, depth);
      return;
    }
    if (type === c.tryType) {
      this.nesting = Math.max(this.nesting, depth + 1);
      this.children(node, level, depth + 1);
      return;
    }
    if (type === c.catchType) {
      this.flow(node, "catch", level);
      this.decision(node, "catch");
      const body = c.catchBodyType === undefined ? node.childForFieldName("body") : (node.namedChildren.find((child) => child.type === c.catchBodyType) ?? null);
      this.children(node, level, depth, body);
      if (body !== null) this.visit(body, level + 1, depth);
      return;
    }
    if (type === c.ternary.type) {
      this.flow(node, "ternary", level);
      this.decision(node, "ternary");
      const [condition, ...branches] = this.ternaryParts(node);
      if (condition !== null) this.visit(condition, level, depth);
      for (const branch of branches) if (branch !== null) this.visit(branch, level + 1, depth);
      return;
    }
    if (type === c.binary.type) {
      const operator = this.operatorOf(node);
      if (operator !== undefined && c.binary.logical.has(operator)) {
        this.logicalChain(node, level, depth);
        return;
      }
      if (operator !== undefined && c.binary.decisions.has(operator)) this.decision(node, operator);
      this.children(node, level, depth);
      return;
    }
    if (type === c.compoundAssignment.type) {
      const operator = node.childForFieldName(c.compoundAssignment.operator)?.type;
      if (operator !== undefined && c.compoundAssignment.decisions.has(operator)) this.decision(node, operator);
      this.children(node, level, depth);
      return;
    }
    const jump = c.labelledJumps[type];
    if (jump !== undefined) {
      if (node.childForFieldName(c.label) !== null) this.flat(node, `labelled ${jump}`);
      return;
    }
    if (type === this.rules.callType) this.recursionCheck(node);
    this.children(node, level, depth);
  }

  /** The condition, consequence and alternative of a ternary, by field or by position. */
  private ternaryParts(node: Node): [Node | null, Node | null, Node | null] {
    const t = this.c.ternary;
    if (t.positional !== true) return [node.childForFieldName(t.condition), node.childForFieldName(t.consequence), node.childForFieldName(t.alternative)];
    const parts = node.namedChildren.filter((child) => !this.c.commentTypes.has(child.type));
    return [parts[1] ?? null, parts[0] ?? null, parts[2] ?? null];
  }

  private operatorOf(node: Node): string | undefined {
    return node.childForFieldName(this.c.binary.operator)?.type;
  }

  private ifStatement(node: Node, level: number, depth: number, isElseIf: boolean): void {
    const c = this.c.conditional;
    if (isElseIf) this.flat(node, "else if");
    else {
      this.flow(node, "if", level);
      this.nesting = Math.max(this.nesting, depth + 1);
    }
    this.decision(node, isElseIf ? "else if" : "if");
    const condition = node.childForFieldName(c.condition);
    if (condition !== null) this.visit(condition, level, depth);
    const consequence = node.childForFieldName(c.consequence);
    // An else-if sits at its if's depth, so every body in the chain is one level deeper than the chain.
    if (consequence !== null) this.visit(consequence, level + 1, depth + 1);
    if (c.clauses !== undefined) {
      this.clauseChain(node, level, depth);
      return;
    }
    const alternative = node.childForFieldName(c.alternative);
    if (alternative === null) return;
    const inner = c.alternativeIsClause ? (alternative.namedChildren.find((child) => !this.c.commentTypes.has(child.type)) ?? null) : alternative;
    if (inner === null) return;
    if (inner.type === c.type) {
      this.statements++;
      this.ifStatement(inner, level, depth, true);
    } else {
      this.flat(alternative, "else");
      this.visit(inner, level + 1, depth + 1);
    }
  }

  /** The `elif` and `else` clauses of an `if` whose alternatives are clause nodes. They sit at the `if`'s level and depth. */
  private clauseChain(node: Node, level: number, depth: number): void {
    const c = this.c.conditional;
    for (const clause of node.childrenForFieldName(c.alternative)) {
      if (clause.type === c.clauses!.elif) {
        this.flat(clause, "else if");
        this.decision(clause, "else if");
        const condition = clause.childForFieldName(c.condition);
        if (condition !== null) this.visit(condition, level, depth);
        const consequence = clause.childForFieldName(c.consequence);
        if (consequence !== null) this.visit(consequence, level + 1, depth + 1);
      } else if (clause.type === c.clauses!.else) {
        this.flat(clause, "else");
        const body = clause.childForFieldName("body");
        if (body !== null) this.visit(body, level + 1, depth + 1);
      }
    }
  }

  private loop(node: Node, level: number, depth: number): void {
    const construct = this.c.loops[node.type] ?? node.type;
    this.flow(node, construct, level);
    this.decision(node, construct);
    this.nesting = Math.max(this.nesting, depth + 1);
    const body = node.childForFieldName("body");
    this.children(node, level, depth, body);
    if (body !== null) this.visit(body, level + 1, depth + 1);
  }

  /**
   * One increment per run of like operators. The operands of the chain, with parentheses looked through,
   * are walked as ordinary nodes, so a chain inside a `!` or a call argument is counted on its own.
   */
  private logicalChain(node: Node, level: number, depth: number): void {
    const binary = this.c.binary;
    const operators: { type: string; node: Node }[] = [];
    const operands: Node[] = [];
    const collect = (candidate: Node): void => {
      let inner = candidate;
      while (inner.type === this.c.parenthesized && inner.namedChildCount === 1) inner = inner.namedChild(0)!;
      const operator = inner.type === binary.type ? this.operatorOf(inner) : undefined;
      if (operator !== undefined && binary.logical.has(operator)) {
        collect(inner.childForFieldName(binary.left)!);
        operators.push({ type: operator, node: inner.childForFieldName(binary.operator)! });
        collect(inner.childForFieldName(binary.right)!);
      } else operands.push(candidate);
    };
    collect(node);
    let previous: string | undefined;
    for (const operator of operators) {
      this.cyclomatic++;
      this.cyclomaticModified++;
      this.record(operator.node, "cyclomatic", operator.type, 1, 0);
      if (operator.type !== previous) this.flat(operator.node, `sequence of ${operator.type}`);
      previous = operator.type;
    }
    for (const operand of operands) this.visit(operand, level, depth);
  }

  private recursionCheck(call: Node): void {
    if (this.recursion) return;
    if (this.rules.isRecursiveCall(call, this.scope)) {
      this.recursion = true;
      this.flat(call, "recursion");
    }
  }
}

/** Rows (0-based) of a file that hold code: any row a non-comment token touches. */
export function codeRowsOf(root: Node, rules: MetricRules): boolean[] {
  const comments = rules.constructs.commentTypes;
  const rows: boolean[] = new Array<boolean>(root.endPosition.row + 1).fill(false);
  const walk = (node: Node): void => {
    if (comments.has(node.type)) return;
    if (node.childCount === 0) {
      for (let row = node.startPosition.row; row <= node.endPosition.row; row++) rows[row] = true;
      return;
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  };
  walk(root);
  return rows;
}

/** Measures one function-like node under a language's rules. `fn` is the function itself, not the declaration that names it. */
export function measureFunction(fn: Node, options: MeasureOptions, rules: MetricRules): Measured {
  const measurer = new Measurer(options, rules, rules.recursionScope(fn, options.name));
  measurer.function(fn);

  let length = 0;
  for (let line = options.startLine; line <= options.endLine; line++) if (options.codeRows[line - 1] === true) length++;
  const { parameters, optionCount } = rules.parameterCounts(fn);
  const metrics: UnitMetrics = {
    cyclomatic: measurer.cyclomatic,
    cyclomaticModified: measurer.cyclomaticModified,
    cognitive: measurer.cognitive,
    nesting: measurer.nesting,
    length,
    statements: measurer.statements,
    parameters,
    optionCount,
  };
  if (!options.explain) return { metrics };
  const increments = [
    { line: options.startLine, metric: "cyclomatic" as const, construct: "function", amount: 1, nesting: 0 },
    ...measurer.increments,
  ];
  return { metrics, increments };
}
