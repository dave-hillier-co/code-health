import { posix } from "node:path";
import { parseCmake } from "./cmake.ts";

/**
 * Where `#include` looks. The authority is `compile_commands.json` (the flags the build gives each source
 * file); `target_include_directories` and `include_directories` in the CMakeLists.txt files are the fallback
 * for a tree that has none, applied to the files under the directory that states them, and the repository
 * root is the last place tried. The compiler never searched the root unasked, so this is the one guess.
 */

export interface IncludePaths {
  /** Repo-relative directories to try for a file, in order, without duplicates. "" is the root. */
  dirsFor(file: string): string[];
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

export function includePathsOf(paths: readonly string[], configs: ReadonlyMap<string, string>): IncludePaths {
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
  for (const [path, text] of configs) {
    if (posix.basename(path) !== "compile_commands.json") continue;
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

  return {
    dirsFor(file) {
      const dirs: string[] = [...(forFile.get(file) ?? (forFile.size > 0 ? everyEntry : []))];
      for (let dir = posix.dirname(file) === "." ? "" : posix.dirname(file); ; dir = posix.dirname(dir) === "." ? "" : posix.dirname(dir)) {
        dirs.push(...(cmake.get(dir) ?? []));
        if (dir === "") break;
      }
      dirs.push("");
      return [...new Set(dirs)];
    },
  };
}
