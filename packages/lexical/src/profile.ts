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
  /**
   * Functions written `name = (args) => expression`, which have no braces to close. The block ends with the
   * expression. Only arrows bound to a name are blocks, as callbacks passed inline are not units.
   */
  expressionArrows?: boolean;
  /**
   * Members written `header => expression;`, which have no braces to close (C# `int Twice(int x) => x * 2;`).
   * Regular expressions tested against the collapsed header before an `=>`, with the member's name in group
   * `name`. An `=>` whose header matches none of them is a lambda or a switch arm, not a member.
   */
  expressionMembers?: string[];
  /**
   * Statements end at a line break and not at a `;` (Go's automatic semicolons), so the text before a break
   * is not part of the next header. Regex source tested against the code of a line, trimmed: a line break
   * ends the statement when it matches, or when the line ends in a string literal. A header that continues
   * on the next line (an open parenthesis, a trailing operator or comma) is not ended.
   */
  statementEnd?: string;
  /**
   * Statements end at a line break unless the line obviously continues (Kotlin, which has no semicolons), so
   * a declaration's header is not joined with the lines before it.
   */
  newlineEndsStatements?: boolean;
  /**
   * `fun name(args): T = expression` is a function whose body is an expression with no braces: the block ends
   * with the expression. Used with `newlineEndsStatements`.
   */
  expressionBodies?: boolean;
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
    "\\bfunction\\b\\s*\\*?\\s*(?<name>[\\w$]+)?\\s*(?:<[^>]*>)?\\s*\\([^]*\\)(?:[^;{}=]|=>)*$",
    "^(?:export\\s+(?:default\\s+)?)?(?:(?:const|let|var)\\s+(?<name>[\\w$]+)\\s*(?::[^=]+)?=\\s*)?[^]*=>\\s*(?::[^{;]+)?$",
    "^(?:(?:public|private|protected|static|async|readonly|get|set|override|abstract|declare)\\s+)*\\*?\\s*(?<name>[#\\w$]+|\\[[^\\]]+\\])\\s*(?:<[^>]*>)?\\s*\\([^]*\\)\\s*(?::\\s*[^{;]+)?$",
  ],
  expressionArrows: true,
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
  // `object` and `record` are not declarations here: `object o` is a parameter.
  typeHeaders: ["(?:^|\\s)(?:class|struct|interface|enum|namespace|record(?:\\s+(?:class|struct))?)\\s+(?<name>[\\w.]+)"],
  functionHeaders: [
    // A method, constructor or operator, with an optional constraint clause and constructor initialiser.
    "(?:[^]*\\s)?(?<name>(?!(?:base|this)\\b)[\\w.<>]+|operator\\s*[^\\s(]+)\\s*\\([^]*\\)\\s*(?:where\\s+[^{;]+)?(?::\\s*(?:base|this)\\s*\\([^]*\\))?$",
    // An accessor with a block body.
    "^(?:(?:public|private|protected|internal)\\s+)*(?<name>get|set|init|add|remove)$",
    "=>\\s*$",
  ],
  expressionMembers: [
    // A method or operator: `public int Twice(int x)`, `static bool operator ==(A a, B b)`.
    "^(?:\\[[^\\]]*\\]\\s*)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|partial|readonly)\\s+)*[\\w.<>\\[\\]?,()]+\\s+(?<name>[\\w.]+|operator\\s*[^\\s(]+)\\s*(?:<[^>]*>)?\\s*\\([^]*\\)\\s*(?:where\\s+[^=]+)?$",
    // A conversion operator, which has no return type of its own: `public static implicit operator int(Money m)`.
    "^(?:(?:public|static)\\s+)*(?:implicit|explicit)\\s+(?<name>operator\\s+[\\w.<>\\[\\]?]+)\\s*\\([^]*\\)$",
    // A constructor or finaliser, which has modifiers and no return type: `public Money(decimal amount)`.
    "^(?:(?:public|private|protected|internal|static)\\s+)+(?<name>~?\\w+)\\s*\\([^]*\\)\\s*(?::\\s*(?:base|this)\\s*\\([^]*\\))?$",
    // A property or indexer: `public int Count`, `public int this[int i]`.
    "^(?:\\[[^\\]]*\\]\\s*)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|new|readonly)\\s+)+[\\w.<>\\[\\]?,()]+\\s+(?<name>\\w+|this\\s*\\[[^\\]]*\\])$",
    // An accessor: `set => value = x;`.
    "^(?:(?:public|private|protected|internal)\\s+)*(?<name>get|set|init|add|remove)$",
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
  // Access specifiers and Qt's `signals:` end in a colon and are not part of the member that follows them.
  headerNoise: ["^#.*$", "^\\[\\[.*\\]\\]$", "^(?:public|private|protected)(?:\\s+(?:slots|Q_SLOTS))?\\s*:$", "^(?:signals|Q_SIGNALS)\\s*:$"],
  controlHeader,
  typeHeaders: [typeHeader],
  functionHeaders: [cMethodHeader, "\\]\\s*(?:\\([^]*\\))?\\s*(?:mutable|noexcept|->\\s*[^{;]+)*\\s*$"],
};

