import { compareIds } from "@code-health/graph/graph";
import { folderOf } from "@code-health/graph/tree-distance";
import {
  Node,
  SyntaxKind,
  type ArrowFunction,
  type Block,
  type CallExpression,
  type ExportedDeclarations,
  type FunctionDeclaration,
  type FunctionExpression,
  type ParameterDeclaration,
  type SourceFile,
} from "ts-morph";
import type { Candidate } from "./candidates.ts";
import type { TreeProject } from "./ts-project.ts";

/** The design red flags (see shared/red-flags.md) that a unit with many consumers can show. */
export type RedFlag = "divergent-use" | "overexposure" | "pass-through-method" | "shallow-module" | "special-general-mixture" | "vague-name";

export interface Finding {
  flag: RedFlag;
  /** The exported unit the finding is about, or the file when it is about the file as a whole. */
  subject: string;
  /** The evidence, stated with the counts it rests on. */
  detail: string;
  /** Consumer files the evidence comes from, sorted. */
  consumers: string[];
}

export type HintKind = "locale" | "mutates-argument" | "nondeterministic" | "swallows-errors" | "throws" | "time-zone";

/** A line of an exported unit that deserves a look under every caller's assumptions. The CLI cannot judge it. */
export interface Hint {
  kind: HintKind;
  subject: string;
  line: number;
  evidence: string;
}

export interface ParameterUse {
  name: string;
  optional: boolean;
  /** A boolean, or a union of string literals: a switch between behaviours. */
  mode: boolean;
  /** Call sites that pass an argument for it, out of the call sites of the unit. */
  passedBy: number;
  /** What call sites pass: each literal with its count, and `(expression)` for anything computed. */
  values: { value: string; count: number }[];
}

export interface PostProcessing {
  path: string;
  line: number;
  how: string;
}

export interface ExportReport {
  name: string;
  lines: number;
  parameters: ParameterUse[];
  /** Production call sites, and references that are not calls (passed as a value). */
  callSites: number;
  valueReferences: number;
  consumers: string[];
  /** Calls whose result the caller changes, falls back from or casts, and wrappers that fix arguments. */
  postProcessed: PostProcessing[];
  /** Calls in tests, kept apart because tests do not count as consumers. */
  testCallSites: number;
}

export interface Note {
  code: "consumers-in-one-folder";
  detail: string;
}

export interface Scrutiny {
  path: string;
  reason: "high-fan-in" | "requested";
  fanIn: number;
  rule: string;
  location: string;
  consumers: string[];
  consumerFolders: string[];
  findings: Finding[];
  hints: Hint[];
  notes: Note[];
  exports: ExportReport[];
}

type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression;

const literalKinds = new Set<SyntaxKind>([
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.StringLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
]);

function literalOf(node: Node): string | undefined {
  if (literalKinds.has(node.getKind())) return node.getText();
  if (Node.isIdentifier(node) && node.getText() === "undefined") return "undefined";
  return undefined;
}

function functionOf(declaration: ExportedDeclarations): FunctionLike | undefined {
  if (Node.isFunctionDeclaration(declaration)) return declaration;
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    if (initializer !== undefined && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) return initializer;
  }
  return undefined;
}

function isMode(parameter: ParameterDeclaration): boolean {
  const type = parameter.getTypeNode()?.getText() ?? "";
  if (/^boolean$/.test(type)) return true;
  if (/^(?:["'][^"'|]*["']\s*\|\s*)+["'][^"'|]*["']$/.test(type)) return true;
  const initializer = parameter.getInitializer()?.getText();
  return initializer === "true" || initializer === "false";
}

/** The call a reference sits in as its callee (`fn(...)` or `ns.fn(...)`), if it is one. */
function callOf(reference: Node): CallExpression | undefined {
  let callee: Node = reference;
  const parent = reference.getParent();
  if (parent !== undefined && Node.isPropertyAccessExpression(parent) && parent.getNameNode() === reference) callee = parent;
  const call = callee.getParent();
  return call !== undefined && Node.isCallExpression(call) && call.getExpression() === callee ? call : undefined;
}

