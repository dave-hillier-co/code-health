/**
 * A lexer profile is data: how to find comments and strings, how blocks are
 * delimited, which keywords branch, and what a function header looks like.
 * Regular expressions are stored as source strings so a profile stays plain,
 * serialisable data that config can name or extend.
 */

export interface BlockComment {
  open: string;
  close: string;
  /** Rust-style nesting. */
  nested?: boolean;
}

export interface DelimitedString {
  kind: "delimited";
  /** Characters that can start this literal; lets the scanner skip quickly. */
  triggers: string;
  /** Regex source, matched at the current position. Capture group 1 may feed `close`. */
  open: string;
  /** Closing text. `$1` is replaced by capture group 1 of the opener. */
  close: string;
  /** A character that makes the next one literal, such as a backslash. */
  escape?: string;
  /** The closing text written twice is a literal close (C# verbatim strings). */
  doubledCloseEscapes?: boolean;
  multiline: boolean;
  /** Template-literal interpolation: code between these markers is still code. */
  interpolation?: { open: string; close: string };
}

export interface WholeLiteral {
  kind: "whole";
  triggers: string;
  /** Regex source matching the entire literal, such as a character literal. */
  pattern: string;
  /**
   * Regex source tested against the text before the literal. The literal only starts when it
   * matches, which tells a regex literal from a division sign.
   */
  after?: string;
}

export type StringRule = DelimitedString | WholeLiteral;

export interface LexerProfile {
  name: string;
  /** How blocks are delimited. */
  blocks: "braces" | "indentation";
  lineComments: string[];
  blockComments: BlockComment[];
  strings: StringRule[];
  /** Keywords counted by keyword complexity, as regex source fragments without word boundaries. */
  branchKeywords: string[];
  /** Short-circuit operators counted by keyword complexity, as regex source. */
  shortCircuitOperators: string[];
  /** Branch keywords plus alternatives, any of which can open a bump. */
  bumpOpeners: string[];
  /** Header lines dropped before a header is classified (annotations, attributes, preprocessor). */
  headerNoise: string[];
  /** A header starting like this is control flow, never a function. */
  controlHeader: string;
  /** Headers naming a scope that qualifies the functions inside it. Group `name` is required. */
  typeHeaders: string[];
  /** Headers that open a function. Group `name` is optional. Tested against collapsed header text. */
  functionHeaders: string[];
}

const doubleQuote: DelimitedString = {
  kind: "delimited",
  triggers: '"',
  open: '"',
  close: '"',
  escape: "\\",
  multiline: false,
};

const singleQuote: DelimitedString = {
  kind: "delimited",
  triggers: "'",
  open: "'",
  close: "'",
  escape: "\\",
  multiline: false,
};

const charLiteral: WholeLiteral = {
  kind: "whole",
  triggers: "'",
  pattern: "'(?:\\\\[^'\\n]*|[^\\\\'\\n])'",
};

const cBranchKeywords = ["if", "for", "while", "case", "catch"];
const cBumpOpeners = [...cBranchKeywords, "else", "do", "default", "switch", "try", "finally"];

const controlHeader =
  "^(?:else\\s+if|else|if|for|foreach|while|do|switch|catch|try|finally|with|using|lock|synchronized|unsafe|checked|fixed|match|loop|unless)\\b";

const typeHeader =
  "\\b(?:class|struct|interface|enum|namespace|trait|object|record|union)\\s+(?<name>[\\w.:$]+)";

const cTypeHeaders = [typeHeader];

const annotationNoise = ["^\\[.*\\]$", "^@\\w[\\w.]*(?:\\(.*\\))?$", "^#.*$"];

/** Return type, modifiers and a name followed by a parameter list and trailing qualifiers. */
const cMethodHeader =
  "(?<![\\w.])(?<name>~?[\\w:.$<>]+|operator\\s*[^\\s(]+)\\s*\\([^]*\\)\\s*(?:(?:const|noexcept|override|final|volatile|mutable|throws\\s+[\\w.,\\s]+|where\\s+[^{;]+|&&|&)\\s*)*(?:->\\s*[^{;]+)?(?::\\s*[^{;]*)?$";

/** A regex literal. It can only start where an expression can, so a `/` after a name, number or closer is division. */
const regexLiteral: WholeLiteral = {
  kind: "whole",
  triggers: "/",
  pattern: "/(?![*/])(?:\\\\.|\\[(?:\\\\.|[^\\]\\\\\\n])*\\]|[^/\\\\\\[\\n])+/[a-z]*",
  after: "(?:[(,=:\\[!&|?{};<>~^%]|\\b(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await))\\s*$",
};

