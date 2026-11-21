import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Tree } from "web-tree-sitter";

export type GrammarId = "typescript" | "tsx" | "javascript";

export interface GrammarSpec {
  id: GrammarId;
  /** npm package that ships the grammar's .wasm file. */
  packageName: string;
  /** File name of the .wasm, both inside the npm package and in `dist/grammars`. */
  file: string;
}

export const grammarSpecs: readonly GrammarSpec[] = [
  { id: "typescript", packageName: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" },
  { id: "tsx", packageName: "tree-sitter-typescript", file: "tree-sitter-tsx.wasm" },
  { id: "javascript", packageName: "tree-sitter-javascript", file: "tree-sitter-javascript.wasm" },
];

/** The tree-sitter runtime itself, shipped beside the grammars. */
export const runtimeSpec = { packageName: "web-tree-sitter", file: "web-tree-sitter.wasm" } as const;

const extensionGrammars: Record<string, GrammarId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
};

export function grammarIdForPath(path: string): GrammarId | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  return extensionGrammars[path.slice(dot)];
}

export interface LoadedGrammar {
  id: GrammarId;
  /**
   * Identifies the grammar and runtime that produce a tree. Derived from the
   * bytes of the .wasm files, so it is always available once bundled (no
   * package.json to read) and cannot drift from the files actually loaded.
   */
  version: string;
  /** Caller owns the tree and must call `delete()` on it. */
  parse(source: string): Tree;
}

export interface LoadOptions {
  /** Directory holding the .wasm files. Defaults to `grammars/` beside this module, then the npm packages. */
  grammarDir?: string;
}

const require = createRequire(import.meta.url);
const loaded = new Map<string, Promise<LoadedGrammar>>();
let runtimeInit: Promise<void> | undefined;

/**
 * Finds a .wasm file. Bundled, the file sits in `grammars/` next to the
 * bundle, resolved from `import.meta.url`. From source, it falls back to the
 * npm package that ships it.
 */
function locate(file: string, packageName: string, grammarDir: string | undefined): string {
  if (grammarDir !== undefined) {
    const explicit = join(grammarDir, file);
    if (!existsSync(explicit)) throw new Error(`Grammar file not found: ${explicit}`);
    return explicit;
  }
  const bundled = fileURLToPath(new URL(`./grammars/${file}`, import.meta.url));
  if (existsSync(bundled)) return bundled;
  try {
    return require.resolve(`${packageName}/${file}`);
  } catch {
    throw new Error(`Grammar file ${file} not found beside ${bundled} or in the ${packageName} package`);
  }
}

export function locateGrammarFile(spec: { packageName: string; file: string }): string {
  return locate(spec.file, spec.packageName, undefined);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/**
 * Initialises the runtime once per process. The runtime is the same whichever
 * directory the grammars come from, so the first caller's location wins.
 */
function initRuntime(path: string): Promise<void> {
  runtimeInit ??= Parser.init({ locateFile: () => path });
  return runtimeInit;
}

export function loadGrammar(id: GrammarId, options: LoadOptions = {}): Promise<LoadedGrammar> {
  const key = `${options.grammarDir ?? ""}\0${id}`;
  let grammar = loaded.get(key);
  if (!grammar) {
    grammar = load(id, options.grammarDir);
    loaded.set(key, grammar);
  }
  return grammar;
}

async function load(id: GrammarId, grammarDir: string | undefined): Promise<LoadedGrammar> {
  const spec = grammarSpecs.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`Unknown grammar: ${id}`);
  const path = locate(spec.file, spec.packageName, grammarDir);
  const runtimePath = locate(runtimeSpec.file, runtimeSpec.packageName, grammarDir);
  const bytes = readFileSync(path);
  await initRuntime(runtimePath);
  const language = await Language.load(new Uint8Array(bytes));
  const parser = new Parser();
  parser.setLanguage(language);
  return {
    id,
    version: `${id}-${hash(bytes)}+runtime-${hash(readFileSync(runtimePath))}`,
    parse(source) {
      const tree = parser.parse(source);
      if (!tree) throw new Error(`Parsing failed for grammar ${id}`);
      return tree;
    },
  };
}