function inImportOrExport(node: Node): boolean {
  return node.getFirstAncestor((ancestor) => Node.isImportSpecifier(ancestor) || Node.isExportSpecifier(ancestor) || Node.isImportClause(ancestor) || Node.isNamespaceImport(ancestor) || Node.isImportEqualsDeclaration(ancestor)) !== undefined;
}

/** How a caller changes what the unit returned, if it does. */
function postProcessing(call: CallExpression): string | undefined {
  let value: Node = call;
  for (let parent = value.getParent(); parent !== undefined && (Node.isAwaitExpression(parent) || Node.isParenthesizedExpression(parent)); parent = value.getParent()) value = parent;
  const parent = value.getParent();
  if (parent === undefined) return undefined;
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === value) return `.${parent.getName()}`;
  if (Node.isBinaryExpression(parent) && parent.getLeft() === value) {
    const operator = parent.getOperatorToken().getText();
    if (operator === "??" || operator === "||") return `${operator} fallback`;
  }
  if (Node.isNonNullExpression(parent)) return "non-null assertion";
  if (Node.isAsExpression(parent)) return `as ${parent.getTypeNode()?.getText() ?? "cast"}`;
  return undefined;
}

function withoutWrappers(node: Node | undefined): Node | undefined {
  let current = node;
  while (current !== undefined && (Node.isAwaitExpression(current) || Node.isParenthesizedExpression(current))) current = current.getExpression();
  return current;
}

/** The function that does nothing but return this call, when it fixes some of the arguments to literals. */
function fixingWrapper(call: CallExpression): string | undefined {
  const owner = call.getFirstAncestor((ancestor) => Node.isFunctionDeclaration(ancestor) || Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isMethodDeclaration(ancestor));
  if (owner === undefined || !(Node.isFunctionDeclaration(owner) || Node.isArrowFunction(owner) || Node.isFunctionExpression(owner) || Node.isMethodDeclaration(owner))) return undefined;
  const body = owner.getBody();
  if (body === undefined) return undefined;
  let returned: Node | undefined = body;
  if (Node.isBlock(body)) {
    const only = body.getStatements().length === 1 ? body.getStatements()[0] : undefined;
    returned = only !== undefined && Node.isReturnStatement(only) ? only.getExpression() : undefined;
  }
  if (withoutWrappers(returned) !== call) return undefined;
  // A wrapper hands its own parameters on and fixes the rest: partial application of the unit.
  const own = new Set(owner.getParameters().map((parameter) => parameter.getName()));
  const args = call.getArguments();
  if (!args.some((argument) => literalOf(argument) !== undefined)) return undefined;
  if (!args.some((argument) => Node.isIdentifier(argument) && own.has(argument.getText()))) return undefined;
  if (!args.every((argument) => literalOf(argument) !== undefined || (Node.isIdentifier(argument) && own.has(argument.getText())))) return undefined;
  const named = Node.isFunctionDeclaration(owner) || Node.isMethodDeclaration(owner) ? owner.getName() : owner.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getName();
  return `wrapper ${named ?? "(anonymous)"} fixes arguments`;
}