const typescript: LexerProfile = {
  name: "typescript",
  blocks: "braces",
  lineComments: ["//"],
  blockComments: [{ open: "/*", close: "*/" }],
  strings: [
    doubleQuote,
    singleQuote,
    {
      kind: "delimited",
      triggers: "`",
      open: "`",
      close: "`",
      escape: "\\",
      multiline: true,
      interpolation: { open: "${", close: "}" },
    },
    regexLiteral,
  ],
  branchKeywords: cBranchKeywords,
  shortCircuitOperators: ["&&", "\\|\\|", "\\?\\?"],
  bumpOpeners: cBumpOpeners,
  headerNoise: ["^@\\w[\\w.]*(?:\\(.*\\))?$"],
  controlHeader,
  typeHeaders: cTypeHeaders,
  functionHeaders: [
    "\\bfunction\\b\\s*\\*?\\s*(?<name>[\\w$]+)?\\s*(?:<[^>]*>)?\\s*\\([^]*\\)[^;{}=]*$",
    "^(?:export\\s+(?:default\\s+)?)?(?:(?:const|let|var)\\s+(?<name>[\\w$]+)\\s*(?::[^=]+)?=\\s*)?[^]*=>\\s*(?::[^{;]+)?$",
    "^(?:(?:public|private|protected|static|async|readonly|get|set|override|abstract|declare)\\s+)*\\*?\\s*(?<name>[#\\w$]+)\\s*(?:<[^>]*>)?\\s*\\([^]*\\)\\s*(?::\\s*[^{;]+)?$",
  ],
};

const csharp: LexerProfile = {
  name: "csharp",
  blocks: "braces",
  lineComments: ["//"],
  blockComments: [{ open: "/*", close: "*/" }],
  strings: [
    // Raw string literals first, they start with three or more quotes.
    {
      kind: "delimited",
      triggers: '$"',
      open: '\\$*("{3,})',
      close: "$1",
      multiline: true,
    },
    {
      kind: "delimited",
      triggers: '@$"',
      open: '(?:@\\$?|\\$@)"',
      close: '"',
      doubledCloseEscapes: true,
      multiline: true,
    },
    { ...doubleQuote, triggers: '$"', open: '\\$?"' },
    charLiteral,
  ],
  branchKeywords: [...cBranchKeywords, "foreach"],
  shortCircuitOperators: ["&&", "\\|\\|", "\\?\\?"],
  bumpOpeners: [...cBumpOpeners, "foreach"],
  headerNoise: annotationNoise,
  controlHeader,
  typeHeaders: cTypeHeaders,
  functionHeaders: [
    "(?:[^]*\\s)?(?<name>(?!(?:base|this)\\b)[\\w.<>]+)\\s*\\([^]*\\)\\s*(?:where\\s+[^{;]+)?(?::\\s*(?:base|this)\\s*\\([^]*\\))?$",
    "=>\\s*$",
  ],
};

const cpp: LexerProfile = {
  name: "cpp",
  blocks: "braces",
  lineComments: ["//"],
  blockComments: [{ open: "/*", close: "*/" }],
  strings: [
    {
      kind: "delimited",
      triggers: "R",
      open: '(?:u8|u|U|L)?R"([^()\\s\\\\]{0,16})\\(',
      close: ')$1"',
      multiline: true,
    },
    { ...doubleQuote },
    charLiteral,
  ],
  branchKeywords: cBranchKeywords,
  shortCircuitOperators: ["(?<=\\s)&&(?=\\s)", "\\|\\|"],
  bumpOpeners: cBumpOpeners,
  headerNoise: ["^#.*$", "^\\[\\[.*\\]\\]$"],
  controlHeader,
  typeHeaders: [typeHeader],
  functionHeaders: [cMethodHeader, "\\]\\s*(?:\\([^]*\\))?\\s*(?:mutable|noexcept|->\\s*[^{;]+)*\\s*$"],
};

const java: LexerProfile = {
  name: "java",
  blocks: "braces",
  lineComments: ["//"],
  blockComments: [{ open: "/*", close: "*/" }],
  strings: [
    { kind: "delimited", triggers: '"', open: '"""', close: '"""', escape: "\\", multiline: true },
    doubleQuote,
    charLiteral,
  ],
  branchKeywords: cBranchKeywords,
  shortCircuitOperators: ["&&", "\\|\\|"],
  bumpOpeners: cBumpOpeners,
  headerNoise: annotationNoise,
  controlHeader,
  typeHeaders: [typeHeader],
  functionHeaders: [cMethodHeader, "->\\s*$"],
};

