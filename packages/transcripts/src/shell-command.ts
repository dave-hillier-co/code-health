/**
 * Reads the files a shell command line names. A command line is split into words, operators and redirections,
 * and the commands it holds are matched against a fixed table of commands that read or edit files. Nothing is
 * run, expanded or looked up on disk.
 *
 * A command line is parsed when every command in it was understood: its words are literal (or a variable the
 * line itself set with a literal value or a literal `for` list), and no construct hides a command from the
 * tokenizer. A line that is not parsed yields no paths at all and is counted as unparsed by the caller. These are
 * not parsed: command substitution (`$(...)`, backticks, `<(...)`), `if`, `while`, `until`, `case`, `select` and
 * function definitions, `eval`, `xargs`, `source`, `bash -c` and the like, `find` with `-exec` or `-delete`,
 * inline code given to an interpreter (`python3 -c`, `node -e`, a here-doc or `-` for stdin), and any file
 * operand of a known command that holds a variable, a command substitution or (for an edit) a glob.
 *
 * A command that is not in the table (`ls`, `git status`, `npm test`) is understood and reads or edits nothing
 * that is counted. Where a command names a path, a glob operand is a search, and a literal operand is a read or an
 * edit. A literal operand is taken to be a file for `grep -r`, `rg`, `diff -r` and an interpreter's script
 * only when its last segment has an extension; otherwise it is a directory and counts as a search (for the
 * interpreter, as nothing).
 */
import { posix } from "node:path";

/** Paths exactly as resolved against the working directory, not yet mapped to the repo. */
export interface ShellAccess {
  reads: string[];
  /** Paths searched: globs, directories and the working directory. `null` is the working directory when none was recorded. */
  searches: (string | null)[];
  edits: string[];
}

interface Word {
  t: "word";
  /** The text with quotes removed. A `$` that is not an expansion is written as \u0001 until the word is read. */
  text: string;
  dynamic: boolean;
  glob: boolean;
  quoted: boolean;
}
interface Operator {
  t: "op";
  op: string;
}
type Token = Word | Operator;

const LITERAL_DOLLAR = "\u0001";
const plain = (word: Word): string => word.text.replaceAll(LITERAL_DOLLAR, "$");