/**
 * GLSL, the C-family shading language of OpenGL and Vulkan: C comments, `#` preprocessor lines, `struct`
 * declarations and C-style function definitions. It has no string or character literals (a quoted `#include` is a
 * preprocessor line), no classes and no `catch`, and `^^` is the logical exclusive or. A uniform or buffer block
 * (`uniform Lights { ... }`) is a block with no function header. There is no structural adapter, so nothing measures
 * the profile's agreement and its per-function values are unverified (see `profilesWithoutAdapter`).
 */
const glsl: LexerProfile = {
  name: "glsl",
  blocks: "braces",
  lineComments: ["//"],
  blockComments: [{ open: "/*", close: "*/" }],
  strings: [{ ...doubleQuote }],
  branchKeywords: ["if", "for", "while", "case"],
  shortCircuitOperators: ["&&", "\\|\\|", "\\^\\^"],
  bumpOpeners: ["if", "for", "while", "case", "else", "do", "default", "switch"],
  headerNoise: ["^#.*$"],
  controlHeader,
  typeHeaders: ["\\bstruct\\s+(?<name>\\w+)"],
  functionHeaders: [cMethodHeader],
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
  // The elvis operator is null-coalescing, not a decision (suite.md, Metric definitions per language).
  shortCircuitOperators: ["&&", "\\|\\|"],
  bumpOpeners: [...cBumpOpeners, "when"],
  headerNoise: annotationNoise,
  controlHeader,
  typeHeaders: [typeHeader],
  functionHeaders: [
    "\\bfun\\b\\s*(?:<[^>]*>\\s*)?(?:[\\w.<>?]+\\.)?(?<name>[\\w$]+)\\s*\\([^]*\\)\\s*(?::\\s*[^{=]+)?$",
    "^(?:(?:public|private|protected|internal)\\s+)?constructor\\s*\\([^]*\\)(?:\\s*:\\s*(?:this|super)\\s*\\([^]*\\))?$",
    "->\\s*$",
  ],
  newlineEndsStatements: true,
  expressionBodies: true,
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

const go: LexerProfile = {
  name: "go",
  blocks: "braces",
  lineComments: ["//"],
  blockComments: [{ open: "/*", close: "*/" }],
  strings: [
    // Raw strings take no escapes and can span lines.
    { kind: "delimited", triggers: "`", open: "`", close: "`", multiline: true },
    doubleQuote,
    charLiteral,
  ],
  // `if err != nil` is an ordinary `if`. `case` covers expression, type and select cases. `defer` and `go` do not branch.
  branchKeywords: ["if", "for", "case"],
  shortCircuitOperators: ["&&", "\\|\\|"],
  bumpOpeners: ["if", "else", "for", "switch", "select", "case", "default"],
  headerNoise: ["^//go:.*$"],
  // `package`, `import`, `const`, `var` and `type` declarations end at the line break, and so does any statement.
  statementEnd: "(?:[\\w)\\]}]|\\+\\+|--)$|^\\s*(?:case\\b.*|default|\\w+):$",
  controlHeader: "^(?:else\\s+if|else|if|for|switch|select)\\b",
  typeHeaders: ["\\btype\\s+(?<name>\\w+)(?:\\s*\\[[^\\]]*\\])?\\s+(?:struct|interface)\\b"],
  functionHeaders: [
    // A declaration, with an optional receiver and type parameters.
    "^func\\s+(?:\\([^)]*\\)\\s*)?(?<name>\\w+)\\s*(?:\\[[^\\]]*\\]\\s*)?\\([^]*\\)[^;{}]*$",
    // A function literal, alone or as an argument, a value or the operand of `go` and `defer`.
    "\\bfunc\\s*\\([^]*\\)[^;{}]*$",
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
  glsl,
  java,
  kotlin,
  rust,
  go,
  python,
};

/**
 * Profiles with no structural adapter behind them, so no agreement with a structural layer can be measured. A file read
 * with one has its per-function values released as unverified, as a profile mapped by config is.
 */
export const profilesWithoutAdapter: ReadonlySet<string> = new Set(["glsl"]);

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
  // Shader stages as glslang names them by extension, and the extension of an include file.
  glsl: "glsl",
  vert: "glsl",
  frag: "glsl",
  geom: "glsl",
  tesc: "glsl",
  tese: "glsl",
  comp: "glsl",
  mesh: "glsl",
  rgen: "glsl",
  rint: "glsl",
  rahit: "glsl",
  rchit: "glsl",
  rmiss: "glsl",
  rcall: "glsl",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rs: "rust",
  go: "go",
  py: "python",
};

export interface ProfileSelection {
  profile: LexerProfile;
  /** True when config mapped the extension, or the profile has no structural adapter, so no agreement measurement stands behind it. */
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
  return profile === undefined ? undefined : { profile, mapped: profilesWithoutAdapter.has(profile.name) };
}