const kotlin: LexerProfile = {
  name: "kotlin",
  blocks: "braces",
  lineComments: ["//"],
  blockComments: [{ open: "/*", close: "*/", nested: true }],
  strings: [
    { kind: "delimited", triggers: '"', open: '"""', close: '"""', multiline: true },
    doubleQuote,
    charLiteral,
  ],
  branchKeywords: [...cBranchKeywords, "when"],
  shortCircuitOperators: ["&&", "\\|\\|", "\\?:"],
  bumpOpeners: [...cBumpOpeners, "when"],
  headerNoise: annotationNoise,
  controlHeader,
  typeHeaders: [typeHeader],
  functionHeaders: [
    "\\bfun\\b\\s*(?:<[^>]*>\\s*)?(?:[\\w.<>?]+\\.)?(?<name>[\\w$]+)\\s*\\([^]*\\)\\s*(?::\\s*[^{=]+)?$",
    "->\\s*$",
  ],
};

const rust: LexerProfile = {
  name: "rust",
  blocks: "braces",
  lineComments: ["//"],
  blockComments: [{ open: "/*", close: "*/", nested: true }],
  strings: [
    {
      kind: "delimited",
      triggers: "rb",
      open: '(?<![\\w])b?r(#*)"',
      close: '"$1',
      multiline: true,
    },
    { ...doubleQuote, multiline: true },
    charLiteral,
  ],
  branchKeywords: ["if", "for", "while", "loop", "match"],
  shortCircuitOperators: ["(?<=\\s)&&(?=\\s)", "(?<!\\bmove)(?<=[\\w)\\]])\\s*\\|\\|"],
  bumpOpeners: ["if", "for", "while", "loop", "match", "else"],
  headerNoise: ["^#!?\\[.*\\]$"],
  controlHeader: "^(?:else\\s+if|else|if|for|while|loop|match|unsafe)\\b",
  typeHeaders: [
    "\\b(?:struct|enum|trait|mod|union)\\s+(?<name>\\w+)",
    "\\bimpl\\b(?:\\s*<[^>]*>)?\\s+(?:[\\w:<>,\\s]+?\\s+for\\s+)?(?<name>\\w+)",
  ],
  functionHeaders: [
    "\\bfn\\s+(?<name>\\w+)\\s*(?:<[^>]*>)?\\s*\\([^]*\\)\\s*(?:->\\s*[^{;]+)?(?:where\\s+[^{;]+)?$",
    "\\|[^|]*\\|\\s*(?:->\\s*[^{;]+)?$",
  ],
};

const python: LexerProfile = {
  name: "python",
  blocks: "indentation",
  lineComments: ["#"],
  blockComments: [],
  strings: [
    { kind: "delimited", triggers: '"', open: '"""', close: '"""', escape: "\\", multiline: true },
    { kind: "delimited", triggers: "'", open: "'''", close: "'''", escape: "\\", multiline: true },
    doubleQuote,
    singleQuote,
  ],
  branchKeywords: ["if", "elif", "for", "while", "except", "case"],
  shortCircuitOperators: ["\\band\\b", "\\bor\\b"],
  bumpOpeners: ["if", "elif", "else", "for", "while", "try", "except", "finally", "with", "match", "case"],
  headerNoise: ["^@.*$"],
  controlHeader: "^(?:if|elif|else|for|while|try|except|finally|with|match|case)\\b",
  typeHeaders: ["^class\\s+(?<name>\\w+)"],
  functionHeaders: ["^(?:async\\s+)?def\\s+(?<name>\\w+)"],
};

export const profiles: Record<string, LexerProfile> = {
  typescript,
  csharp,
  cpp,
  java,
  kotlin,
  rust,
  python,
};

/** Extension to profile name. Anything missing here has no profile. */
export const extensionProfiles: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "typescript",
  jsx: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  cs: "csharp",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rs: "rust",
  py: "python",
};

export interface ProfileSelection {
  profile: LexerProfile;
  /** True when config mapped the extension, so no agreement measurement stands behind it. */
  mapped: boolean;
}

/**
 * Picks the profile for a path. `mappings` is the config override from file
 * extension (no dot) to profile name; mapped profiles are marked unverified.
 */
export function selectProfile(
  path: string,
  mappings: Record<string, string> = {},
): ProfileSelection | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  const mappedName = mappings[extension];
  if (mappedName !== undefined) {
    const profile = profiles[mappedName];
    if (profile === undefined) throw new Error(`unknown lexer profile "${mappedName}"`);
    return { profile, mapped: true };
  }
  const builtIn = extensionProfiles[extension];
  const profile = builtIn === undefined ? undefined : profiles[builtIn];
  return profile === undefined ? undefined : { profile, mapped: false };
}
