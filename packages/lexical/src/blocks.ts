import { detectIndentUnit, levelOf } from "./indentation.ts";
import type { LexerProfile } from "./profile.ts";
import type { SourceLine } from "./strip.ts";
import type { UnitShape } from "./unit.ts";

/**
 * An approximate function found without a parser. It is a `UnitShape` (see unit.ts for how the two
 * layers are matched): `startLine` is the first header line after annotations, or the `def` line for
 * Python, and `endLine` is the closing brace line, or the last body line for Python.
 */
export interface FunctionBlock extends UnitShape {
  /** The unqualified name, when the header gives one. */
  name?: string;
  source: "lexical";
}

interface Compiled {
  noise: RegExp[];
  control: RegExp;
  types: RegExp[];
  functions: RegExp[];
  statementEnd: RegExp | undefined;
}

const compiledProfiles = new WeakMap<LexerProfile, Compiled>();

function compile(profile: LexerProfile): Compiled {
  let compiled = compiledProfiles.get(profile);
  if (compiled === undefined) {
    compiled = {
      noise: profile.headerNoise.map((source) => new RegExp(source)),
      control: new RegExp(profile.controlHeader),
      types: profile.typeHeaders.map((source) => new RegExp(source)),
      functions: profile.functionHeaders.map((source) => new RegExp(source)),
      statementEnd: profile.statementEnd === undefined ? undefined : new RegExp(profile.statementEnd),
    };
    compiledProfiles.set(profile, compiled);
  }
  return compiled;
}

interface Segment {
  line: number;
  text: string;
}

type Classification =
  | { kind: "other" }
  | { kind: "type"; name: string; line: number }
  | { kind: "function"; name: string | undefined; line: number };

/** Classifies the text that precedes an opening brace (or follows a `def`). */
function classifyHeader(segments: Segment[], profile: LexerProfile): Classification {
  const { noise, control, types, functions } = compile(profile);
  const kept = segments.filter((segment) => {
    const trimmed = segment.text.trim();
    return trimmed !== "" && !noise.some((pattern) => pattern.test(trimmed));
  });
  if (kept.length === 0) return { kind: "other" };
  const text = kept.map((segment) => segment.text.trim()).join(" ").replace(/\s+/g, " ");
  const line = kept[0]!.line;
  if (control.test(text)) return { kind: "other" };
  for (const pattern of types) {
    const match = pattern.exec(text);
    if (match?.groups?.name !== undefined) return { kind: "type", name: cleanName(match.groups.name), line };
  }
  for (const pattern of functions) {
    const match = pattern.exec(text);
    if (match !== null) {
      const name = match.groups?.name;
      return { kind: "function", name: name === undefined ? undefined : cleanName(name), line };
    }
  }
  return { kind: "other" };
}

function cleanName(name: string): string {
  return name.replace(/<[^>]*>/g, "").replace(/[.:]+$/, "");
}

export function findFunctionBlocks(lines: SourceLine[], profile: LexerProfile): FunctionBlock[] {
  const blocks =
    profile.blocks === "indentation" ? findIndentedBlocks(lines, profile) : findBracedBlocks(lines, profile);
  return blocks.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}

function qualify(scopes: string[], name: string | undefined): string | undefined {
  return name === undefined ? undefined : [...scopes, name].join(".");
}

interface BraceScope {
  name: string | undefined;
  block: FunctionBlock | undefined;
  parenDepth: number;
  /** For a brace inside a parameter list or argument list: the header to resume once it closes. */
  resume?: Segment[];
  /** An interface or type alias body, where `name: (a) => b` is a type, not a function. */
  typeOnly?: boolean;
}

/** An arrow function whose body is an expression, open until the expression ends. */
interface OpenArrow {
  block: FunctionBlock;
  /** Depth of `stack` where it started: the expression ends when it would be left. */
  scopes: number;
  /** Last line holding part of the expression. */
  lastLine: number;
  /** Part of a `const` declaration, whose next declarator is bound the same way. */
  declaration: boolean;
}

