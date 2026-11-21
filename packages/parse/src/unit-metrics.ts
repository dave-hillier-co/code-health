import type { Node } from "web-tree-sitter";
import type { Increment, UnitMetrics } from "./facts.ts";

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

const functionLike = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
]);

const loopNames: Record<string, string> = {
  for_statement: "for",
  for_in_statement: "for-in",
  while_statement: "while",
  do_statement: "do-while",
};

const logicalOperators = new Set(["&&", "||"]);
const cyclomaticOperators = new Set(["&&", "||", "??"]);
const cyclomaticAssignments = new Set(["&&=", "||=", "??="]);

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

class Measurer {
  cyclomatic = 1;
  cyclomaticModified = 1;
  cognitive = 0;
  nesting = 0;
  statements = 0;
  private recursion = false;
  readonly increments: Increment[] = [];

  constructor(
    private readonly options: MeasureOptions,
    private readonly names: ReadonlySet<string>,
  ) {}

  private record(node: Node, metric: Increment["metric"], construct: string, amount: number, nesting: number): void {
    if (this.options.explain) {
      this.increments.push({ line: node.startPosition.row + 1, metric, construct, amount, nesting });
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
    const body = fn.childForFieldName("body");
    if (body !== null && fn.type === "arrow_function" && body.type !== "statement_block") this.statements++;
  }