const hintPatterns: { kind: HintKind; pattern: RegExp }[] = [
  { kind: "locale", pattern: /\.toLocale\w*\(|\bIntl\.|\.localeCompare\(/ },
  { kind: "time-zone", pattern: /\bnew Date\(|\.(?:getHours|getMinutes|getDate|getDay|getMonth|getFullYear|setHours|setDate|toDateString|toTimeString)\(/ },
  { kind: "nondeterministic", pattern: /\bMath\.random\(|\bDate\.now\(|\bnew Date\(\)/ },
  { kind: "throws", pattern: /\bthrow\b/ },
  { kind: "swallows-errors", pattern: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/ },
];

function hintsOf(fn: FunctionLike, subject: string): Hint[] {
  const hints: Hint[] = [];
  const parameters = fn.getParameters().map((parameter) => parameter.getName()).filter((name) => /^[\w$]+$/.test(name));
  const text = fn.getBody()?.getFullText() ?? "";
  const first = fn.getBody()?.getStartLineNumber() ?? fn.getStartLineNumber();
  text.split("\n").forEach((line, offset) => {
    const lineNumber = first + offset;
    const code = line.replace(/\/\/.*$/, "");
    for (const { kind, pattern } of hintPatterns) if (pattern.test(code)) hints.push({ kind, subject, line: lineNumber, evidence: line.trim() });
    for (const name of parameters) {
      const mutating = new RegExp(`\\b${name.replace(/\$/g, "\\$")}(?:\\.(?:sort|reverse|push|pop|shift|unshift|splice|fill|copyWithin|set|delete|clear)\\(|(?:\\.[\\w$]+|\\[[^\\]]+\\])\\s*(?:[-+*/|&]?=)(?!=)|\\s*(?:\\+\\+|--))`);
      if (mutating.test(code) || new RegExp(`\\bdelete\\s+${name}\\b`).test(code)) hints.push({ kind: "mutates-argument", subject, line: lineNumber, evidence: line.trim() });
    }
  });
  // An error thrown on purpose and one that is caught are different hints, and a line gives each kind once.
  const seen = new Set<string>();
  return hints.filter((hint) => {
    const key = `${hint.kind}:${hint.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countValues(values: string[]): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || compareIds(a.value, b.value));
}

function describeValues(values: { value: string; count: number }[]): string {
  return values.map(({ value, count }) => `${value} x${count}`).join(", ");
}

function reportExport(
  name: string,
  fn: FunctionLike,
  declaration: ExportedDeclarations,
  root: SourceFile,
  tree: TreeProject,
  isTest: (path: string) => boolean,
): { report: ExportReport; calls: Array<{ path: string; argumentCount: number }> } {
  const parameters = fn.getParameters();
  const calls: Array<{ path: string; call: CallExpression }> = [];
  let valueReferences = 0;
  let testCallSites = 0;
  const finder = declaration as unknown as { findReferencesAsNodes(): Node[] };
  for (const reference of finder.findReferencesAsNodes()) {
    const path = tree.relative(reference.getSourceFile().getFilePath());
    if (reference.getSourceFile() === root || inImportOrExport(reference)) continue;
    const call = callOf(reference);
    if (isTest(path)) {
      if (call !== undefined) testCallSites++;
      continue;
    }
    if (call === undefined) valueReferences++;
    else calls.push({ path, call });
  }

  const postProcessed: PostProcessing[] = [];
  for (const { path, call } of calls) {
    const how = postProcessing(call) ?? fixingWrapper(call);
    if (how !== undefined) postProcessed.push({ path, line: call.getStartLineNumber(), how });
  }
  postProcessed.sort((a, b) => compareIds(a.path, b.path) || a.line - b.line);

  const uses = parameters.map((parameter, index): ParameterUse => {
    const values: string[] = [];
    for (const { call } of calls) {
      const argument = call.getArguments()[index];
      if (argument !== undefined) values.push(literalOf(argument) ?? "(expression)");
    }
    return {
      name: parameter.getName(),
      optional: parameter.isOptional() || parameter.hasInitializer(),
      mode: isMode(parameter),
      passedBy: values.length,
      values: countValues(values),
    };
  });
  const lines = fn.getEndLineNumber() - fn.getStartLineNumber() + 1;
  const report: ExportReport = {
    name,
    lines,
    parameters: uses,
    callSites: calls.length,
    valueReferences,
    consumers: [...new Set(calls.map((entry) => entry.path))].sort(compareIds),
    postProcessed,
    testCallSites,
  };
  return { report, calls: calls.map(({ path, call }) => ({ path, argumentCount: call.getArguments().length })) };
}

function findingsOf(report: ExportReport, fn: FunctionLike): Finding[] {
  const findings: Finding[] = [];
  const consumers = report.consumers;
  for (const parameter of report.parameters) {
    if (parameter.mode && report.callSites > 0) {
      const literal = parameter.values.filter((entry) => entry.value !== "(expression)");
      const only = parameter.values.length === 1 && literal.length === 1 && parameter.passedBy === report.callSites;
      findings.push({
        flag: "special-general-mixture",
        subject: report.name,
        detail: only
          ? `${parameter.name} switches behaviour, and every one of ${report.callSites} call sites passes ${literal[0]!.value}: the other branch serves no caller`
          : `${parameter.name} switches behaviour for different callers: ${describeValues(parameter.values)} over ${report.callSites} call sites`,
        consumers,
      });
    } else if (report.callSites >= 2 && parameter.passedBy * 2 < report.callSites && (parameter.optional || parameter.passedBy === 0)) {
      findings.push({
        flag: "overexposure",
        subject: report.name,
        detail: `${parameter.name} is passed by ${parameter.passedBy} of ${report.callSites} call sites: an option most callers never use`,
        consumers,
      });
    }
  }
  const processing = new Set(report.postProcessed.map((entry) => entry.path));
  if (processing.size >= 2) {
    const hows = [...new Set(report.postProcessed.map((entry) => entry.how))].sort(compareIds);
    findings.push({
      flag: "divergent-use",
      subject: report.name,
      detail: `${report.postProcessed.length} of ${report.callSites} call sites in ${processing.size} files change or work around what it returns (${hows.join(", ")}): it may be doing the wrong thing for them`,
      consumers: [...processing].sort(compareIds),
    });
  }
  const statements = Node.isBlock(fn.getBody()) ? (fn.getBody() as Block).getStatements().length : 1;
  if (report.parameters.length >= 2 && statements <= 1 && report.lines <= 4) {
    findings.push({
      flag: "shallow-module",
      subject: report.name,
      detail: `${report.parameters.length} parameters in front of a body of ${statements} statement over ${report.lines} lines: the interface is nearly as complex as what it hides`,
      consumers,
    });
  }
  return findings;
}

/**
 * The evidence for reviewing one widely used unit: the red flags that its interface and its call sites show,
 * with the counts they rest on, and the lines whose correctness depends on what every caller assumes. These
 * are findings for the agent to confirm or dismiss by reading the code, not verdicts.
 */
export function scrutinise(candidate: Candidate, reason: Scrutiny["reason"], tree: TreeProject, isTest: (path: string) => boolean): Scrutiny {
  const rootPath = candidate.unit.root;
  const root = tree.project.getSourceFile(tree.absolute(rootPath));
  const findings: Finding[] = [];
  const hints: Hint[] = [];
  const exports: ExportReport[] = [];

  if (root !== undefined) {
    for (const [name, declarations] of root.getExportedDeclarations()) {
      for (const declaration of declarations) {
        const fn = functionOf(declaration);
        if (fn === undefined) continue;
        const { report } = reportExport(name, fn, declaration, root, tree, isTest);
        exports.push(report);
        findings.push(...findingsOf(report, fn));
        hints.push(...hintsOf(fn, name));
      }
    }
  }
  // What the analyser already saw in the file, in the same vocabulary.
  for (const signal of candidate.signals) {
    if (signal.name === "pass-through") findings.push({ flag: "pass-through-method", subject: signal.detail, detail: "does nothing but call something else with the arguments it was given", consumers: [] });
    if (signal.name === "vague-name") findings.push({ flag: "vague-name", subject: rootPath, detail: `"${signal.detail}" says nothing about what the code is for`, consumers: [] });
  }

  const consumers = [...new Set(candidate.directCalls.concat(candidate.otherRefs).map((entry) => entry.path))].sort(compareIds);
  const consumerFolders = [...new Set(consumers.map(folderOf))].sort(compareIds);
  const notes: Note[] = [];
  if (consumers.length > 1 && consumerFolders.length === 1) {
    notes.push({
      code: "consumers-in-one-folder",
      detail: `every consumer sits in ${consumerFolders[0] === "" ? "the repository root" : consumerFolders[0]}: the unit may be misplaced rather than shared, so treat it as a move candidate once its interface is settled`,
    });
  }
  findings.sort((a, b) => compareIds(a.flag, b.flag) || compareIds(a.subject, b.subject) || compareIds(a.detail, b.detail));
  return {
    path: candidate.path,
    reason,
    fanIn: candidate.fanIn,
    rule: candidate.rule,
    location: candidate.location,
    consumers,
    consumerFolders,
    findings,
    hints,
    notes,
    exports: exports.sort((a, b) => compareIds(a.name, b.name)),
  };
}
