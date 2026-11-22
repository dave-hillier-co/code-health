import { posix } from "node:path";
import { parseCmake } from "./cmake.ts";

/**
 * Where `#include` looks. The authority is `compile_commands.json` (the flags the build gives each source
 * file): a tracked one, or one `analyseTree` was given from the usual build directories. The config `includeRoots`
 * come next, then `target_include_directories` and `include_directories` in the CMakeLists.txt files, applied to the
 * files under the directory that states them, then the directories inferred from the includes that still found no
 * file (see `inferIncludeRoots`), and the repository root is the last place tried.
 */

export interface IncludePaths {
  /** Repo-relative directories to try for a file, in order, without duplicates. "" is the root. `inferred` are put before the root. */
  dirsFor(file: string, inferred?: readonly string[]): string[];
  /** The `compile_commands.json` files read, or null when there are none. */
  compileCommands: { paths: string[]; tracked: boolean } | null;
  /** The configured `includeRoots`, normalised. */
  configuredRoots: string[];
}

export interface IncludePathOptions {
  /** The config `includeRoots`: repo-relative directories, every file tries them. */
  includeRoots?: readonly string[];
  /** Config paths that were read from disk and are not in the tree, so that they are reported as untracked. */
  untracked?: ReadonlySet<string>;
}

interface CompileEntry {
  directory: string;
  file: string;
  flags: string[];
}

/** Absolute prefixes that name the system and never the repository. */
const systemPrefixes = ["/usr/", "/lib/", "/System/", "/Library/", "/Applications/", "/etc/", "/bin/", "/sbin/", "/opt/homebrew/", "/opt/local/"];

/** Splits a command line the way a shell would for flags: whitespace separates, quotes and backslashes group. */
function splitCommand(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < command.length) {
      current += command[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started || current !== "") out.push(current);
      current = "";
      started = false;
    } else {
      current += c;
    }
  }
  if (started || current !== "") out.push(current);
  return out;
}

function entriesOf(text: string): CompileEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: CompileEntry[] = [];
  for (const item of parsed as Record<string, unknown>[]) {
    if (typeof item !== "object" || item === null || typeof item.file !== "string") continue;
    const flags = Array.isArray(item.arguments) ? (item.arguments as unknown[]).filter((a): a is string => typeof a === "string") : typeof item.command === "string" ? splitCommand(item.command) : [];
    entries.push({ directory: typeof item.directory === "string" ? item.directory : "", file: item.file, flags });
  }
  return entries;
}

const includeFlags = ["-I", "-isystem", "-iquote", "-idirafter"];

/** The directories named by include flags, in the order written. */
function includeDirectories(flags: readonly string[]): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    for (const prefix of includeFlags) {
      if (flag === prefix) {
        const next = flags[++i];
        if (next !== undefined) dirs.push(next);
        break;
      }
      if (flag.startsWith(prefix) && (prefix === "-I" || flag.length > prefix.length)) {
        dirs.push(flag.slice(prefix.length));
        break;
      }
    }
  }
  return dirs;
}

/** A configured include root as a repo-relative directory, "" for the root: `./`, `.` and `src/` become "", "" and "src". */
const normaliseRoot = (root: string): string => {
  const cleaned = posix.normalize(root.replaceAll("\\", "/")).replace(/\/+$/, "");
  return cleaned === "." ? "" : cleaned;
};