const OPERATORS = ["&>>", "<<<", "<<-", "&&", "||", "|&", ";;", "<<", ">>", ">&", ">|", "&>", "<&", ";", "|", "&", "(", ")", ">", "<"];

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  const pending: { delimiter: string; strip: boolean }[] = [];
  let expectDelimiter: { strip: boolean } | null = null;
  let text = "";
  let unquoted = "";
  let inWord = false;
  let dynamic = false;
  let glob = false;
  let quoted = false;
  let i = 0;

  const flush = (): void => {
    if (!inWord) return;
    const hasBrace = /\{[^{}]*(,|\.\.)[^{}]*\}/.test(unquoted);
    const word: Word = { t: "word", text, dynamic: dynamic || hasBrace, glob, quoted };
    if (!word.dynamic) word.text = plain(word);
    if (expectDelimiter !== null) {
      pending.push({ delimiter: plain(word), strip: expectDelimiter.strip });
      expectDelimiter = null;
    } else {
      tokens.push(word);
    }
    text = "";
    unquoted = "";
    inWord = false;
    dynamic = false;
    glob = false;
    quoted = false;
  };
  const add = (char: string, isQuoted: boolean): void => {
    inWord = true;
    text += char;
    if (!isQuoted) unquoted += char;
    else quoted = true;
  };

  // Reads a `$` expansion starting at source[i] === "$". Returns false when the text cannot be tokenized.
  const dollar = (insideDouble: boolean): boolean => {
    const next = source[i + 1];
    if (next === "(") return false;
    if (next === "'" && !insideDouble) {
      dynamic = true;
      inWord = true;
      text += "$";
      i++;
      return true;
    }
    inWord = true;
    if (next === "{") {
      dynamic = true;
      const end = source.indexOf("}", i);
      if (end === -1) return false;
      text += source.slice(i, end + 1);
      i = end + 1;
      return true;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i + 1));
    if (name !== null) {
      dynamic = true;
      text += `$${name[0]}`;
      i += 1 + name[0].length;
      return true;
    }
    if (next === undefined || /\s|["'`]/.test(next)) {
      // A bare `$` is literal.
      text += LITERAL_DOLLAR;
      i++;
      return true;
    }
    dynamic = true;
    text += `$${next}`;
    i += 2;
    return true;
  };

  while (i < source.length) {
    const char = source[i]!;
    if (char === "\\" && source[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      flush();
      i++;
      continue;
    }
    if (char === "\n") {
      flush();
      tokens.push({ t: "op", op: "\n" });
      i++;
      for (const heredoc of pending.splice(0)) {
        while (i < source.length) {
          let end = source.indexOf("\n", i);
          if (end === -1) end = source.length;
          const line = source.slice(i, end);
          i = Math.min(end + 1, source.length);
          if ((heredoc.strip ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;
        }
      }
      continue;
    }
    if (char === "#" && !inWord) {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (char === "'") {
      const end = source.indexOf("'", i + 1);
      if (end === -1) return null;
      inWord = true;
      quoted = true;
      text += source.slice(i + 1, end).replaceAll("$", LITERAL_DOLLAR);
      i = end + 1;
      continue;
    }
    if (char === '"') {
      inWord = true;
      quoted = true;
      i++;
      let closed = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === "`") return null;
        if (c === "\\" && i + 1 < source.length) {
          const escaped = source[i + 1]!;
          if (escaped === "\n") {
            i += 2;
          } else if ('"\\$`'.includes(escaped)) {
            text += escaped === "$" ? LITERAL_DOLLAR : escaped;
            i += 2;
          } else {
            text += `\\${escaped}`;
            i += 2;
          }
          continue;
        }
        if (c === "$") {
          if (!dollar(true)) return null;
          continue;
        }
        text += c;
        i++;
      }
      if (!closed) return null;
      continue;
    }
    if (char === "\\") {
      if (i + 1 >= source.length) return null;
      add(source[i + 1] === "$" ? LITERAL_DOLLAR : source[i + 1]!, true);
      i += 2;
      continue;
    }
    if (char === "`") return null;
    if (char === "$") {
      if (!dollar(false)) return null;
      continue;
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (operator !== undefined) {
      if ((operator === "<" || operator === ">") && source[i + 1] === "(") return null;
      const redirect = /^[0-9<>&|]/.test(operator) && operator !== "&&" && operator !== "||" && operator !== "|" && operator !== "|&" && operator !== "&";
      if (redirect && inWord && /^[0-9]+$/.test(text) && unquoted === text) {
        text = "";
        unquoted = "";
        inWord = false;
        quoted = false;
      }
      flush();
      if (operator === "<<" || operator === "<<-") expectDelimiter = { strip: operator === "<<-" };
      tokens.push({ t: "op", op: operator });
      i += operator.length;
      continue;
    }
    if (char === "*" || char === "?" || char === "[") glob = true;
    add(char, false);
    i++;
  }
  flush();
  return tokens;
}

interface Redirect {
  op: string;
  target: Word | null;
}
interface Command {
  words: Word[];
  redirects: Redirect[];
  heredoc: boolean;
  /** The operator that ended the command: a separator, or "" at the end of the line. */
  separator: string;
  marker: "(" | ")" | null;
}

const SEPARATORS = new Set(["&&", "||", ";", "|", "|&", "&", "\n"]);
const REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", ">&", "<", "<&", "<<", "<<-", "<<<"]);

function segment(tokens: readonly Token[]): Command[] | null {
  const commands: Command[] = [];
  let current: Command = { words: [], redirects: [], heredoc: false, separator: "", marker: null };
  let awaiting: Redirect | null = null;
  const end = (separator: string): void => {
    if (current.words.length > 0 || current.redirects.length > 0) {
      current.separator = separator;
      commands.push(current);
    } else if (separator !== "\n" && separator !== ";" && commands.length > 0) {
      commands.at(-1)!.separator = separator;
    }
    current = { words: [], redirects: [], heredoc: false, separator: "", marker: null };
  };
  for (const token of tokens) {
    if (token.t === "word") {
      if (awaiting !== null) {
        awaiting.target = token;
        awaiting = null;
      } else {
        current.words.push(token);
      }
      continue;
    }
    if (awaiting !== null && !awaiting.op.startsWith("<<")) return null;
    if (REDIRECTS.has(token.op)) {
      if (token.op === "<<" || token.op === "<<-") {
        // The delimiter is consumed by the tokenizer and the body skipped, so there is no target word.
        current.heredoc = true;
        continue;
      }
      awaiting = { op: token.op, target: null };
      current.redirects.push(awaiting);
      if (token.op === "<<<") current.heredoc = true;
    } else if (token.op === "(" || token.op === ")") {
      end("");
      commands.push({ words: [], redirects: [], heredoc: false, separator: "", marker: token.op });
    } else if (SEPARATORS.has(token.op)) {
      end(token.op);
    } else {
      return null;
    }
  }
  if (awaiting !== null) return null;
  end("");
  return commands;
}

const SKIPPED_KEYWORDS = new Set(["do", "{", "}", "!"]);
const UNPARSED_KEYWORDS = new Set(["if", "elif", "else", "fi", "then", "while", "until", "case", "esac", "select", "function", "coproc", "in"]);
const HIDING_COMMANDS = new Set(["eval", "xargs", "source", ".", "exec", "parallel", "watch", "nohup", "setsid", "timeout"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = new Set(["python", "python3", "node", "ruby", "tsx", "ts-node", "deno", "bun"]);
const WRAPPERS = new Set(["time", "command", "env", "sudo", "builtin"]);
const READERS = new Set(["cat", "tac", "head", "tail", "less", "more", "wc", "nl", "od", "xxd", "bat"]);

interface OptionSpec {
  /** Short options that take a value. */
  valueShort?: string;
  /** Long options that take a value in the next word. */
  valueLong?: readonly string[];
  /** A short option after which the rest of the cluster is its value, as in `sed -i.bak`. */
  suffixShort?: string;
}
interface ParsedArgs {
  flags: Set<string>;
  values: { name: string; value: string | null }[];
  operands: Word[];
}

function parseArgs(args: readonly Word[], spec: OptionSpec): ParsedArgs | null {
  const flags = new Set<string>();
  const values: ParsedArgs["values"] = [];
  const operands: Word[] = [];
  let ended = false;
  for (let k = 0; k < args.length; k++) {
    const word = args[k]!;
    const text = plain(word);
    if (ended || word.quoted || !text.startsWith("-") || text === "-") {
      operands.push(word);
      continue;
    }
    if (word.dynamic) return null;
    if (text === "--") {
      ended = true;
    } else if (text.startsWith("--")) {
      const equals = text.indexOf("=");
      const name = equals === -1 ? text : text.slice(0, equals);
      flags.add(name);
      if (equals !== -1) {
        values.push({ name, value: text.slice(equals + 1) });
      } else if (spec.valueLong?.includes(name)) {
        const next = args[k + 1];
        if (next === undefined) return null;
        values.push({ name, value: plain(next) });
        k++;
      }
    } else {
      for (let c = 1; c < text.length; c++) {
        const char = text[c]!;
        flags.add(char);
        if (spec.suffixShort === char) break;
        if (spec.valueShort?.includes(char)) {
          const rest = text.slice(c + 1);
          if (rest !== "") {
            values.push({ name: char, value: rest });
          } else {
            const next = args[k + 1];
            if (next === undefined) return null;
            values.push({ name: char, value: plain(next) });
            k++;
          }
          break;
        }
      }
    }
  }
  return { flags, values, operands };
}

const GREP_VALUE_LONG = ["--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--include", "--exclude", "--exclude-dir", "--exclude-from", "--label", "--directories", "--devices", "--binary-files"];
const RG_VALUE_LONG = ["--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--max-count", "--after-context", "--before-context", "--context", "--threads", "--max-columns", "--max-depth", "--replace", "--ignore-file", "--pre", "--sort", "--sortr", "--encoding", "--type-add"];

const looksLikeFile = (text: string): boolean => {
  const last = text.split("/").at(-1) ?? "";
  return last !== "" && last !== "." && last !== ".." && last.includes(".") && !last.endsWith(".");
};

const endsLikeDirectory = (text: string): boolean => text.endsWith("/");

class Interpretation {
  readonly access: ShellAccess = { reads: [], searches: [], edits: [] };
  ok = true;
  /** The working directory: a path, undefined when none was recorded (relative paths stay relative), null when lost. */
  cwd: string | null | undefined;
  readonly stack: (string | null | undefined)[] = [];
  readonly variables = new Map<string, string>();

  constructor(cwd: string | null) {
    this.cwd = cwd === null ? undefined : cwd;
  }

  fail(): void {
    this.ok = false;
  }

  /** The path a literal word names, resolved against the working directory. Null (and the line is unparsed) when it cannot be. */
  resolve(text: string): string | null {
    if (text.startsWith("/") || text.startsWith("~") || /^[A-Za-z]:[\\/]/.test(text)) return text;
    if (this.cwd === null) {
      this.fail();
      return null;
    }
    return this.cwd === undefined ? text : posix.join(this.cwd, text);
  }

  substitute(word: Word): Word {
    if (!word.dynamic || !word.text.includes("$")) return word;
    const replaced = word.text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced: string | undefined, bare: string | undefined) => {
      const value = this.variables.get((braced ?? bare) as string);
      return value === undefined ? whole : value.replaceAll("$", LITERAL_DOLLAR);
    });
    const dynamic = replaced.includes("$");
    return { ...word, text: dynamic ? replaced : replaced.replaceAll(LITERAL_DOLLAR, "$"), dynamic };
  }

  /** A path operand of a command that reads or edits: dynamic words make the line unparsed. */
  operand(word: Word): { path: string; glob: boolean } | null {
    if (word.dynamic) {
      this.fail();
      return null;
    }
    const path = this.resolve(plain(word));
    return path === null ? null : { path, glob: word.glob && !word.quoted };
  }

  read(word: Word): void {
    const operand = this.operand(word);
    if (operand === null || plain(word) === "-") return;
    if (operand.glob) this.access.searches.push(operand.path);
    else this.access.reads.push(operand.path);
  }

  search(word: Word | null): void {
    if (word === null) {
      if (this.cwd === null) this.fail();
      else this.access.searches.push(this.cwd ?? null);
      return;
    }
    const operand = this.operand(word);
    if (operand !== null) this.access.searches.push(operand.path);
  }

  edit(word: Word): void {
    const operand = this.operand(word);
    if (operand === null) return;
    if (operand.glob) this.fail();
    else this.access.edits.push(operand.path);
  }
}

function redirections(command: Command, run: Interpretation): void {
  for (const { op, target } of command.redirects) {
    if (target === null || op === "<<<") continue;
    const text = plain(target);
    if ((op === ">&" || op === "<&") && (/^[0-9]+$/.test(text) || text === "-")) continue;
    if (target.dynamic) {
      run.fail();
      continue;
    }
    if (text.startsWith("/dev/")) continue;
    if (op === "<" || op === "<&") run.read(target);
    else run.edit(target);
  }
}

function sedLike(args: readonly Word[], run: Interpretation): void {
  const parsed = parseArgs(args, { valueShort: "efl", suffixShort: "i", valueLong: ["--expression", "--file", "--line-length"] });
  if (parsed === null) return run.fail();
  const inPlace = parsed.flags.has("i") || parsed.flags.has("--in-place");
  const hasScript = parsed.values.some((v) => v.name === "e" || v.name === "f" || v.name === "--expression" || v.name === "--file");
  let operands = parsed.operands.filter((word) => !(inPlace && plain(word) === "" && word.quoted && !hasScript));
  if (!hasScript) operands = operands.slice(1);
  for (const word of operands) {
    if (inPlace) run.edit(word);
    else run.read(word);
  }
}

function perlLike(args: readonly Word[], run: Interpretation): void {
  // perl takes its script from -e, or else from the first operand. `-pie` makes the backup suffix `e`, as perl does.
  let inPlace = false;
  let hasScript = false;
  const rest: Word[] = [];
  for (let k = 0; k < args.length; k++) {
    const word = args[k]!;
    const text = plain(word);
    if (word.quoted || !text.startsWith("-") || text === "-") {
      rest.push(...args.slice(k));
      break;
    }
    if (word.dynamic) return run.fail();
    if (text === "--") {
      rest.push(...args.slice(k + 1));
      break;
    }
    for (let c = 1; c < text.length; c++) {
      const char = text[c]!;
      if (char === "i") {
        inPlace = true;
        break;
      }
      if (char === "e" || char === "E") {
        hasScript = true;
        if (text.slice(c + 1) === "") k++;
        break;
      }
      if ("IMmx".includes(char)) {
        if (text.slice(c + 1) === "") k++;
        break;
      }
    }
  }
  const files = hasScript ? rest : rest.slice(1);
  if (!hasScript && rest[0] !== undefined) run.read(rest[0]);
  for (const word of files) {
    if (inPlace) run.edit(word);
    else run.read(word);
  }
}

function awkLike(args: readonly Word[], run: Interpretation): void {
  const parsed = parseArgs(args, { valueShort: "Fvf", valueLong: ["--field-separator", "--assign", "--file"] });
  if (parsed === null) return run.fail();
  const hasScript = parsed.values.some((v) => v.name === "f" || v.name === "--file");
  const operands = hasScript ? parsed.operands : parsed.operands.slice(1);
  for (const word of operands) {
    if (!word.dynamic && /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain(word))) continue;
    run.read(word);
  }
}

function grepLike(name: string, args: readonly Word[], run: Interpretation, piped: boolean, hasInput: boolean): void {
  const ripgrep = name === "rg";
  const parsed = parseArgs(args, {
    valueShort: ripgrep ? "efgtTABCmjMEdr" : "efmABCdD",
    valueLong: ripgrep ? RG_VALUE_LONG : GREP_VALUE_LONG,
  });
  if (parsed === null) return run.fail();
  const files = parsed.flags.has("--files");
  const patternGiven = parsed.values.some((v) => v.name === "e" || v.name === "f" || v.name === "--regexp" || v.name === "--file") && !(ripgrep && parsed.values.every((v) => v.name === "r" || v.name === "--replace"));
  const operands = files || patternGiven ? parsed.operands : parsed.operands.slice(1);
  const recursive = ripgrep || parsed.flags.has("r") || parsed.flags.has("R") || parsed.flags.has("--recursive") || parsed.flags.has("--dereference-recursive");
  if (operands.length === 0) {
    if (recursive && !piped && !hasInput) run.search(null);
    return;
  }
  for (const word of operands) {
    if (word.dynamic) {
      run.fail();
    } else if (word.glob && !word.quoted) {
      run.search(word);
    } else if (recursive && (!looksLikeFile(plain(word)) || endsLikeDirectory(plain(word)))) {
      run.search(word);
    } else {
      run.read(word);
    }
  }
}

function diffLike(args: readonly Word[], run: Interpretation): void {
  const parsed = parseArgs(args, { valueShort: "UCxIFLW", valueLong: ["--unified", "--context", "--exclude", "--ignore-matching-lines", "--label", "--width", "--from-file", "--to-file"] });
  if (parsed === null) return run.fail();
  const recursive = parsed.flags.has("r") || parsed.flags.has("--recursive");
  for (const word of parsed.operands) {
    if (recursive && (word.dynamic || !looksLikeFile(plain(word)) || endsLikeDirectory(plain(word)))) run.search(word);
    else run.read(word);
  }
}

function gitLike(args: readonly Word[], run: Interpretation): void {
  const saved = run.cwd;
  let k = 0;
  while (k < args.length) {
    const text = plain(args[k]!);
    if (args[k]!.dynamic) return run.fail();
    if (text === "-C") {
      const dir = args[k + 1];
      if (dir === undefined || dir.dynamic) return run.fail();
      run.cwd = run.resolve(plain(dir));
      k += 2;
    } else if (text === "-c" || text === "--git-dir" || text === "--work-tree" || text === "--namespace") {
      k += 2;
    } else if (text.startsWith("-")) {
      k++;
    } else {
      break;
    }
  }
  const sub = args[k] === undefined ? "" : plain(args[k]!);
  const rest = args.slice(k + 1);
  if (sub === "show") {
    for (const word of rest) {
      if (word.dynamic) return run.fail();
      const text = plain(word);
      const colon = text.indexOf(":");
      // `rev:path` names a path relative to the top of the repo, so it is kept relative whatever the working directory.
      if (!text.startsWith("-") && colon > 0 && colon < text.length - 1) run.access.reads.push(text.slice(colon + 1));
    }
  } else if (sub === "mv" || sub === "rm") {
    moveLike(sub === "mv" ? "mv" : "rm", rest, run);
  }
  run.cwd = saved;
}

function moveLike(name: "cp" | "mv" | "rm", args: readonly Word[], run: Interpretation): void {
  const parsed = parseArgs(args, { valueShort: "tS", valueLong: ["--target-directory", "--suffix"] });
  if (parsed === null) return run.fail();
  const recursive = parsed.flags.has("r") || parsed.flags.has("R") || parsed.flags.has("d") || parsed.flags.has("--recursive") || parsed.flags.has("a");
  const operands = parsed.operands.filter((word) => !endsLikeDirectory(plain(word)) || word.dynamic);
  if (name === "rm") {
    if (recursive) return;
    for (const word of operands) run.edit(word);
    return;
  }
  const targetOption = parsed.values.find((v) => v.name === "t" || v.name === "--target-directory");
  const all = parsed.operands;
  if (all.length === 0) return;
  let sources: Word[];
  let targets: string[] = [];
  if (targetOption !== undefined) {
    sources = all;
    const directory = run.resolve(targetOption.value ?? "");
    if (directory === null) return;
    targets = all.filter((w) => !w.dynamic).map((w) => posix.join(directory, posix.basename(plain(w))));
  } else {
    sources = all.slice(0, -1);
    const last = all.at(-1)!;
    if (last.dynamic || last.glob) return run.fail();
    const lastText = plain(last);
    if (sources.length > 1 || endsLikeDirectory(lastText)) {
      const directory = run.resolve(lastText);
      if (directory === null) return;
      targets = sources.filter((w) => !w.dynamic).map((w) => posix.join(directory, posix.basename(plain(w))));
    } else {
      const target = run.resolve(lastText);
      if (target !== null) targets = [target];
    }
  }
  for (const word of sources) {
    if (word.dynamic || (word.glob && !word.quoted)) return run.fail();
  }
  if (name === "mv") for (const word of sources) if (!recursive && !endsLikeDirectory(plain(word))) run.edit(word);
  if (recursive && name === "cp") return;
  run.access.edits.push(...targets);
}

function interpreterLike(args: readonly Word[], command: Command, run: Interpretation, name: string): void {
  if (command.heredoc) return run.fail();
  const parsed = parseArgs(args, {
    valueShort: name.startsWith("python") ? "WXmc" : "rCeEpr",
    valueLong: ["--require", "--import", "--loader", "--eval", "--print", "--experimental-loader"],
  });
  if (parsed === null) return run.fail();
  const inline = ["c", "e", "E", "p", "--eval", "--print"].some((flag) => parsed.flags.has(flag));
  if (inline) return run.fail();
  if (parsed.values.some((v) => v.name === "m")) return;
  const script = parsed.operands[0];
  if (script === undefined) return;
  if (plain(script) === "-") return run.fail();
  if (!script.dynamic && !looksLikeFile(plain(script))) return;
  run.read(script);
}

function findLike(args: readonly Word[], run: Interpretation): void {
  const paths: Word[] = [];
  for (const word of args) {
    const text = plain(word);
    if (!word.quoted && (text.startsWith("-") || text === "(" || text === "!")) break;
    paths.push(word);
  }
  for (const word of args) {
    if (["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls"].includes(plain(word)) && !word.quoted) return run.fail();
  }
  if (paths.length === 0) run.search(null);
  for (const word of paths) run.search(word);
}

function execute(command: Command, run: Interpretation, piped: boolean): void {
  let words = command.words.map((word) => run.substitute(word));
  const redirects = command.redirects.map((r) => ({ ...r, target: r.target === null ? null : run.substitute(r.target) }));
  const substituted: Command = { ...command, words, redirects };

  while (words[0] !== undefined && !words[0].quoted && !words[0].dynamic && SKIPPED_KEYWORDS.has(plain(words[0]))) words = words.slice(1);
  if (words[0] !== undefined && !words[0].quoted && UNPARSED_KEYWORDS.has(plain(words[0]))) return run.fail();

  while (words[0] !== undefined && !words[0].dynamic && /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain(words[0]))) {
    const text = plain(words[0]);
    const equals = text.indexOf("=");
    const name = text.slice(0, equals);
    if (words[0].glob) run.variables.delete(name);
    else run.variables.set(name, text.slice(equals + 1));
    words = words.slice(1);
  }
  redirections(substituted, run);
  if (words.length === 0) return;

  for (;;) {
    const head = words[0]!;
    if (head.dynamic) return run.fail();
    const text = plain(head);
    if (!WRAPPERS.has(text)) break;
    words = words.slice(1);
    while (words[0] !== undefined && (plain(words[0]).startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain(words[0])))) words = words.slice(1);
    if (words.length === 0) return;
  }

  const head = words[0]!;
  if (head.dynamic) return run.fail();
  const name = posix.basename(plain(head));
  const args = words.slice(1);
  const hasInput = command.redirects.some((r) => r.op === "<" || r.op === "<<<") || command.heredoc;

  if (HIDING_COMMANDS.has(name)) return run.fail();
  if (SHELLS.has(name)) {
    const parsed = parseArgs(args, { valueShort: "co" });
    if (parsed === null || parsed.flags.has("c") || command.heredoc) return run.fail();
    const script = parsed.operands[0];
    if (script !== undefined && !(script.dynamic === false && !looksLikeFile(plain(script)))) run.read(script);
    return;
  }
  if (name === "cd") {
    const target = args.find((word) => !/^-[A-Za-z]+$/.test(plain(word)) || word.quoted);
    if (target === undefined) run.cwd = "~";
    else if (target.dynamic || plain(target) === "-") run.cwd = null;
    else run.cwd = run.resolve(plain(target));
    return;
  }
  if (name === "pushd" || name === "popd") {
    run.cwd = null;
    return;
  }
  if (READERS.has(name)) {
    const parsed = parseArgs(args, { valueShort: name === "head" || name === "tail" ? "nc" : "", valueLong: ["--lines", "--bytes", "--files0-from"] });
    if (parsed === null) return run.fail();
    for (const word of parsed.operands) run.read(word);
    return;
  }
  if (name === "sed") return sedLike(args, run);
  if (name === "perl") return perlLike(args, run);
  if (name === "awk" || name === "gawk" || name === "mawk") return awkLike(args, run);
  if (name === "grep" || name === "egrep" || name === "fgrep" || name === "rg") return grepLike(name === "rg" ? "rg" : "grep", args, run, piped, hasInput);
  if (name === "diff") return diffLike(args, run);
  if (name === "git") return gitLike(args, run);
  if (name === "tee") {
    const parsed = parseArgs(args, {});
    if (parsed === null) return run.fail();
    for (const word of parsed.operands) if (plain(word) !== "-" && !plain(word).startsWith("/dev/")) run.edit(word);
    return;
  }
  if (name === "cp" || name === "mv" || name === "rm") return moveLike(name, args, run);
  if (name === "find") return findLike(args, run);
  if (INTERPRETERS.has(name)) return interpreterLike(args, command, run, name);
}

