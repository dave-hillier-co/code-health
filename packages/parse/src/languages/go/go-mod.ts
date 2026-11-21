import { posix } from "node:path";

/** What the structural layer reads of a `go.mod`: the module's path, what it requires and what it replaces with a local directory. */
export interface GoModule {
  /** Directory of the go.mod, "." for the root. */
  dir: string;
  /** The `module` directive, or null when the file has none. */
  path: string | null;
  requires: { path: string; indirect: boolean }[];
  /** Module paths replaced by a directory of the repository, to that directory. */
  replaces: { from: string; dir: string }[];
}

export const isGoModFile = (path: string): boolean => path === "go.mod" || path.endsWith("/go.mod");
export const isGoWorkFile = (path: string): boolean => path === "go.work" || path.endsWith("/go.work");

/** Directive lines of a go.mod or go.work, with block directives (`require ( ... )`) flattened to `verb rest`, and the trailing comment kept. */
function directives(text: string): { verb: string; rest: string; comment: string }[] {
  const out: { verb: string; rest: string; comment: string }[] = [];
  let block: string | undefined;
  for (const raw of text.split("\n")) {
    const comment = raw.includes("//") ? raw.slice(raw.indexOf("//") + 2).trim() : "";
    const line = (raw.includes("//") ? raw.slice(0, raw.indexOf("//")) : raw).trim();
    if (line === "") continue;
    if (block !== undefined) {
      if (line === ")") block = undefined;
      else out.push({ verb: block, rest: line, comment });
      continue;
    }
    const open = /^(\w+)\s*\($/.exec(line);
    if (open !== null) {
      block = open[1]!;
      continue;
    }
    const [verb = "", ...rest] = line.split(/\s+/);
    out.push({ verb, rest: rest.join(" "), comment });
  }
  return out;
}

const unquote = (value: string): string => value.replace(/^["`]|["`]$/g, "");

/** Reads a go.mod. A replacement outside the repository, or to another module version, names no directory and is left out. */
export function parseGoMod(path: string, text: string): GoModule {
  const dir = posix.dirname(path);
  const module: GoModule = { dir, path: null, requires: [], replaces: [] };
  for (const { verb, rest, comment } of directives(text)) {
    if (verb === "module") module.path = unquote(rest.split(/\s+/)[0] ?? "");
    else if (verb === "require") {
      const name = unquote(rest.split(/\s+/)[0] ?? "");
      if (name !== "") module.requires.push({ path: name, indirect: /^indirect\b/.test(comment) });
    } else if (verb === "replace") {
      const [from = "", target = ""] = rest.split("=>").map((side) => side.trim());
      const to = unquote(target.split(/\s+/)[0] ?? "");
      if (/^\.{1,2}(\/|$)/.test(to)) module.replaces.push({ from: unquote(from.split(/\s+/)[0] ?? ""), dir: posix.normalize(dir === "." ? to : posix.join(dir, to)) });
    }
  }
  return module;
}

/** The directories a go.work lists with `use`, relative to the repository root. */
export function parseGoWork(path: string, text: string): string[] {
  const dir = posix.dirname(path);
  return directives(text)
    .filter((directive) => directive.verb === "use")
    .map((directive) => posix.normalize(dir === "." ? unquote(directive.rest) : posix.join(dir, unquote(directive.rest))));
}

/** Every module of a set of config files, sorted by directory. */
export function modulesOf(configs: ReadonlyMap<string, string>): GoModule[] {
  return [...configs]
    .filter(([path]) => isGoModFile(path))
    .map(([path, text]) => parseGoMod(path, text))
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/**
 * The directory of the package an import path names, when the path lies inside a module the repository
 * holds (by its own go.mod or a local `replace`): the longest matching module path wins. Undefined for
 * everything else (the standard library and modules outside the repository).
 */
export function importPathToDirectory(modules: readonly GoModule[], importPath: string): { dir: string; module: GoModule } | undefined {
  let best: { prefix: string; dir: string; module: GoModule } | undefined;
  const consider = (prefix: string, dir: string, module: GoModule): void => {
    if ((importPath === prefix || importPath.startsWith(`${prefix}/`)) && (best === undefined || prefix.length > best.prefix.length)) best = { prefix, dir, module };
  };
  for (const module of modules) {
    if (module.path !== null) consider(module.path, module.dir, module);
    for (const replaced of module.replaces) consider(replaced.from, replaced.dir, module);
  }
  if (best === undefined) return undefined;
  const rest = importPath.slice(best.prefix.length + 1);
  const dir = rest === "" ? best.dir : posix.normalize(best.dir === "." ? rest : posix.join(best.dir, rest));
  // A directory with a go.mod of its own is another module: the parent module's path does not reach into it.
  const owner = moduleOwning(modules, `${dir}/_`);
  if (owner !== undefined && owner.dir !== best.dir && owner.path !== best.prefix && !best.module.replaces.some((replaced) => replaced.from === best.prefix)) return undefined;
  return { dir, module: best.module };
}

/** The import path of a directory of the repository, from the module that contains it. */
export function directoryToImportPath(modules: readonly GoModule[], dir: string): string | undefined {
  let best: GoModule | undefined;
  for (const module of modules) {
    if (module.path === null) continue;
    const inside = module.dir === "." || dir === module.dir || dir.startsWith(`${module.dir}/`);
    if (inside && (best === undefined || module.dir.length > best.dir.length)) best = module;
  }
  if (best === undefined || best.path === null) return undefined;
  const rest = best.dir === "." ? dir : dir === best.dir ? "" : dir.slice(best.dir.length + 1);
  return rest === "" || rest === "." ? best.path : `${best.path}/${rest}`;
}

/** The module of the repository that owns a file: the one with the deepest go.mod above it. */
export function moduleOwning(modules: readonly GoModule[], path: string): GoModule | undefined {
  let best: GoModule | undefined;
  for (const module of modules) {
    const inside = module.dir === "." || path.startsWith(`${module.dir}/`);
    if (inside && (best === undefined || module.dir.length > best.dir.length)) best = module;
  }
  return best;
}

/**
 * The module an import of a package outside the repository belongs to. The required module whose path is
 * the longest prefix of the import path, or, when go.mod does not require it, the conventional root of the
 * path: three elements on the large hosts, two elsewhere.
 */
export function externalModuleOf(module: GoModule | undefined, importPath: string): string {
  let best: string | undefined;
  for (const required of module?.requires ?? []) {
    if ((importPath === required.path || importPath.startsWith(`${required.path}/`)) && (best === undefined || required.path.length > best.length)) best = required.path;
  }
  if (best !== undefined) return best;
  const parts = importPath.split("/");
  return parts.slice(0, /^(github\.com|gitlab\.com|bitbucket\.org|golang\.org)$/.test(parts[0] ?? "") ? 3 : 2).join("/");
}

/** The standard library has no dot in the first element of its import paths. */
export function isStandardLibrary(importPath: string): boolean {
  return !(importPath.split("/")[0] ?? "").includes(".");
}

/** The name a package is reached by when an import gives none: the last element of the path, without a version suffix or a `go-` prefix. */
export function defaultPackageName(importPath: string): string {
  const parts = importPath.split("/");
  let last = parts.at(-1) ?? importPath;
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts.at(-2) ?? last;
  return last.replace(/^go-/, "").replace(/\.v\d+$/, "");
}