export function includePathsOf(paths: readonly string[], configs: ReadonlyMap<string, string>, options: IncludePathOptions = {}): IncludePaths {
  const files = new Set(paths);
  const directories = new Set<string>([""]);
  for (const path of paths) {
    for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) directories.add(path.slice(0, slash));
  }

  /** A path from a build file as a repo-relative one: relative ones are joined to `base`, absolute ones are matched by their longest tail that exists in the tree. */
  const toTree = (path: string, base: string, isFile: boolean): string | undefined => {
    const isAbsolute = (value: string): boolean => value.startsWith("/") || /^[A-Za-z]:\//.test(value);
    const written = path.replaceAll("\\", "/");
    const from = base.replaceAll("\\", "/");
    if (!isAbsolute(written) && !isAbsolute(from)) {
      const joined = posix.normalize(from === "" ? written : `${from}/${written}`);
      return joined === ".." || joined.startsWith("../") ? undefined : joined === "." ? "" : joined.replace(/\/$/, "");
    }
    const whole = posix.normalize(isAbsolute(written) ? written : `${from}/${written}`).replace(/^[A-Za-z]:/, "");
    if (systemPrefixes.some((prefix) => whole.startsWith(prefix))) return undefined;
    const parts = whole.split("/").filter((part) => part !== "");
    for (let start = 0; start < parts.length; start++) {
      const candidate = parts.slice(start).join("/");
      if (isFile ? files.has(candidate) : directories.has(candidate)) return candidate;
    }
    return undefined;
  };

  const forFile = new Map<string, string[]>();
  const everyEntry: string[] = [];
  const compileCommandPaths: string[] = [];
  for (const [path, text] of configs) {
    if (posix.basename(path) !== "compile_commands.json") continue;
    compileCommandPaths.push(path);
    const base = posix.dirname(path) === "." ? "" : posix.dirname(path);
    for (const entry of entriesOf(text)) {
      const directory = entry.directory === "" ? base : entry.directory;
      const source = toTree(entry.file, directory, true);
      const dirs = includeDirectories(entry.flags).flatMap((dir) => toTree(dir, directory, false) ?? []);
      if (source !== undefined) forFile.set(source, [...(forFile.get(source) ?? []), ...dirs]);
      everyEntry.push(...dirs);
    }
  }

  // A target's own include directories apply to the files under its CMakeLists.txt, and the public ones of every
  // target it links (at any depth) are added, which is how CMake hands a library's headers to its users.
  const parsedFiles = [...configs]
    .filter(([path]) => posix.basename(path) === "CMakeLists.txt")
    .map(([path, text]) => ({ directory: posix.dirname(path) === "." ? "" : posix.dirname(path), parsed: parseCmake(text) }));
  const publicOf = new Map<string, { dirs: string[]; links: string[] }>();
  for (const { directory, parsed } of parsedFiles) {
    for (const target of parsed.targets) {
      publicOf.set(target.name, { dirs: target.publicIncludes.flatMap((dir) => toTree(dir, directory, false) ?? []), links: target.links });
    }
  }
  const reachable = (links: readonly string[], seen = new Set<string>()): string[] => {
    const dirs: string[] = [];
    for (const name of links) {
      if (seen.has(name)) continue;
      seen.add(name);
      const found = publicOf.get(name);
      if (found !== undefined) dirs.push(...found.dirs, ...reachable(found.links, seen));
    }
    return dirs;
  };
  const cmake = new Map<string, string[]>();
  for (const { directory, parsed } of parsedFiles) {
    const own = [...parsed.includeDirectories, ...parsed.targets.flatMap((target) => [...target.publicIncludes, ...target.privateIncludes])].flatMap((dir) => toTree(dir, directory, false) ?? []);
    const linked = reachable(parsed.targets.flatMap((target) => target.links));
    const resolved = [...own, ...linked];
    if (resolved.length > 0) cmake.set(directory, resolved);
  }

  const configuredRoots = [...new Set((options.includeRoots ?? []).map(normaliseRoot))];
  const untracked = options.untracked ?? new Set<string>();
  return {
    compileCommands: compileCommandPaths.length === 0 ? null : { paths: compileCommandPaths, tracked: compileCommandPaths.every((path) => !untracked.has(path)) },
    configuredRoots,
    dirsFor(file, inferred = []) {
      const dirs: string[] = [...(forFile.get(file) ?? (forFile.size > 0 ? everyEntry : [])), ...configuredRoots];
      for (let dir = posix.dirname(file) === "." ? "" : posix.dirname(file); ; dir = posix.dirname(dir) === "." ? "" : posix.dirname(dir)) {
        dirs.push(...(cmake.get(dir) ?? []));
        if (dir === "") break;
      }
      dirs.push(...inferred, "");
      return [...new Set(dirs)];
    },
  };
}

/** A quoted or angle include that found no file. */
export interface UnresolvedInclude {
  specifier: string;
}

/** An inferred root must make at least this many includes resolve. A directory that resolves one include is more likely a name that two files share than an include root. */
const MIN_INFERRED_COVERAGE = 2;

/**
 * Include directories inferred from the includes that found no file: for each, the directories that hold a file at
 * the path the include names (for `"stage/Terrain.h"`, `src` when `src/stage/Terrain.h` exists). The directories are
 * chosen greedily, each taking the most includes that no earlier one covers, shallower directories first on a tie,
 * and a directory that would cover fewer than two includes is not chosen. Returns directories in the order chosen.
 * A root of "" is never returned, because the root is always tried.
 */
export function inferIncludeRoots(unresolved: readonly UnresolvedInclude[], paths: readonly string[]): string[] {
  const byBasename = new Map<string, string[]>();
  for (const path of paths) {
    const name = posix.basename(path);
    byBasename.set(name, [...(byBasename.get(name) ?? []), path]);
  }
  const wanted = new Map<string, number>();
  for (const { specifier } of unresolved) {
    if (specifier.startsWith("<")) continue;
    const name = specifier;
    wanted.set(name, (wanted.get(name) ?? 0) + 1);
  }
  // Which roots would resolve each distinct include, and how many statements it stands for.
  const rootsOf = new Map<string, string[]>();
  for (const name of wanted.keys()) {
    const normal = posix.normalize(name);
    const found: string[] = [];
    for (const path of byBasename.get(posix.basename(normal)) ?? []) {
      if (path === normal) continue;
      if (path.endsWith(`/${normal}`)) found.push(path.slice(0, path.length - normal.length - 1));
    }
    if (found.length > 0) rootsOf.set(name, found);
  }
  const chosen: string[] = [];
  const covered = new Set<string>();
  for (;;) {
    const gain = new Map<string, number>();
    for (const [name, roots] of rootsOf) {
      if (covered.has(name)) continue;
      for (const root of new Set(roots)) gain.set(root, (gain.get(root) ?? 0) + (wanted.get(name) ?? 0));
    }
    const best = [...gain].sort(([a, x], [b, y]) => y - x || a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0))[0];
    if (best === undefined || best[1] < MIN_INFERRED_COVERAGE) return chosen;
    chosen.push(best[0]);
    for (const [name, roots] of rootsOf) if (roots.includes(best[0])) covered.add(name);
  }
}
