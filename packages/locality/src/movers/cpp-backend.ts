import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import type { Node } from "web-tree-sitter";
import { GrammarSet, type LoadedGrammar } from "@code-health/parse/grammars";
import { adapterById } from "@code-health/parse/languages";
import { includePathsOf } from "@code-health/parse/languages/cpp/include-paths";
import { locateInclude } from "@code-health/parse/languages/cpp/resolve";
import type { SourceTree } from "@code-health/parse/source-tree";
import type { FileOperation } from "../move-plan.ts";
import type { MoveResult, MoverBackend, Rewrite, Skeleton } from "./mover-language.ts";
import { oncePerTree, sourceFilesOf } from "./mover-language.ts";

const execFileAsync = promisify(execFile);
const isSource = sourceFilesOf("cpp");
const isCmake = (path: string): boolean => path === "CMakeLists.txt" || path.endsWith("/CMakeLists.txt");
const isConfig = (path: string): boolean => isCmake(path) || path === "compile_commands.json" || path.endsWith("/compile_commands.json");

/** One `#include` of a file. */
interface Include {
  /** `<name>` for an angle include, `name` for a quoted one, as the dependency facts spell it. Null when the path is computed by a macro. */
  specifier: string | null;
  line: number;
  /** The path as written, delimiters included. */
  token: string;
}