const modifiers = "(?:(?:public|private|protected|static|readonly|override|declare|export)\\s+)*";
const boundArrow = [
  // `const f = (a) =>`, `export const f: Fn = async (a) =>`, and a class field `handler = (a) =>`.
  new RegExp(
    `^${modifiers}(?:(?:const|let|var)\\s+)?(?<name>[#\\w$]+)\\s*(?::(?:[^=]|=>)*?)?=(?!>)\\s*(?:async\\s+)?(?:<[^>]*>\\s*)?(?:\\([^]*\\)|[\\w$]+)\\s*(?::\\s*[^=]+)?$`,
  ),
  // An object literal property `key: (a) =>`.
  /^(?<name>[#\w$]+|\[[^\]]+\])\s*:\s*(?:async\s+)?(?:<[^>]*>\s*)?(?:\([^]*\)|[\w$]+)\s*(?::\s*[^=]+)?$/,
  // `export default (a) =>`, which has no name.
  /^export\s+default\s+(?:async\s+)?(?:<[^>]*>\s*)?(?:\([^]*\)|[\w$]+)\s*(?::\s*[^=]+)?$/,
];
const keywordAssignment = /^(?:export\s+)?(?:const|let|var)\b/;
const continuesExpression = /[-+*/%&|^?:=<>.,([!~]$/;
const continuesFromStart = /^[-+*/%&|^?:=<>.)\]]/;

function angleBalanced(text: string): boolean {
  const flat = text.replace(/=>|->/g, "");
  return (flat.match(/</g)?.length ?? 0) <= (flat.match(/>/g)?.length ?? 0);
}

function findBracedBlocks(lines: SourceLine[], profile: LexerProfile): FunctionBlock[] {
  const closed: FunctionBlock[] = [];
  const stack: BraceScope[] = [];
  const codeLines = lines.filter((line) => line.kind === "code");
  let header: Segment[] = [];
  let parenDepth = 0;
  let arrow: OpenArrow | undefined;
  /** Between the declarators of one `const a = 1, b = 2;`, so `b` is bound like `a`. */
  let inDeclaration = false;

  const { statementEnd } = compile(profile);
  /** A line break ends a statement in a profile with automatic semicolons, when the line is complete. */
  const endsStatement = (line: SourceLine): boolean => {
    const code = line.code.trimEnd();
    if (statementEnd === undefined || code === "") return false;
    // Strings are blanked in `code`, so a line that ends in one is told by the text after its last code character.
    return /^["'`]/.test(line.text.slice(code.length).trimStart()) || statementEnd.test(code);
  };

  const headerText = (extra: string) =>
    [...header.map((part) => part.text), extra].join(" ").replace(/\s+/g, " ").trim();

  const closeArrow = (): void => {
    if (arrow === undefined) return;
    arrow.block.endLine = arrow.lastLine;
    closed.push(arrow.block);
    arrow = undefined;
  };

  /** Called at an `=>`: opens a block when it is bound to a name and its body is an expression. */
  const openArrow = (before: string, line: SourceLine, column: number, index: number): boolean => {
    const rest = line.code.slice(column + 1).trim();
    const nextLine = codeLines[index + 1]?.code.trim();
    if (rest.startsWith("{") || (rest === "" && nextLine?.startsWith("{"))) return false;
    const top = stack[stack.length - 1];
    if (top?.typeOnly === true || parenDepth > 0) return false;
    const kept = [...header, { line: line.number, text: before }].filter((part) => part.text.trim() !== "");
    if (kept.length === 0) return false;
    const text = kept.map((part) => part.text.trim()).join(" ").replace(/\s+/g, " ");
    let name: string | undefined;
    let matched = false;
    for (const [i, pattern] of boundArrow.entries()) {
      const match = pattern.exec(text);
      if (match === null) continue;
      // `handler = () =>` without a keyword is a field only inside a class; `key: () =>` only in an object literal.
      if (i === 0 && !inDeclaration && !keywordAssignment.test(text) && top?.name === undefined) continue;
      if (i === 1 && (top === undefined || top.name !== undefined)) continue;
      name = match.groups?.name;
      matched = true;
      break;
    }
    if (!matched) return false;
    const names = stack.flatMap((scope) => (scope.name === undefined ? [] : [scope.name]));
    const block: FunctionBlock = { startLine: kept[0]!.line, endLine: -1, source: "lexical" };
    if (name !== undefined) {
      block.name = cleanName(name);
      block.qualifiedName = qualify(names, block.name)!;
    }
    arrow = { block, scopes: stack.length, lastLine: line.number, declaration: inDeclaration || keywordAssignment.test(text) };
    return true;
  };

  for (const [index, line] of codeLines.entries()) {
    let segment = "";
    const code = line.code;
    // A declaration without a semicolon ends where the next one begins.
    if (profile.expressionArrows === true && arrow === undefined && parenDepth === 0 && keywordAssignment.test(code.trim())) {
      header = [];
      inDeclaration = false;
    }
    for (let i = 0; i < code.length; i++) {
      const ch = code[i]!;
      if (arrow !== undefined && ch.trim() !== "") arrow.lastLine = line.number;
      if (arrow !== undefined && parenDepth === 0 && stack.length === arrow.scopes) {
        if (ch === ";" || ch === ",") {
          inDeclaration = ch === "," && arrow.declaration;
          closeArrow();
          header = [];
          segment = "";
          continue;
        }
        if (ch === "}") {
          arrow.lastLine = Math.max(arrow.block.startLine, arrow.lastLine === line.number && segment.trim() === "" ? previousCodeLine(codeLines, index) : line.number);
          closeArrow();
        }
      }
      if (ch === "(" || ch === "[") parenDepth++;
      else if (ch === ")" || ch === "]") {
        if (arrow !== undefined && parenDepth === 0 && stack.length === arrow.scopes) {
          arrow.lastLine = segment.trim() === "" ? previousCodeLine(codeLines, index) : line.number;
          closeArrow();
        }
        parenDepth = Math.max(0, parenDepth - 1);
      } else if (ch === "=" && code[i + 1] === ">" && profile.expressionArrows === true && arrow === undefined) {
        if (openArrow(segment, line, i + 1, index)) {
          segment += "=>";
          i++;
          continue;
        }
      } else if (ch === ";" && parenDepth === 0) {
        inDeclaration = false;
        header = [];
        segment = "";
        continue;
      } else if (
        ch === "," &&
        parenDepth === 0 &&
        profile.expressionArrows === true &&
        arrow === undefined &&
        !/\b(?:class|interface|implements|extends|enum|namespace|type)\b/.test(headerText(segment)) &&
        angleBalanced(headerText(segment))
      ) {
        inDeclaration = inDeclaration || keywordAssignment.test(headerText(segment));
        header = [];
        segment = "";
        continue;
      } else if (ch === "{") {
        header.push({ line: line.number, text: segment });
        if (parenDepth > 0 && /(?:[(,=:]|\b(?:struct|interface))\s*$/.test(header.map((part) => part.text).join(" "))) {
          // A destructuring pattern, default value, type literal or object argument, not a body.
          stack.push({ name: undefined, block: undefined, parenDepth, resume: header });
          header = [];
          segment = "";
          continue;
        }
        const classification = classifyHeader(header, profile);
        const names = stack.flatMap((scope) => (scope.name === undefined ? [] : [scope.name]));
        let block: FunctionBlock | undefined;
        let name: string | undefined;
        if (classification.kind === "function") {
          name = classification.name;
          block = { startLine: classification.line, endLine: -1, source: "lexical" };
          if (name !== undefined) {
            block.name = name;
            block.qualifiedName = qualify(names, name)!;
          }
        } else if (classification.kind === "type") name = classification.name;
        const typeOnly = /^(?:export\s+)?(?:declare\s+)?(?:interface|type)\b/.test(headerText(""));
        stack.push({ name, block, parenDepth, ...(typeOnly ? { typeOnly } : {}) });
        header = [];
        segment = "";
        continue;
      } else if (ch === "}") {
        const scope = stack.pop();
        if (scope?.resume !== undefined) {
          parenDepth = scope.parenDepth;
          header = scope.resume;
          segment = "{}";
          continue;
        }
        if (scope !== undefined) {
          parenDepth = scope.parenDepth;
          if (scope.block !== undefined) {
            scope.block.endLine = line.number;
            closed.push(scope.block);
          }
        }
        header = [];
        segment = "";
        continue;
      }
      segment += ch;
    }
    header.push({ line: line.number, text: segment });
    if (parenDepth === 0 && arrow === undefined && endsStatement(line)) header = [];
    if (arrow !== undefined && parenDepth === 0 && stack.length === arrow.scopes) {
      const text = code.trimEnd();
      const following = codeLines[index + 1]?.code.trim() ?? "";
      if (text !== "" && !continuesExpression.test(text) && !continuesFromStart.test(following)) {
        closeArrow();
        header = [];
      }
    }
  }
  if (arrow !== undefined) closeArrow();
  return closed;
}

function previousCodeLine(codeLines: SourceLine[], index: number): number {
  return codeLines[Math.max(0, index - 1)]!.number;
}

interface IndentScope {
  level: number;
  name: string | undefined;
  block: FunctionBlock | undefined;
}

function findIndentedBlocks(lines: SourceLine[], profile: LexerProfile): FunctionBlock[] {
  const unit = detectIndentUnit(lines);
  const closed: FunctionBlock[] = [];
  const stack: IndentScope[] = [];
  let lastBodyLine = 0;
  let bracketDepth = 0;
  let backslashContinued = false;

  const close = (scope: IndentScope) => {
    if (scope.block === undefined) return;
    scope.block.endLine = Math.max(lastBodyLine, scope.block.startLine);
    closed.push(scope.block);
  };

  for (const line of lines) {
    if (line.kind === "literal") {
      lastBodyLine = line.number;
      continue;
    }
    if (line.kind !== "code") continue;
    const continuation = bracketDepth > 0 || backslashContinued;
    backslashContinued = line.code.trimEnd().endsWith("\\");
    for (const ch of line.code) {
      if (ch === "(" || ch === "[" || ch === "{") bracketDepth++;
      else if (ch === ")" || ch === "]" || ch === "}") bracketDepth = Math.max(0, bracketDepth - 1);
    }
    if (continuation || line.startsInLiteral) {
      lastBodyLine = line.number;
      continue;
    }
    const level = levelOf(line.text, unit);
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) close(stack.pop()!);
    const classification = classifyHeader([{ line: line.number, text: line.code }], profile);
    if (classification.kind !== "other") {
      const names = stack.flatMap((scope) => (scope.name === undefined ? [] : [scope.name]));
      let block: FunctionBlock | undefined;
      if (classification.kind === "function") {
        block = { startLine: line.number, endLine: -1, source: "lexical" };
        if (classification.name !== undefined) {
          block.name = classification.name;
          block.qualifiedName = qualify(names, classification.name)!;
        }
      }
      stack.push({ level, name: classification.name, block });
    }
    lastBodyLine = line.number;
  }
  while (stack.length > 0) close(stack.pop()!);
  return closed;
}
