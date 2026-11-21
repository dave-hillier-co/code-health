import { builtinModules } from "node:module";
import { posix } from "node:path";
import { parseJsonc } from "./jsonc.ts";

export type Resolution =
  | { kind: "file"; path: string }
  | { kind: "builtin" }
  | { kind: "external"; packageName: string }
  | { kind: "not-found" };

/** Config files the resolver reads, which callers must supply by path. */
export function isConfigPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "package.json" || (name.startsWith("tsconfig") && name.endsWith(".json"));
}

interface PathsOptions {
  /** Repo-relative directory that targets are relative to. */
  base: string;
  patterns: { pattern: string; targets: string[] }[];
}

interface TsOptions {
  /** Repo-relative baseUrl directory. */
  baseUrl?: string;
  paths?: PathsOptions;
}

interface WorkspacePackage {
  name: string;
  dir: string;
  exports?: unknown;
  entry?: string;
}

const sourceExtensions = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
/** An emitted JavaScript extension and the TypeScript sources that compile to it. */
const emittedExtensions: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const builtins = new Set(builtinModules);

function join(directory: string, relative: string): string | undefined {
  const joined = posix.normalize(directory === "" ? relative : `${directory}/${relative}`);
  if (joined === ".." || joined.startsWith("../") || joined.startsWith("/")) return undefined;
  return joined === "." ? "" : joined.replace(/\/$/, "");
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Splits `@scope/name/sub` or `name/sub` into the package name and a `./sub` subpath. */
function splitPackageSpecifier(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split("/");
  const nameParts = specifier.startsWith("@") ? 2 : 1;
  return { name: parts.slice(0, nameParts).join("/"), subpath: `.${parts.slice(nameParts).map((p) => `/${p}`).join("")}` };
}

/**
 * Maps import specifiers to files of one tree: relative paths, tsconfig
 * `paths` and `baseUrl`, and workspace packages by `exports`, `main` or
 * subpath. Everything else is an external package.
 */
export class SpecifierResolver {
  private readonly files: ReadonlySet<string>;
  private readonly tsconfigTexts = new Map<string, string>();
  private readonly tsOptionsCache = new Map<string, TsOptions | undefined>();
  private readonly packages: WorkspacePackage[] = [];

  constructor(files: Iterable<string>, configs: ReadonlyMap<string, string>) {
    this.files = new Set(files);
    for (const [path, text] of configs) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (name === "package.json") this.addPackage(path, text);
      else this.tsconfigTexts.set(path, text);
    }
    this.packages.sort((a, b) => b.name.length - a.name.length);
  }

  resolve(from: string, specifier: string): Resolution {
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..") {
      const target = join(directoryOf(from), specifier);
      const file = target === undefined ? undefined : this.resolveFile(target);
      return file === undefined ? { kind: "not-found" } : { kind: "file", path: file };
    }
    if (specifier.startsWith("node:")) return { kind: "builtin" };

    const options = this.optionsFor(from);
    let pathsMatched = false;
    for (const { pattern, targets } of options?.paths?.patterns ?? []) {
      const star = matchPattern(pattern, specifier);
      if (star === undefined) continue;
      pathsMatched = true;
      for (const target of targets) {
        const resolved = join(options?.paths?.base ?? "", target.replace("*", star));
        const file = resolved === undefined ? undefined : this.resolveFile(resolved);
        if (file !== undefined) return { kind: "file", path: file };
      }
      break;
    }
    if (options?.baseUrl !== undefined) {
      const resolved = join(options.baseUrl, specifier);
      const file = resolved === undefined ? undefined : this.resolveFile(resolved);
      if (file !== undefined) return { kind: "file", path: file };
    }
    const { name, subpath } = splitPackageSpecifier(specifier);
    const workspace = this.packages.find((candidate) => candidate.name === name);
    if (workspace) {
      const file = this.resolveInPackage(workspace, subpath);
      return file === undefined ? { kind: "not-found" } : { kind: "file", path: file };
    }
    if (builtins.has(specifier.split("/")[0] as string)) return { kind: "builtin" };
    return pathsMatched ? { kind: "not-found" } : { kind: "external", packageName: name };
  }

  /** A file for an extensionless or emitted-extension path, or a directory with an index. */
  private resolveFile(path: string): string | undefined {
    const extension = /\.[cm]?[jt]sx?$/.exec(path)?.[0];
    const stem = extension ? path.slice(0, -extension.length) : undefined;
    for (const source of (extension && emittedExtensions[extension]) || []) {
      if (this.files.has(`${stem}${source}`)) return `${stem}${source}`;
    }
    if (this.files.has(path)) return path;
    for (const candidate of sourceExtensions) if (this.files.has(path + candidate)) return path + candidate;
    for (const candidate of sourceExtensions) {
      const index = path === "" ? `index${candidate}` : `${path}/index${candidate}`;
      if (this.files.has(index)) return index;
    }
    return undefined;
  }

  private addPackage(path: string, text: string): void {
    const json = asRecord(parseJsonc(text));
    if (typeof json?.name !== "string") return;
    const entry = [json.module, json.main].find((value) => typeof value === "string") as string | undefined;
    this.packages.push({ name: json.name, dir: directoryOf(path), exports: json.exports, entry });
  }

  private resolveInPackage(pkg: WorkspacePackage, subpath: string): string | undefined {
    if (pkg.exports !== undefined && pkg.exports !== null) {
      const map = asRecord(pkg.exports);
      const subpaths = map && Object.keys(map).some((key) => key.startsWith(".")) ? map : { ".": pkg.exports };
      let target: unknown;
      if (subpath in subpaths) {
        target = subpaths[subpath];
      } else {
        const patterns = Object.keys(subpaths)
          .filter((key) => key.includes("*"))
          .sort((a, b) => prefixLength(b) - prefixLength(a));
        for (const key of patterns) {
          const star = matchPattern(key, subpath);
          if (star !== undefined) {
            target = substitute(subpaths[key], star);
            break;
          }
        }
      }
      return this.resolveExportTarget(pkg.dir, target);
    }
    if (subpath === ".") {
      const entry = pkg.entry === undefined ? undefined : join(pkg.dir, pkg.entry);
      return (entry === undefined ? undefined : this.resolveFile(entry)) ?? this.resolveFile(pkg.dir);
    }
    const target = join(pkg.dir, subpath);
    return target === undefined ? undefined : this.resolveFile(target);
  }

  /**
   * Follows string, array and condition targets. Conditions keep their listed order, except that
   * `require` comes after the rest (the graph shows what a bundler sees) and `types` comes last
   * because it points at declarations.
   */
  private resolveExportTarget(dir: string, target: unknown): string | undefined {
    if (typeof target === "string") {
      const resolved = join(dir, target);
      if (resolved === undefined) return undefined;
      const built = this.resolveFile(resolved);
      if (built !== undefined) return built;
      // A build directory that is not committed: the same path under src is what the build is made from.
      const relative = join("", target);
      const fromSource = relative?.replace(/^(dist|build|out|lib)\//, "src/");
      const sourced = fromSource === undefined || fromSource === relative ? undefined : join(dir, fromSource);
      return sourced === undefined ? undefined : this.resolveFile(sourced);
    }
    if (Array.isArray(target)) {
      for (const item of target) {
        const found = this.resolveExportTarget(dir, item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    const conditions = asRecord(target);
    if (!conditions) return undefined;
    const keys = Object.keys(conditions);
    const rank = (key: string) => (key.startsWith("types") ? 2 : key === "require" ? 1 : 0);
    const ordered = [...keys].sort((a, b) => rank(a) - rank(b));
    for (const key of ordered) {
      const found = this.resolveExportTarget(dir, conditions[key]);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private optionsFor(from: string): TsOptions | undefined {
    let directory = directoryOf(from);
    for (;;) {
      const config = directory === "" ? "tsconfig.json" : `${directory}/tsconfig.json`;
      if (this.tsconfigTexts.has(config)) return this.withReferences(config, from);
      if (directory === "") return undefined;
      directory = directoryOf(directory);
    }
  }

  /**
   * The options of `config`, or when it sets no `paths` or `baseUrl` itself and has `references`
   * (a solution config), those of the referenced config that includes `from`.
   */
  private withReferences(config: string, from: string): TsOptions | undefined {
    const own = this.loadOptions(config);
    if (own?.paths || own?.baseUrl !== undefined) return own;
    const json = asRecord(parseJsonc(this.tsconfigTexts.get(config) ?? ""));
    const references = Array.isArray(json?.references) ? json.references : [];
    const dir = directoryOf(config);
    const referenced: { path: string; json: Record<string, unknown> | undefined }[] = [];
    for (const reference of references) {
      const target = typeof asRecord(reference)?.path === "string" ? join(dir, asRecord(reference)!.path as string) : undefined;
      if (target === undefined) continue;
      const path = [target, `${target}.json`, `${target}/tsconfig.json`].find((candidate) => this.tsconfigTexts.has(candidate));
      if (path !== undefined) referenced.push({ path, json: asRecord(parseJsonc(this.tsconfigTexts.get(path)!)) });
    }
    const covering = referenced.find((candidate) => includes(candidate.path, candidate.json, from));
    const chosen = covering ?? referenced.find((candidate) => {
      const options = this.loadOptions(candidate.path);
      return options?.paths || options?.baseUrl !== undefined;
    });
    return chosen === undefined ? own : this.loadOptions(chosen.path) ?? own;
  }

  /** Reads a tsconfig and the configs it extends. `paths` replaces rather than merges, as in TypeScript. */
  private loadOptions(config: string, seen: ReadonlySet<string> = new Set()): TsOptions | undefined {
    if (this.tsOptionsCache.has(config)) return this.tsOptionsCache.get(config);
    const text = this.tsconfigTexts.get(config);
    const json = text === undefined || seen.has(config) ? undefined : asRecord(parseJsonc(text));
    let result: TsOptions | undefined;
    if (json) {
      const dir = directoryOf(config);
      const inherited: TsOptions = {};
      const extended = json.extends;
      for (const parent of Array.isArray(extended) ? extended : extended === undefined ? [] : [extended]) {
        if (typeof parent !== "string" || !parent.startsWith(".")) continue;
        const target = join(dir, parent);
        const candidates = target === undefined ? [] : [target, `${target}.json`];
        const found = candidates.find((candidate) => this.tsconfigTexts.has(candidate));
        const options = found === undefined ? undefined : this.loadOptions(found, new Set([...seen, config]));
        if (options?.baseUrl !== undefined) inherited.baseUrl = options.baseUrl;
        if (options?.paths) inherited.paths = options.paths;
      }
      const compilerOptions = asRecord(json.compilerOptions);
      if (typeof compilerOptions?.baseUrl === "string") {
        const baseUrl = join(dir, compilerOptions.baseUrl);
        if (baseUrl !== undefined) inherited.baseUrl = baseUrl;
      }
      const paths = asRecord(compilerOptions?.paths);
      if (paths) {
        inherited.paths = {
          base: dir,
          patterns: Object.entries(paths)
            .map(([pattern, targets]) => ({
              pattern,
              targets: Array.isArray(targets) ? targets.filter((t): t is string => typeof t === "string") : [],
            }))
            .sort((a, b) => prefixLength(b.pattern) - prefixLength(a.pattern)),
        };
      }
      result = inherited;
    }
    this.tsOptionsCache.set(config, result);
    if (result?.paths && result.baseUrl !== undefined) {
      // TypeScript resolves `paths` targets against baseUrl whenever one is set.
      result = { ...result, paths: { ...result.paths, base: result.baseUrl } };
      this.tsOptionsCache.set(config, result);
    }
    return result;
  }
}

/** Whether a tsconfig's `include` (default: everything beneath it) covers a file, judged by literal directory prefixes. */
function includes(config: string, json: Record<string, unknown> | undefined, file: string): boolean {
  const dir = directoryOf(config);
  const patterns = Array.isArray(json?.include) ? json.include.filter((p): p is string => typeof p === "string") : undefined;
  if (patterns === undefined) return dir === "" || file.startsWith(`${dir}/`);
  return patterns.some((pattern) => {
    const literal = pattern.split("/").filter((part, index, parts) => !/[*?]/.test(part) && parts.slice(0, index).every((p) => !/[*?]/.test(p)));
    const base = join(dir, literal.join("/"));
    if (base === undefined) return false;
    const last = pattern.split("/").at(-1) ?? "";
    const isFile = !/[*?]/.test(pattern) && /\.[a-z]+$/.test(last);
    return base === "" || (isFile ? file === base : file === base || file.startsWith(`${base}/`));
  });
}

/** Patterns with the longest literal prefix win, and a pattern with no `*` beats any wildcard. */
function prefixLength(pattern: string): number {
  const star = pattern.indexOf("*");
  return star < 0 ? Number.POSITIVE_INFINITY : star;
}

/** The text a single `*` matched, or "" for a pattern without one, or undefined when it does not match. */
function matchPattern(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (specifier.length < prefix.length + suffix.length) return undefined;
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function substitute(target: unknown, star: string): unknown {
  if (typeof target === "string") return target.replaceAll("*", star);
  if (Array.isArray(target)) return target.map((item) => substitute(item, star));
  const record = asRecord(target);
  if (!record) return target;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, substitute(value, star)]));
}