  private children(node: Node, level: number, depth: number, skip?: Node | null): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null && child.isNamed && child.id !== skip?.id) this.visit(child, level, depth);
    }
  }

  private visit(node: Node, level: number, depth: number): void {
    const type = node.type;
    if (this.isStatement(node)) this.statements++;
    if (functionLike.has(type)) {
      this.statementsOfExpressionBody(node);
      this.children(node, level + 1, depth);
      return;
    }

    switch (type) {
      case "if_statement":
        this.ifStatement(node, level, depth, false);
        return;
      case "for_statement":
      case "for_in_statement":
      case "while_statement":
      case "do_statement":
        this.loop(node, level, depth);
        return;
      case "switch_statement": {
        this.flow(node, "switch", level);
        this.cyclomaticModified++;
        this.nesting = Math.max(this.nesting, depth + 1);
        const body = node.childForFieldName("body");
        this.children(node, level, depth, body);
        if (body !== null) this.children(body, level + 1, depth + 1);
        return;
      }
      case "switch_case":
        this.cyclomatic++;
        this.record(node, "cyclomatic", "case", 1, 0);
        this.children(node, level, depth);
        return;
      case "try_statement":
        this.nesting = Math.max(this.nesting, depth + 1);
        this.children(node, level, depth + 1);
        return;
      case "catch_clause": {
        this.flow(node, "catch", level);
        this.decision(node, "catch");
        const body = node.childForFieldName("body");
        this.children(node, level, depth, body);
        if (body !== null) this.visit(body, level + 1, depth);
        return;
      }
      case "ternary_expression": {
        this.flow(node, "ternary", level);
        this.decision(node, "ternary");
        const condition = node.childForFieldName("condition");
        if (condition !== null) this.visit(condition, level, depth);
        for (const name of ["consequence", "alternative"]) {
          const branch = node.childForFieldName(name);
          if (branch !== null) this.visit(branch, level + 1, depth);
        }
        return;
      }
      case "binary_expression": {
        const operator = this.operatorOf(node);
        if (operator !== undefined && logicalOperators.has(operator)) {
          this.logicalChain(node, level, depth);
          return;
        }
        if (operator === "??") this.decision(node, "??");
        this.children(node, level, depth);
        return;
      }
      case "augmented_assignment_expression": {
        const operator = node.childForFieldName("operator")?.type;
        if (operator !== undefined && cyclomaticAssignments.has(operator)) this.decision(node, operator);
        this.children(node, level, depth);
        return;
      }
      case "break_statement":
      case "continue_statement":
        if (node.childForFieldName("label") !== null) this.flat(node, `labelled ${type.slice(0, -10)}`);
        return;
      case "call_expression":
        this.recursionCheck(node);
        this.children(node, level, depth);
        return;
      default:
        this.children(node, level, depth);
    }
  }

  /** A statement node, except the initialiser and condition of a `for`, which the grammar also types as statements. */
  private isStatement(node: Node): boolean {
    const type = node.type;
    if (!(type.endsWith("_statement") ? !notStatements.has(type) : declarationStatements.has(type))) return false;
    const parent = node.parent;
    return !(parent?.type === "for_statement" && parent.childForFieldName("body")?.id !== node.id);
  }

  private operatorOf(node: Node): string | undefined {
    return node.childForFieldName("operator")?.type;
  }

  private ifStatement(node: Node, level: number, depth: number, isElseIf: boolean): void {
    if (isElseIf) this.flat(node, "else if");
    else {
      this.flow(node, "if", level);
      this.nesting = Math.max(this.nesting, depth + 1);
    }
    this.decision(node, isElseIf ? "else if" : "if");
    const condition = node.childForFieldName("condition");
    if (condition !== null) this.visit(condition, level, depth);
    const consequence = node.childForFieldName("consequence");
    // An else-if sits at its if's depth, so every body in the chain is one level deeper than the chain.
    if (consequence !== null) this.visit(consequence, level + 1, depth + 1);
    const alternative = node.childForFieldName("alternative");
    if (alternative === null) return;
    const inner = alternative.namedChildren.find((child) => child.type !== "comment") ?? null;
    if (inner === null) return;
    if (inner.type === "if_statement") {
      this.statements++;
      this.ifStatement(inner, level, depth, true);
    } else {
      this.flat(alternative, "else");
      this.visit(inner, level + 1, depth + 1);
    }
  }

  private loop(node: Node, level: number, depth: number): void {
    const construct = loopNames[node.type] ?? node.type;
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
    const operators: { type: string; node: Node }[] = [];
    const operands: Node[] = [];
    const collect = (candidate: Node): void => {
      let inner = candidate;
      while (inner.type === "parenthesized_expression" && inner.namedChildCount === 1) inner = inner.namedChild(0)!;
      const operator = inner.type === "binary_expression" ? this.operatorOf(inner) : undefined;
      if (operator !== undefined && logicalOperators.has(operator)) {
        collect(inner.childForFieldName("left")!);
        operators.push({ type: operator, node: inner.childForFieldName("operator")! });
        collect(inner.childForFieldName("right")!);
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
    if (this.recursion || this.names.size === 0) return;
    const callee = call.childForFieldName("function");
    if (callee === null) return;
    const direct = callee.type === "identifier" && this.names.has(callee.text);
    const viaThis =
      callee.type === "member_expression" &&
      callee.childForFieldName("object")?.type === "this" &&
      this.names.has(callee.childForFieldName("property")?.text ?? "");
    if (direct || viaThis) {
      this.recursion = true;
      this.flat(call, "recursion");
    }
  }
}

function parameterCounts(fn: Node): { parameters: number; optionCount: number } {
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

/** Rows (0-based) of a file that hold code: any row a non-comment token touches. */
export function codeRowsOf(root: Node): boolean[] {
  const rows: boolean[] = new Array<boolean>(root.endPosition.row + 1).fill(false);
  const walk = (node: Node): void => {
    if (node.type === "comment") return;
    if (node.childCount === 0) {
      for (let row = node.startPosition.row; row <= node.endPosition.row; row++) rows[row] = true;
      return;
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  };
  walk(root);
  return rows;
}

/** Measures one function-like node. `fn` is the function itself, not the declaration that names it. */
export function measureFunction(fn: Node, options: MeasureOptions): Measured {
  const names = new Set<string>();
  if (options.name !== undefined) names.add(options.name);
  const own = fn.childForFieldName("name");
  if (own !== null && fn.type !== "method_definition") names.add(own.text);
  const measurer = new Measurer(options, names);
  measurer.function(fn);

  let length = 0;
  for (let line = options.startLine; line <= options.endLine; line++) if (options.codeRows[line - 1] === true) length++;
  const { parameters, optionCount } = parameterCounts(fn);
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
