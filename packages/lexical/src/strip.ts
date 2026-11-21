import type { DelimitedString, LexerProfile, StringRule, WholeLiteral } from "./profile.ts";

/**
 * - blank: nothing but whitespace.
 * - comment: only comment text (or whitespace around it).
 * - literal: a continuation line inside a multi-line string, whose indentation is content.
 * - code: anything else, including lines whose only code is a string.
 */
export type LineKind = "blank" | "comment" | "literal" | "code";

export interface SourceLine {
  /** 1-based. */
  number: number;
  text: string;
  /** The line with comments and string literals replaced by spaces. */
  code: string;
  kind: LineKind;
  /** The line begins inside a multi-line string, so its leading whitespace is string content. */
  startsInLiteral: boolean;
}

export function normaliseNewlines(content: string): string {
  const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return withoutBom.replace(/\r\n?/g, "\n");
}

const NONE = 0;
const COMMENT = 1;
const STRING = 2;

interface CompiledDelimited {
  rule: DelimitedString;
  open: RegExp;
}
interface CompiledWhole {
  rule: WholeLiteral;
  pattern: RegExp;
}

type CompiledRule = CompiledDelimited | CompiledWhole;

const compiledProfiles = new WeakMap<LexerProfile, CompiledRule[]>();

function compileRules(profile: LexerProfile): CompiledRule[] {
  const cached = compiledProfiles.get(profile);
  if (cached !== undefined) return cached;
  const compiled = profile.strings.map((rule: StringRule): CompiledRule =>
    rule.kind === "delimited"
      ? { rule, open: new RegExp(rule.open, "y") }
      : { rule, pattern: new RegExp(rule.pattern, "y") },
  );
  compiledProfiles.set(profile, compiled);
  return compiled;
}

/**
 * Splits content into lines and classifies each one, blanking comments and
 * string literals in `code`. Without a profile only blank and code are told
 * apart, because comment syntax is unknown.
 */
export function stripSource(rawContent: string, profile?: LexerProfile): SourceLine[] {
  const content = normaliseNewlines(rawContent);
  const mask = profile === undefined ? new Uint8Array(content.length) : maskLiterals(content, profile);

  const lines: SourceLine[] = [];
  let start = 0;
  let number = 1;
  while (start <= content.length) {
    let end = content.indexOf("\n", start);
    if (end === -1) end = content.length;
    if (end === content.length && start === content.length && start > 0) break;
    const text = content.slice(start, end);
    let code = "";
    let sawComment = false;
    for (let i = start; i < end; i++) {
      if (mask[i] === NONE) code += content[i];
      else {
        code += " ";
        if (mask[i] === COMMENT) sawComment = true;
      }
    }
    const startsInString = start > 0 && mask[start - 1] === STRING;
    let kind: LineKind;
    if (text.trim() === "") kind = "blank";
    else if (startsInString && code.trim() === "") kind = "literal";
    else if (code.trim() !== "") kind = "code";
    else kind = sawComment || (start > 0 && mask[start - 1] === COMMENT) ? "comment" : "code";
    lines.push({ number, text, code, kind, startsInLiteral: startsInString });
    number++;
    start = end + 1;
  }
  return lines;
}

function maskLiterals(content: string, profile: LexerProfile): Uint8Array {
  const mask = new Uint8Array(content.length);
  const rules = compileRules(profile);
  const triggers = new Set<string>();
  for (const comment of profile.lineComments) triggers.add(comment[0]!);
  for (const comment of profile.blockComments) triggers.add(comment.open[0]!);
  for (const { rule } of rules) for (const ch of rule.triggers) triggers.add(ch);

  scan(0, false);
  return mask;

  /**
   * Scans code from `from`. With `untilBrace` set, stops at the unmatched
   * closing brace of a template interpolation and returns its index.
   */
  function scan(from: number, untilBrace: boolean, closer = "}"): number {
    let depth = 0;
    let i = from;
    while (i < content.length) {
      const ch = content[i]!;
      if (untilBrace) {
        if (ch === "{") depth++;
        else if (content.startsWith(closer, i)) {
          if (depth === 0) return i;
          depth--;
        }
      }
      if (!triggers.has(ch)) {
        i++;
        continue;
      }
      const skipped = tryLiteral(i);
      i = skipped > i ? skipped : i + 1;
    }
    return i;
  }

  /** Masks a comment or string starting at `i` and returns the index after it, or `i` if none starts there. */
  function tryLiteral(i: number): number {
    for (const comment of profile.lineComments) {
      if (content.startsWith(comment, i)) {
        let end = content.indexOf("\n", i);
        if (end === -1) end = content.length;
        mask.fill(COMMENT, i, end);
        return end;
      }
    }
    for (const comment of profile.blockComments) {
      if (content.startsWith(comment.open, i)) return maskBlockComment(i, comment.open, comment.close, comment.nested === true);
    }
    for (const compiled of rules) {
      if ("pattern" in compiled) {
        compiled.pattern.lastIndex = i;
        const match = compiled.pattern.exec(content);
        if (match !== null) {
          mask.fill(STRING, i, i + match[0].length);
          return i + match[0].length;
        }
      } else {
        compiled.open.lastIndex = i;
        const match = compiled.open.exec(content);
        if (match !== null) return maskDelimited(i, match, compiled.rule);
      }
    }
    return i;
  }

  function maskBlockComment(from: number, open: string, close: string, nested: boolean): number {
    let depth = 1;
    let i = from + open.length;
    while (i < content.length) {
      if (nested && content.startsWith(open, i)) {
        depth++;
        i += open.length;
      } else if (content.startsWith(close, i)) {
        depth--;
        i += close.length;
        if (depth === 0) break;
      } else i++;
    }
    mask.fill(COMMENT, from, i);
    return i;
  }

  function maskDelimited(from: number, opener: RegExpExecArray, rule: DelimitedString): number {
    const close = rule.close.replace("$1", opener[1] ?? "");
    let i = from + opener[0].length;
    let segmentStart = from;
    const finish = (end: number): number => {
      mask.fill(STRING, segmentStart, end);
      return end;
    };
    while (i < content.length) {
      const ch = content[i]!;
      if (rule.escape !== undefined && ch === rule.escape) {
        i += 2;
        continue;
      }
      if (ch === "\n" && !rule.multiline) return finish(i);
      if (rule.doubledCloseEscapes === true && content.startsWith(close + close, i)) {
        i += close.length * 2;
        continue;
      }
      if (content.startsWith(close, i)) return finish(i + close.length);
      if (rule.interpolation !== undefined && content.startsWith(rule.interpolation.open, i)) {
        // Text so far is string; the interpolated expression is code.
        const innerStart = i + rule.interpolation.open.length;
        const innerEnd = scan(innerStart, true, rule.interpolation.close);
        mask.fill(STRING, segmentStart, innerStart);
        // The closing brace of the interpolation is string text again.
        i = Math.min(innerEnd, content.length);
        segmentStart = i;
        continue;
      }
      i++;
    }
    // Unterminated: everything to the end is the literal.
    return finish(Math.min(i, content.length));
  }
}
