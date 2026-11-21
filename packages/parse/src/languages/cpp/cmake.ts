/**
 * The part of a CMakeLists.txt the structural layer reads: build targets, their sources and include
 * directories. It is a reader of commands as written, not CMake: variables are not expanded (the two that
 * name the current directory are dropped, the rest make an argument unreadable and it is skipped), conditions
 * are not evaluated, and a target built in a loop or by a macro is not seen.
 */

export interface CmakeTarget {
  name: string;
  kind: "library" | "executable";
  /** Sources named in `add_library`, `add_executable` and `target_sources`, relative to the CMakeLists directory. */
  sources: string[];
  /** Directories a consumer of the target compiles with (`PUBLIC` and `INTERFACE`), relative to the CMakeLists directory. */
  publicIncludes: string[];
  /** Directories only the target itself compiles with (`PRIVATE`), relative to the CMakeLists directory. */
  privateIncludes: string[];
  /** Names after `target_link_libraries`, scope keywords left out. */
  links: string[];
}

export interface CmakeFile {
  project: string | null;
  targets: CmakeTarget[];
  /** `include_directories(...)`, which every target of the directory compiles with. */
  includeDirectories: string[];
  subdirectories: string[];
}

interface Command {
  name: string;
  args: string[];
}

function stripComments(text: string): string {
  // `#` starts a comment unless it is inside quotes, and bracket comments are rare enough to leave.
  let out = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' && text[i - 1] !== "\\") quoted = !quoted;
    if (c === "#" && !quoted) {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

function tokens(text: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|([^\s"]+)/g;
  for (const match of text.matchAll(pattern)) out.push(match[1] ?? match[2]!);
  return out;
}

function commands(text: string): Command[] {
  const source = stripComments(text);
  const found: Command[] = [];
  const start = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = start.exec(source)) !== null) {
    let depth = 1;
    let quoted = false;
    let i = start.lastIndex;
    for (; i < source.length && depth > 0; i++) {
      const c = source[i]!;
      if (c === '"' && source[i - 1] !== "\\") quoted = !quoted;
      else if (!quoted && c === "(") depth++;
      else if (!quoted && c === ")") depth--;
    }
    found.push({ name: match[1]!.toLowerCase(), args: tokens(source.slice(start.lastIndex, i - 1)) });
    start.lastIndex = i;
  }
  return found;
}

/** An argument as a path relative to the directory, or undefined when it cannot be read without expanding variables. */
function pathArgument(argument: string): string | undefined {
  let value = argument.replace(/\$<BUILD_INTERFACE:([^>]*)>/g, "$1").replace(/\$<INSTALL_INTERFACE:[^>]*>/g, "");
  value = value.replace(/\$\{(?:CMAKE_CURRENT_SOURCE_DIR|CMAKE_CURRENT_LIST_DIR)\}\/?/g, "");
  if (value === "" || /\$[{<]/.test(value) || value.startsWith("-")) return undefined;
  value = value.replace(/^\.\//, "").replace(/\/$/, "");
  return value === "." ? "" : value;
}

const scopes = new Set(["PUBLIC", "PRIVATE", "INTERFACE"]);
const libraryTypes = new Set(["STATIC", "SHARED", "MODULE", "OBJECT", "INTERFACE", "EXCLUDE_FROM_ALL"]);
const includeFlags = new Set(["SYSTEM", "BEFORE", "AFTER"]);

export function parseCmake(text: string): CmakeFile {
  const file: CmakeFile = { project: null, targets: [], includeDirectories: [], subdirectories: [] };
  const byName = new Map<string, CmakeTarget>();
  const all = commands(text);

  for (const command of all) {
    const [first, ...rest] = command.args;
    if (command.name === "project" && first !== undefined) file.project ??= first;
    if ((command.name === "add_library" || command.name === "add_executable") && first !== undefined) {
      if (rest.some((argument) => argument === "ALIAS" || argument === "IMPORTED")) continue;
      const sources = rest.filter((argument) => !libraryTypes.has(argument) && argument !== "WIN32" && argument !== "MACOSX_BUNDLE").flatMap((argument) => pathArgument(argument) ?? []);
      const target: CmakeTarget = { name: first, kind: command.name === "add_library" ? "library" : "executable", sources, publicIncludes: [], privateIncludes: [], links: [] };
      file.targets.push(target);
      byName.set(first, target);
    }
  }
  for (const command of all) {
    const [first, ...rest] = command.args;
    if (first === undefined) continue;
    switch (command.name) {
      case "target_sources": {
        const target = byName.get(first);
        if (target !== undefined) target.sources.push(...rest.filter((argument) => !scopes.has(argument) && argument !== "FILE_SET" && argument !== "HEADERS").flatMap((argument) => pathArgument(argument) ?? []));
        break;
      }
      case "target_include_directories": {
        const target = byName.get(first);
        if (target === undefined) break;
        let scope: "PUBLIC" | "PRIVATE" | "INTERFACE" = "PRIVATE";
        for (const argument of rest) {
          if (scopes.has(argument)) scope = argument as typeof scope;
          else if (!includeFlags.has(argument)) {
            const dir = pathArgument(argument);
            if (dir !== undefined) (scope === "PRIVATE" ? target.privateIncludes : target.publicIncludes).push(dir);
          }
        }
        break;
      }
      case "target_link_libraries": {
        const target = byName.get(first);
        if (target !== undefined) target.links.push(...rest.filter((argument) => !scopes.has(argument) && !/^(debug|optimized|general)$/i.test(argument) && !/\$[{<]/.test(argument)));
        break;
      }
      case "include_directories":
        file.includeDirectories.push(...[first, ...rest].filter((argument) => !includeFlags.has(argument)).flatMap((argument) => pathArgument(argument) ?? []));
        break;
      case "add_subdirectory": {
        const dir = pathArgument(first);
        if (dir !== undefined) file.subdirectories.push(dir);
        break;
      }
      default:
    }
  }
  return file;
}

/**
 * The headers a CMakeLists.txt in `dir` publishes: every header under a directory its library targets
 * hand to their consumers (`PUBLIC` or `INTERFACE` include directories). `declared` is false when no
 * library says, so what is public is not stated and nothing can be called internal.
 */
export function publicHeaders(dir: string, file: CmakeFile, paths: readonly string[], isHeader: (path: string) => boolean): { files: string[]; declared: boolean } {
  const roots = file.targets.filter((target) => target.kind === "library").flatMap((target) => target.publicIncludes);
  const prefixes = [...new Set(roots.map((root) => (dir === "" ? root : root === "" ? dir : `${dir}/${root}`)))];
  if (prefixes.length === 0) return { files: [], declared: false };
  const files = paths.filter((path) => isHeader(path) && prefixes.some((prefix) => prefix === "" || path.startsWith(`${prefix}/`)));
  return { files: files.sort(), declared: true };
}