function includesOf(grammar: LoadedGrammar, text: string): Include[] {
  const tree = grammar.parse(text);
  try {
    return tree.rootNode.descendantsOfType("preproc_include").flatMap((node: Node): Include[] => {
      const path = node.childForFieldName("path");
      if (path === null) return [];
      const line = node.startPosition.row + 1;
      if (path.type === "system_lib_string") return [{ specifier: path.text, line, token: path.text }];
      if (path.type === "string_literal") return [{ specifier: path.namedChildren.find((child) => child.type === "string_content")?.text ?? path.text.slice(1, -1), line, token: path.text }];
      return [{ specifier: null, line, token: path.text }];
    });
  } finally {
    tree.delete();
  }
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const directoryOf = (path: string): string => (posix.dirname(path) === "." ? "" : posix.dirname(path));
const relativeFrom = (directory: string, path: string): string => posix.relative(directory === "" ? "." : directory, path);

/** Whether `path` is `directory` or inside it, with "" the root. */
const under = (directory: string, path: string): boolean => directory === "" || path === directory || path.startsWith(`${directory}/`);

/** A regular expression for a CMake glob, `*` stopping at a slash and `**` and recursive globs not. */
function globRegExp(pattern: string, recursive: boolean): RegExp {
  const body = pattern
    .split("**")
    .map((part) => part.split("*").map(escape).join(recursive ? ".*" : "[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

interface Edit {
  path: string;
  line: number;
  from: string;
  to: string;
}

/**
 * Applies a move to a tree in memory. The edits are computed deterministically from the includes and the build
 * files, and `--apply` writes them:
 *
 * - Every `#include` that reached a moved file, and every one inside a moved file, is respelled so it still
 *   reaches the same file. A quoted include beside its includer stays relative to it, and one found through an
 *   include directory (`compile_commands.json`, or `target_include_directories`) stays relative to that
 *   directory, as long as the new place is still under one that finds it.
 * - Every CMakeLists.txt that lists a moved file as a source or header gets the new path in its place. A
 *   `file(GLOB ...)` that matched the old place and not the new one is reported.
 *
 * Includes spelled by a macro are not rewritten and are reported.
 */
/** The sources of a tree, the includes each one writes and the include directories, read once for the tree (see `oncePerTree`). */
const projectsOf = new WeakMap<LoadedGrammar, (tree: SourceTree) => Promise<{ paths: string[]; includePaths: ReturnType<typeof includePathsOf>; texts: Map<string, string>; includes: Map<string, Include[]> }>>();
function projectOf(grammar: LoadedGrammar, tree: SourceTree) {
  let read = projectsOf.get(grammar);
  if (read === undefined) {
    read = oncePerTree(async (source) => {
      const paths = [...source.files.keys()];
      const configs = await source.readMany(paths.filter(isConfig));
      const texts = await source.readMany(paths.filter((path) => isSource(path) || isCmake(path)));
      const includes = new Map<string, Include[]>();
      for (const [path, text] of texts) if (isSource(path)) includes.set(path, includesOf(grammar, text));
      return { paths, includePaths: includePathsOf(paths, configs), texts, includes };
    });
    projectsOf.set(grammar, read);
  }
  return read(tree);
}

async function plan(grammar: LoadedGrammar, tree: SourceTree, operations: readonly FileOperation[]): Promise<Omit<MoveResult, "confirmations">> {
  const moves = new Map(operations.map((operation) => [operation.from, operation.to]));
  const { paths, includePaths, texts, includes } = await projectOf(grammar, tree);
  const before = new Set(paths);
  const after = new Set(paths.map((path) => moves.get(path) ?? path));

  const rewrites: Rewrite[] = [];
  const warnings: string[] = [];
  const changed = new Map<string, string>();

  const spell = (includer: string, newIncluder: string, include: Include, dirs: readonly string[]): string | undefined => {
    const located = locateInclude(includer, include.specifier!, dirs, before);
    if (located === undefined) return undefined;
    const target = moves.get(located.path) ?? located.path;
    if (newIncluder === includer && target === located.path) return undefined;
    const angle = include.specifier!.startsWith("<");
    const written = angle ? include.specifier!.slice(1, -1) : include.specifier!;
    const works = (name: string, quoted: boolean): boolean => locateInclude(newIncluder, quoted ? name : `<${name}>`, dirs, after)?.path === target;

    const candidates: { name: string; quoted: boolean }[] = [];
    if (located.relativeToIncluder) {
      const relative = relativeFrom(directoryOf(newIncluder), target);
      candidates.push({ name: written.startsWith("./") && !relative.startsWith(".") ? `./${relative}` : relative, quoted: true });
    } else {
      // The repository root is only a last resort of the resolver: it is a spelling to keep, not one to move to.
      for (const dir of [located.via, ...dirs]) {
        if (under(dir, target) && (dir !== "" || located.via === "")) candidates.push({ name: dir === "" ? target : relativeFrom(dir, target), quoted: !angle });
      }
    }
    const good = candidates.find((candidate) => works(candidate.name, candidate.quoted));
    if (good !== undefined) return good.quoted ? good.name : `<${good.name}>`;
    const relative = relativeFrom(directoryOf(newIncluder), target);
    if (works(relative, true)) {
      warnings.push(`${newIncluder}:${include.line} "${include.specifier}" is no longer under an include directory that finds it, so it is now the quoted relative "${relative}": check whether a directory should be added to the build`);
      return relative;
    }
    warnings.push(`${newIncluder}:${include.line} "${include.specifier}" could not be respelled to reach ${target}`);
    return undefined;
  };

  for (const [path, text] of [...texts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isSource(path)) continue;
    const newPath = moves.get(path) ?? path;
    const dirs = includePaths.dirsFor(path);
    const lines = text.split("\n");
    for (const include of includes.get(path) ?? []) {
      if (include.specifier === null) {
        if (newPath !== path) warnings.push(`${newPath}:${include.line} the include path ${include.token} is built by a macro and was not rewritten: check it still reaches its file`);
        continue;
      }
      const next = spell(path, newPath, include, dirs);
      if (next === undefined || next === include.specifier) continue;
      const angle = next.startsWith("<");
      const token = angle ? next : `"${next}"`;
      lines[include.line - 1] = lines[include.line - 1]!.replace(include.token, token);
      rewrites.push({ path: newPath, line: include.line, from: include.specifier, to: next });
    }
    const rewritten = lines.join("\n");
    if (rewritten !== text) changed.set(newPath, rewritten);
  }

  for (const [path, text] of [...texts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isCmake(path)) continue;
    const directory = directoryOf(path);
    let result = text;
    for (const operation of operations) {
      if (!under(directory, operation.from)) continue;
      const old = relativeFrom(directory, operation.from);
      const next = relativeFrom(directory, operation.to);
      const pattern = new RegExp(`(?<![\\w.\\-/])((?:\\$\\{CMAKE_CURRENT_(?:SOURCE|LIST)_DIR\\}/)?)${escape(old)}(?![\\w.\\-/])`, "g");
      result = result.replace(pattern, (match: string, prefix: string, offset: number) => {
        const lineStart = result.lastIndexOf("\n", offset) + 1;
        if (result.slice(lineStart, offset).includes("#")) return match;
        rewrites.push({ path, line: result.slice(0, offset).split("\n").length, from: old, to: next });
        if (next.startsWith("..")) warnings.push(`${path} lists ${old}, which now lives outside its directory as ${next}: check that the target should still own it`);
        return `${prefix}${next}`;
      });
      for (const glob of text.matchAll(/\bfile\s*\(\s*GLOB(_RECURSE)?\b([^)]*)\)/gi)) {
        for (const token of glob[2]!.split(/\s+/)) {
          const entry = token.replace(/^"|"$/g, "").replace(/^\$\{CMAKE_CURRENT_(?:SOURCE|LIST)_DIR\}\//, "");
          if (!entry.includes("*")) continue;
          const matches = globRegExp(entry, glob[1] !== undefined);
          if (matches.test(old) && !matches.test(next)) warnings.push(`${path} collects sources with file(GLOB ${entry}): ${operation.to} is no longer matched, so the target would lose it`);
        }
      }
    }
    if (result !== text) changed.set(path, result);
  }

  rewrites.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  // A moved file whose text is unchanged is not listed, as for every language.
  return { rewrites, texts: new Map([...changed].sort(([a], [b]) => (a < b ? -1 : 1))), warnings: [...new Set(warnings)].sort() };
}

const referenceErrors = /file_not_found|unknown_typename|unknown_type|undeclared|no_member/;

/**
 * Asks clangd to check each file the move touches, in a copy of the moved tree with a compile_commands.json of
 * its own that gives every checked file the include directories the resolver used. Errors about a missing
 * include, an unknown type or an undeclared name mean a reference was lost. Other diagnostics (the toolchain's, the
 * code's own) are not this move's and are ignored.
 */
async function confirm(grammar: LoadedGrammar, tree: SourceTree, operations: readonly FileOperation[], tool: { name: string; path: string }): Promise<{ status: "confirmed" | "not confirmed"; detail: string }> {
  const moved = await plan(grammar, tree, operations);
  const moves = new Map(operations.map((operation) => [operation.from, operation.to]));
  const paths = [...tree.files.keys()];
  const configs = await tree.readMany(paths.filter(isConfig));
  const includePaths = includePathsOf(paths, configs);
  const originals = await tree.readMany(paths.filter((path) => isSource(path) || isCmake(path)));

  const directory = mkdtempSync(join(tmpdir(), "code-health-clangd-"));
  try {
    const written: { path: string; old: string }[] = [];
    for (const path of paths.filter(isSource)) {
      const newPath = moves.get(path) ?? path;
      mkdirSync(dirname(join(directory, newPath)), { recursive: true });
      writeFileSync(join(directory, newPath), moved.texts.get(newPath) ?? originals.get(path) ?? "");
      written.push({ path: newPath, old: path });
    }
    const checked = written.filter(({ path, old }) => moved.texts.has(path) || moves.has(old)).sort((a, b) => (a.path < b.path ? -1 : 1));
    if (checked.length === 0) return { status: "confirmed", detail: `${tool.name}: no C++ file changed` };
    const entries = written.map(({ path, old }) => ({
      directory,
      file: join(directory, path),
      arguments: ["clang++", "-std=c++17", ...(/\.(h|hh|hpp|hxx|h\+\+|inl|ipp|tpp)$/.test(path) ? ["-x", "c++-header"] : []), ...includePaths.dirsFor(old).map((dir) => `-I${join(directory, dir)}`), join(directory, path)],
    }));
    writeFileSync(join(directory, "compile_commands.json"), JSON.stringify(entries, null, 1));

    const problems: string[] = [];
    for (const { path } of checked.slice(0, 200)) {
      let output: string;
      try {
        const run = await execFileAsync(tool.path, [`--check=${join(directory, path)}`, `--compile-commands-dir=${directory}`], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
        output = `${run.stdout}\n${run.stderr}`;
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string };
        output = `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`;
      }
      for (const line of output.split("\n")) {
        const found = /^E\[[^\]]*\] \[([^\]]+)\] Line (\d+): (.*)$/.exec(line);
        if (found !== null && referenceErrors.test(found[1]!)) problems.push(`${path}:${found[2]} ${found[3]}`);
      }
    }
    return problems.length === 0
      ? { status: "confirmed", detail: `${tool.name} found every reference of ${checked.length} file${checked.length === 1 ? "" : "s"} after the move` }
      : { status: "not confirmed", detail: `${tool.name} reports ${problems.length} lost reference${problems.length === 1 ? "" : "s"}: ${problems.slice(0, 5).join("; ")}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function skeletonOf(grammar: LoadedGrammar, text: string): Skeleton {
  const includes = includesOf(grammar, text);
  const lines = text.split("\n");
  for (const include of includes) {
    if (include.specifier === null) continue;
    const blanked = include.token.startsWith("<") ? "<>" : '""';
    lines[include.line - 1] = lines[include.line - 1]!.replace(include.token, blanked);
  }
  return { text: lines.join("\n"), specifiers: includes.flatMap((include) => (include.specifier === null ? [] : [{ value: include.specifier, line: include.line }])) };
}

/** The mover of C++ files, with the C++ grammar loaded once so that `skeleton` can be synchronous. */
export async function createBackend(): Promise<MoverBackend> {
  const adapter = adapterById("cpp")!;
  const loaded = await new GrammarSet({ adapters: [adapter] }).forPath("x.cpp");
  const grammar = loaded!.grammar;
  return {
    performMove: (tree, operations) => plan(grammar, tree, operations),
    skeleton: (_path, text) => skeletonOf(grammar, text),
    confirm: (tree, operations, tool) => confirm(grammar, tree, operations, tool),
  };
}