const headOf = (command: Command): string | null => {
  const word = command.words.find((candidate) => candidate.quoted || !SKIPPED_KEYWORDS.has(plain(candidate)));
  return word === undefined || word.quoted ? null : plain(word);
};

function run(commands: readonly Command[], from: number, to: number, interpretation: Interpretation): void {
  let i = from;
  while (i < to && interpretation.ok) {
    const command = commands[i]!;
    if (command.marker === "(") {
      interpretation.stack.push(interpretation.cwd);
      i++;
      continue;
    }
    if (command.marker === ")") {
      if (interpretation.stack.length === 0) return interpretation.fail();
      interpretation.cwd = interpretation.stack.pop();
      i++;
      continue;
    }
    const head = headOf(command);
    if (head === "done") return interpretation.fail();
    if (head === "for") {
      let depth = 1;
      let j = i + 1;
      for (; j < to; j++) {
        const inner = headOf(commands[j]!);
        if (inner === "for") depth++;
        else if (inner === "done" && --depth === 0) break;
      }
      if (j >= to) return interpretation.fail();
      const start = command.words.findIndex((word) => !word.quoted && plain(word) === "for");
      const words = command.words.slice(start + 1).map((word) => interpretation.substitute(word));
      const [variable, keyword, ...items] = words;
      if (variable === undefined || keyword === undefined || plain(keyword) !== "in" || variable.dynamic) return interpretation.fail();
      if (items.some((item) => item.dynamic || (item.glob && !item.quoted))) return interpretation.fail();
      if (commands[j]!.redirects.length > 0) return interpretation.fail();
      for (const item of items) {
        interpretation.variables.set(plain(variable), plain(item));
        run(commands, i + 1, j, interpretation);
      }
      interpretation.variables.delete(plain(variable));
      i = j + 1;
      continue;
    }
    const previous = i > from ? commands[i - 1]!.separator : "";
    execute(command, interpretation, previous === "|" || previous === "|&");
    i++;
  }
}

/**
 * The files a shell command line reads, searches and edits, or null when the line is not parsed (see the module
 * comment). `cwd` is the working directory recorded for the call, or null when the transcript recorded none, in
 * which case a relative path stays relative. A literal `cd` in the line moves the directory for what follows.
 */
export function shellAccess(command: string, cwd: string | null): ShellAccess | null {
  const tokens = tokenize(command);
  if (tokens === null) return null;
  const commands = segment(tokens);
  if (commands === null) return null;
  const interpretation = new Interpretation(cwd);
  run(commands, 0, commands.length, interpretation);
  if (interpretation.ok && interpretation.stack.length > 0) interpretation.fail();
  return interpretation.ok ? interpretation.access : null;
}
