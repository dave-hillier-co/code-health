import { detectIndentUnit, levelOf } from "./indentation.ts";
import type { LexerProfile } from "./profile.ts";
import type { SourceLine } from "./strip.ts";

/**
 * An approximate function found without a parser. It has the same shape as a
 * structural unit so the two layers can be compared by start and end line.
 */
export interface FunctionBlock {
  /** 1-based, inclusive. For braces, the first line of the header after annotations; for Python, the `def` line. */
  startLine: number;
  /** 1-based, inclusive. The line of the closing brace, or the last body line for Python. */
  endLine: number;
  name?: string;
  /** Enclosing named scopes and the name, joined by dots. */
  qualifiedName?: string;
  source: "lexical";
}

interface Compiled {
  noise: RegExp[];
  control: RegExp;
  types: RegExp[];
  functions: RegExp[];
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
}

function findBracedBlocks(lines: SourceLine[], profile: LexerProfile): FunctionBlock[] {
  const closed: FunctionBlock[] = [];
  const stack: BraceScope[] = [];
  let header: Segment[] = [];
  let parenDepth = 0;

  for (const line of lines) {
    if (line.kind !== "code") continue;
    let segment = "";
    const code = line.code;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i]!;
      if (ch === "(" || ch === "[") parenDepth++;
      else if (ch === ")" || ch === "]") parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === ";" && parenDepth === 0) {
        header = [];
        segment = "";
        continue;
      } else if (ch === "{") {
        header.push({ line: line.number, text: segment });
        if (parenDepth > 0 && /[(,=:]\s*$/.test(header.map((part) => part.text).join(" "))) {
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
        stack.push({ name, block, parenDepth });
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
  }
  return closed;
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
    const continuation = bracketDepth > 0;
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
