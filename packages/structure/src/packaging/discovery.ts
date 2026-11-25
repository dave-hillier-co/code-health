import { compareIds } from "@code-health/graph/graph";
import { compileGlobs } from "@code-health/history/glob";
import type { SourceTree } from "@code-health/parse/source-tree";
import { parseToml, type TomlTable, type TomlValue } from "@code-health/parse/toml";

/** The build system or package manager that makes a unit a package. `component` is a configured stand-in. */
export type Ecosystem = "npm" | "dotnet" | "cmake" | "gradle" | "maven" | "python" | "cargo" | "go" | "component";

export type DependencyScope = "runtime" | "dev";

export interface DeclaredDependency {
  /** The name the manifest gives it. */
  name: string;
  scope: DependencyScope;
  /** Id of the package in this repository it refers to, or null for an outside dependency. */
  target: string | null;
  /** A peer or optional dependency, which a package need not import to depend on. */
  optional: boolean;
}

/** A unit the build system delivers, read from its manifest. */
export interface DiscoveredPackage {
  /** The directory of its manifest, relative to the repository root ("." for the root). `dir:ecosystem` when two manifests share a directory, and the name for a component. */
  id: string;
  name: string;
  ecosystem: Ecosystem;
  /** Null for a component, which is owned by globs and not by a directory. */
  dir: string | null;
  manifest: string | null;
  /** True when the manifest marks it internal (`private: true`, `IsPackable=false`, `publish = false`); null when the manifest does not say. */
  private: boolean | null;
  version: string | null;
  /** An application or tool: something that is run and not depended on. */
  entry: boolean;
  /** A package that exists to support tests, by its manifest or its name. */
  testSupport: boolean;
  /** Every name a dependency may use for it, such as CMake aliases. */
  aliases: string[];
  dependencies: DeclaredDependency[];
  /** The module a Go package is grouped under (the module path of its `go.mod`). Null for every other package. */
  module: string | null;
  /**
   * The paths under its directory that it owns, each with everything below it: its manifest and the
   * directories and files its build system compiles and tests. Null when it owns its whole directory.
   */
  sources: string[] | null;
}

export interface ComponentMatcher {
  name: string;
  matches(path: string): boolean;
}

export interface DiscoveryOptions {
  /** Directory globs whose manifests are not packages. */
  ignore: readonly string[];
  /** Directories to treat as packages although they have no manifest. */
  extra: readonly string[];
  /** The suite's `components`, which stand in as packages when no manifest is found. */
  components: readonly ComponentMatcher[];
  /** The suite's `exclude` globs. */
  exclude: readonly string[];
  /** The suite's `entryPoints` globs: a package holding a file that matches one is an entry point, whatever its manifest says. */
  entryPoints?: readonly string[];
}

interface Raw {
  name: string;
  ecosystem: Ecosystem;
  dir: string;
  manifest: string;
  private: boolean | null;
  version: string | null;
  entry: boolean;
  testSupport: boolean;
  aliases: string[];
  dependencies: { name: string; scope: DependencyScope; dir?: string; optional?: boolean }[];
  module?: string;
  sources?: string[];
}

type Read = (path: string) => Promise<string | undefined>;

const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const child = (dir: string, name: string): string => (dir === "." ? name : `${dir}/${name}`);

/** Resolves `..` and `.` segments of a path relative to a directory. Undefined when it leaves the repository. */
function resolveFrom(dir: string, relative: string): string | undefined {
  const parts = dir === "." ? [] : dir.split("/");
  for (const part of relative.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.pop() === undefined) return undefined;
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 ? "." : parts.join("/");
}

const testName = /(^|[-_.@/:])(tests?|testing|testkit|fixtures?|e2e|mocks?|specs?)([-_.:]|$)/i;
const testDir = /(^|\/)(tests?|__tests__|e2e|testing)(\/|$)/i;

function isTestSupport(name: string, dir: string, flagged = false): boolean {
  return flagged || testName.test(name) || testDir.test(dir) || /\.tests?$/i.test(name);
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

// ---- npm ----

async function npmPackages(paths: string[], read: Read, ignored: (dir: string) => boolean): Promise<Raw[]> {
  const manifests = new Map<string, Record<string, unknown>>();
  for (const path of paths.filter((p) => baseOf(p) === "package.json" && !p.split("/").includes("node_modules"))) {
    const json = parseJson(await read(path));
    if (json) manifests.set(dirOf(path), json);
  }
  const root = manifests.get(".");
  const workspaces = record(root?.workspaces);
  let globs = [...strings(root?.workspaces), ...strings(workspaces.packages)];
  const pnpm = await read("pnpm-workspace.yaml");
  if (pnpm !== undefined) globs = [...globs, ...pnpmPackages(pnpm)];

  let dirs: string[];
  if (globs.length > 0) {
    const include = compileGlobs(globs.filter((g) => !g.startsWith("!")).map((g) => g.replace(/^\.\//, "").replace(/\/$/, "")));
    const drop = compileGlobs(globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1).replace(/\/$/, "")));
    dirs = [...manifests.keys()].filter((dir) => dir !== "." && include(dir) && !drop(dir));
  } else {
    dirs = [...manifests.keys()].filter((dir) => typeof manifests.get(dir)!.name === "string");
  }

  const result: Raw[] = [];
  for (const dir of dirs.filter((d) => !ignored(d)).sort(compareIds)) {
    const json = manifests.get(dir)!;
    const name = typeof json.name === "string" ? json.name : baseOf(dir === "." ? "root" : dir);
    const dependencies: Raw["dependencies"] = [];
    for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(record(json[key]))) dependencies.push({ name: dependency, scope: "runtime", optional: key !== "dependencies" });
    }
    for (const dependency of Object.keys(record(json.devDependencies))) dependencies.push({ name: dependency, scope: "dev" });
    result.push({
      name,
      ecosystem: "npm",
      dir,
      manifest: child(dir, "package.json"),
      private: json.private === true ? true : null,
      version: typeof json.version === "string" ? json.version : null,
      entry: json.bin !== undefined,
      testSupport: isTestSupport(name, dir),
      aliases: [],
      dependencies,
    });
  }
  return result;
}

/** The `packages:` list of pnpm-workspace.yaml, read line by line. */
function pnpmPackages(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^packages\s*:/.test(line)) inPackages = true;
    else if (/^\S/.test(line)) inPackages = false;
    else if (inPackages) {
      const item = /^\s*-\s*["']?([^"'#\s]+)["']?/.exec(line)?.[1];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
}

// ---- .NET ----

function xmlWithoutComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

function xmlAttribute(tag: string, attribute: string): string | undefined {
  return new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1] ?? new RegExp(`\\b${attribute}\\s*=\\s*'([^']*)'`, "i").exec(tag)?.[1];
}

function xmlElement(text: string, element: string): string | undefined {
  return new RegExp(`<${element}>\\s*([^<]*?)\\s*</${element}>`, "i").exec(text)?.[1];
}

async function dotnetPackages(paths: string[], read: Read, ignored: (dir: string) => boolean): Promise<Raw[]> {
  const result: Raw[] = [];
  for (const path of paths.filter((p) => /\.(cs|fs|vb)proj$/.test(p)).sort(compareIds)) {
    const dir = dirOf(path);
    if (ignored(dir)) continue;
    const text = xmlWithoutComments((await read(path)) ?? "");
    const name = baseOf(path).replace(/\.(cs|fs|vb)proj$/, "");
    const dependencies: Raw["dependencies"] = [];
    for (const tag of text.match(/<ProjectReference\b[^>]*>/gi) ?? []) {
      const include = xmlAttribute(tag, "Include");
      if (include === undefined) continue;
      const target = resolveFrom(dir, include);
      dependencies.push({ name: baseOf(include.replaceAll("\\", "/")).replace(/\.(cs|fs|vb)proj$/, ""), scope: "runtime", ...(target === undefined ? {} : { dir: dirOf(target) }) });
    }
    for (const tag of text.match(/<PackageReference\b[^>]*>/gi) ?? []) {
      const include = xmlAttribute(tag, "Include");
      if (include !== undefined) dependencies.push({ name: include, scope: "runtime" });
    }
    const outputType = xmlElement(text, "OutputType");
    const testSdk = /Microsoft\.NET\.Test\.Sdk/.test(text) || /<IsTestProject>\s*true/i.test(text);
    result.push({
      name,
      ecosystem: "dotnet",
      dir,
      manifest: path,
      private: /<IsPackable>\s*false/i.test(text) ? true : null,
      version: xmlElement(text, "Version") ?? xmlElement(text, "VersionPrefix") ?? null,
      entry: /^(win)?exe$/i.test(outputType ?? "") || /Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/i.test(text),
      testSupport: isTestSupport(name, dir, testSdk),
      aliases: [],
      dependencies,
    });
  }
  return result;
}

// ---- CMake ----

const cmakeKeywords = new Set(["PUBLIC", "PRIVATE", "INTERFACE", "DEBUG", "OPTIMIZED", "GENERAL"]);

async function cmakePackages(paths: string[], read: Read, ignored: (dir: string) => boolean): Promise<Raw[]> {
  const result: Raw[] = [];
  for (const path of paths.filter((p) => baseOf(p) === "CMakeLists.txt").sort(compareIds)) {
    const dir = dirOf(path);
    if (ignored(dir)) continue;
    const text = (await read(path))?.replace(/#.*$/gm, "") ?? "";
    const targets: { name: string; executable: boolean }[] = [];
    for (const match of text.matchAll(/\badd_(library|executable)\s*\(\s*([^\s)]+)([^)]*)\)/gi)) {
      const [, kind, name, rest] = match;
      if (/\bALIAS\b/i.test(rest ?? "") || /\bIMPORTED\b/i.test(rest ?? "")) continue;
      targets.push({ name: name!, executable: kind!.toLowerCase() === "executable" });
    }
    if (targets.length === 0) continue;
    const aliases = [...text.matchAll(/\badd_library\s*\(\s*([^\s)]+)\s+ALIAS\b/gi)].map((m) => m[1]!);
    const names = new Set(targets.map((t) => t.name));
    const dependencies: Raw["dependencies"] = [];
    for (const match of text.matchAll(/\btarget_link_libraries\s*\(\s*([^\s)]+)([^)]*)\)/gi)) {
      if (!names.has(match[1]!)) continue;
      for (const token of (match[2] ?? "").split(/\s+/)) {
        if (token === "" || cmakeKeywords.has(token.toUpperCase()) || token.startsWith("$<") || token.startsWith("-") || token.startsWith("${")) continue;
        dependencies.push({ name: token, scope: "runtime" });
      }
    }
    const version = /\bproject\s*\([^)]*\bVERSION\s+([0-9][^\s)]*)/i.exec(text)?.[1] ?? null;
    result.push({
      name: targets[0]!.name,
      ecosystem: "cmake",
      dir,
      manifest: path,
      private: null,
      version,
      entry: targets.every((t) => t.executable),
      testSupport: isTestSupport(targets[0]!.name, dir),
      aliases: [...targets.map((t) => t.name), ...aliases],
      dependencies,
    });
  }
  return result;
}

// ---- Gradle ----

async function gradlePackages(paths: string[], read: Read, ignored: (dir: string) => boolean): Promise<Raw[]> {
  const fileSet = new Set(paths);
  const result: Raw[] = [];
  for (const settings of paths.filter((p) => /(^|\/)settings\.gradle(\.kts)?$/.test(p)).sort(compareIds)) {
    const base = dirOf(settings);
    const text = (await read(settings))?.replace(/\/\/.*$/gm, "") ?? "";
    const projects = new Set<string>();
    for (const statement of text.matchAll(/\binclude\b\s*\(?((?:\s*["'][^"']+["']\s*,?)+)/g)) {
      for (const quoted of statement[1]!.matchAll(/["']([^"']+)["']/g)) projects.add(quoted[1]!);
    }
    for (const project of [...projects].sort(compareIds)) {
      const dir = child(base, project.replace(/^:/, "").replaceAll(":", "/"));
      const buildFile = ["build.gradle.kts", "build.gradle"].map((f) => child(dir, f)).find((f) => fileSet.has(f));
      if (buildFile === undefined || ignored(dir)) continue;
      const build = (await read(buildFile))?.replace(/\/\/.*$/gm, "") ?? "";
      const dependencies: Raw["dependencies"] = [];
      for (const match of build.matchAll(/\b([A-Za-z]+)\s*\(?\s*project\s*\(\s*(?:path\s*[:=]\s*)?["']([^"']+)["']/g)) {
        const configuration = match[1]!;
        const target = child(base, match[2]!.replace(/^:/, "").replaceAll(":", "/"));
        dependencies.push({ name: match[2]!, scope: /^(test|androidTest|integrationTest)/i.test(configuration) ? "dev" : "runtime", dir: target });
      }
      const name = project.startsWith(":") ? project : `:${project}`;
      result.push({
        name,
        ecosystem: "gradle",
        dir,
        manifest: buildFile,
        private: null,
        version: /^\s*version\s*=\s*["']([^"']+)["']/m.exec(build)?.[1] ?? null,
        entry: /\bapplication\b|com\.android\.application|\bmainClass\b/.test(build),
        testSupport: isTestSupport(name, dir),
        aliases: [],
        dependencies,
      });
    }
  }
  return result;
}

// ---- Maven ----

async function mavenPackages(paths: string[], read: Read, ignored: (dir: string) => boolean): Promise<Raw[]> {
  const result: Raw[] = [];
  for (const path of paths.filter((p) => baseOf(p) === "pom.xml").sort(compareIds)) {
    const dir = dirOf(path);
    if (ignored(dir)) continue;
    const text = xmlWithoutComments((await read(path)) ?? "")
      .replace(/<parent>[\s\S]*?<\/parent>/g, "")
      .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "")
      .replace(/<build>[\s\S]*?<\/build>/g, "")
      .replace(/<profiles>[\s\S]*?<\/profiles>/g, "");
    const artifact = xmlElement(text.replace(/<dependencies>[\s\S]*?<\/dependencies>/g, ""), "artifactId");
    const packaging = xmlElement(text, "packaging") ?? "jar";
    if (artifact === undefined || (packaging === "pom" && /<modules>/.test(text))) continue;
    const dependencies: Raw["dependencies"] = [];
    for (const block of text.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? []) {
      const name = xmlElement(block, "artifactId");
      if (name === undefined) continue;
      dependencies.push({ name, scope: /^test$/i.test(xmlElement(block, "scope") ?? "") ? "dev" : "runtime" });
    }
    result.push({
      name: artifact,
      ecosystem: "maven",
      dir,
      manifest: path,
      private: null,
      version: xmlElement(text.replace(/<dependencies>[\s\S]*?<\/dependencies>/g, ""), "version") ?? null,
      entry: packaging === "war",
      testSupport: isTestSupport(artifact, dir),
      aliases: [],
      dependencies,
    });
  }
  return result;
}

// ---- Python ----

const normalisePython = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");
const pythonName = (requirement: string): string | undefined => /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(requirement.trim())?.[0];
const devExtras = new Set(["dev", "test", "tests", "testing", "lint", "docs", "typing"]);

const pythonManifests = ["pyproject.toml", "setup.cfg", "setup.py"];

/**
 * The Python distributions of the repository. A directory is one when its `pyproject.toml` names a project
 * (PEP 621 or Poetry), or, failing that, its `setup.cfg` (`[metadata] name`) or `setup.py` (`setup(name=...)`) does.
 */
async function pythonPackages(paths: string[], read: Read, ignored: (dir: string) => boolean): Promise<Raw[]> {
  const result: Raw[] = [];
  const dirs = [...new Set(paths.filter((p) => pythonManifests.includes(baseOf(p))).map(dirOf))].sort(compareIds);
  const fileSet = new Set(paths);
  for (const dir of dirs) {
    if (ignored(dir)) continue;
    const raw = (await pyprojectPackage(dir, fileSet, read)) ?? (await setupPackage(dir, fileSet, read));
    if (raw === undefined) continue;
    raw.sources = pythonSources(dir, paths, raw.sources ?? []);
    result.push(raw);
  }
  return result;
}

/**
 * What a Python distribution is built and tested from: its manifests, `src`, `tests` and `test`, the
 * import packages directly in its directory (a child directory with an `__init__.py`), its top-level
 * modules, and the package directories its build backend names.
 */
function pythonSources(dir: string, paths: readonly string[], declared: readonly string[]): string[] {
  const sources = new Set([...pythonManifests, "src", "tests", "test"].map((name) => child(dir, name)));
  for (const path of declared) sources.add(path);
  const prefix = dir === "." ? "" : `${dir}/`;
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const parts = path.slice(prefix.length).split("/");
    if (parts.length === 1 && parts[0]!.endsWith(".py")) sources.add(path);
    if (parts.length === 2 && parts[1] === "__init__.py") sources.add(child(dir, parts[0]!));
  }
  return [...sources].sort(compareIds);
}

/** Package directories a pyproject's build backend names: Hatch's wheel packages, Poetry's packages and setuptools' package-dir and find roots. */
function declaredPythonPaths(dir: string, toml: TomlTable): string[] {
  const tool = record(toml.tool);
  const relative: string[] = [...strings(record(record(record(record(tool.hatch).build).targets).wheel).packages)];
  for (const entry of Array.isArray(record(tool.poetry).packages) ? (record(tool.poetry).packages as TomlValue[]) : []) {
    const include = record(entry).include;
    const from = record(entry).from;
    if (typeof include === "string") relative.push(typeof from === "string" ? `${from}/${include}` : include);
  }
  const setuptools = record(tool.setuptools);
  for (const value of Object.values(record(setuptools["package-dir"]))) if (typeof value === "string") relative.push(value);
  relative.push(...strings(record(record(setuptools.packages).find).where));
  return relative.map((path) => resolveFrom(dir, path.replace(/\/\*.*$/, ""))).filter((path): path is string => path !== undefined && path !== dir);
}

async function pyprojectPackage(dir: string, fileSet: ReadonlySet<string>, read: Read): Promise<Raw | undefined> {
  const path = child(dir, "pyproject.toml");
  if (!fileSet.has(path)) return undefined;
  const toml = parseToml((await read(path)) ?? "");
  const project = (toml.project ?? {}) as TomlTable;
  const poetry = ((toml.tool as TomlTable | undefined)?.poetry ?? {}) as TomlTable;
  const name = (project.name ?? poetry.name) as TomlValue | undefined;
  if (typeof name !== "string") return undefined;
  const dependencies: Raw["dependencies"] = [];
  for (const requirement of strings(project.dependencies)) {
    const dependency = pythonName(requirement);
    if (dependency !== undefined) dependencies.push({ name: dependency, scope: "runtime" });
  }
  for (const [extra, list] of Object.entries(record(project["optional-dependencies"]))) {
    for (const requirement of strings(list)) {
      const dependency = pythonName(requirement);
      if (dependency !== undefined) dependencies.push({ name: dependency, scope: devExtras.has(extra) ? "dev" : "runtime" });
    }
  }
  for (const [dependency, spec] of Object.entries(record(poetry.dependencies))) {
    if (dependency.toLowerCase() === "python") continue;
    const at = record(spec).path;
    dependencies.push({ name: dependency, scope: "runtime", ...(typeof at === "string" && resolveFrom(dir, at) !== undefined ? { dir: resolveFrom(dir, at)! } : {}) });
  }
  for (const group of [record(poetry["dev-dependencies"]), record(record(record(poetry.group).dev).dependencies)]) {
    for (const dependency of Object.keys(group)) dependencies.push({ name: dependency, scope: "dev" });
  }
  const classifiers = strings(project.classifiers);
  return {
    name,
    ecosystem: "python",
    dir,
    manifest: path,
    private: classifiers.includes("Private :: Do Not Upload") ? true : null,
    version: typeof (project.version ?? poetry.version) === "string" ? ((project.version ?? poetry.version) as string) : null,
    entry: Object.keys(record(project.scripts)).length > 0 || Object.keys(record(poetry.scripts)).length > 0,
    testSupport: isTestSupport(name, dir),
    aliases: [],
    dependencies,
    sources: declaredPythonPaths(dir, toml),
  };
}

/** The sections of an INI file such as setup.cfg, each a map from key to value, with continuation lines joined by newlines. */
function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let section: Map<string, string> | undefined;
  let key: string | undefined;
  for (const line of text.split("\n")) {
    if (/^\s*([#;]|$)/.test(line)) continue;
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      sections.set(header[1]!.trim(), (section = new Map()));
      key = undefined;
    } else if (/^\s/.test(line) && section && key !== undefined) {
      section.set(key, `${section.get(key)}\n${line.trim()}`);
    } else if (section) {
      const pair = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
      if (pair) section.set((key = pair[1]!.trim()), pair[2]!.trim());
    }
  }
  return sections;
}

const iniList = (value: string | undefined): string[] =>
  (value ?? "").split(/[\n;]/).map((item) => item.trim()).filter((item) => item !== "" && !item.startsWith("#"));

/** The string a `setup()` keyword argument is given: a literal, or a module-level name assigned a literal. */
function setupKeyword(script: string, call: string, keyword: string): string | undefined {
  const argument = new RegExp(`\\b${keyword}\\s*=\\s*(?:(['"])(.*?)\\1|([A-Za-z_]\\w*))`).exec(call);
  if (argument === null) return undefined;
  if (argument[2] !== undefined) return argument[2];
  return new RegExp(`^${argument[3]}\\s*=\\s*(['"])(.*?)\\1`, "m").exec(script)?.[2];
}

/** The strings of the literal list a `setup()` keyword argument is given, such as `install_requires=[...]`. */
function setupList(call: string, keyword: string): string[] {
  const list = new RegExp(`\\b${keyword}\\s*=\\s*\\[([^\\]]*)\\]`).exec(call)?.[1] ?? "";
  return [...list.matchAll(/(['"])(.*?)\1/g)].map((m) => m[2]!);
}

/** A distribution described by `setup.cfg` or `setup.py`, read as text: nothing is executed. */
async function setupPackage(dir: string, fileSet: ReadonlySet<string>, read: Read): Promise<Raw | undefined> {
  const cfgPath = child(dir, "setup.cfg");
  const pyPath = child(dir, "setup.py");
  const cfg = fileSet.has(cfgPath) ? parseIni((await read(cfgPath)) ?? "") : new Map<string, Map<string, string>>();
  const script = fileSet.has(pyPath) ? ((await read(pyPath)) ?? "").replace(/#.*$/gm, "") : "";
  const at = /(?<!def\s+)\bsetup\s*\(/.exec(script)?.index;
  const call = at === undefined ? "" : script.slice(at);
  const metadata = cfg.get("metadata");
  const options = cfg.get("options");
  const fromCfg = metadata?.get("name");
  const name = fromCfg ?? setupKeyword(script, call, "name");
  if (name === undefined || name === "") return undefined;
  const dependencies: Raw["dependencies"] = [];
  for (const requirement of [...iniList(options?.get("install_requires")), ...setupList(call, "install_requires")]) {
    const dependency = pythonName(requirement);
    if (dependency !== undefined) dependencies.push({ name: dependency, scope: "runtime" });
  }
  for (const [extra, list] of cfg.get("options.extras_require") ?? []) {
    for (const requirement of iniList(list)) {
      const dependency = pythonName(requirement);
      if (dependency !== undefined) dependencies.push({ name: dependency, scope: devExtras.has(extra) ? "dev" : "runtime" });
    }
  }
  return {
    name,
    ecosystem: "python",
    dir,
    manifest: fromCfg !== undefined ? cfgPath : pyPath,
    private: `${metadata?.get("classifiers") ?? ""}\n${call}`.includes("Private :: Do Not Upload") ? true : null,
    version: metadata?.get("version") ?? setupKeyword(script, call, "version") ?? null,
    entry: (cfg.get("options.entry_points")?.has("console_scripts") ?? false) || /\bconsole_scripts\b|\bscripts\s*=/.test(call),
    testSupport: isTestSupport(name, dir),
    aliases: [],
    dependencies,
    sources: [],
  };
}

// ---- Cargo ----

async function cargoPackages(paths: string[], read: Read, ignored: (dir: string) => boolean): Promise<Raw[]> {
  const fileSet = new Set(paths);
  const result: Raw[] = [];
  for (const path of paths.filter((p) => baseOf(p) === "Cargo.toml").sort(compareIds)) {
    const dir = dirOf(path);
    if (ignored(dir)) continue;
    const toml = parseToml((await read(path)) ?? "");
    const pkg = record(toml.package);
    if (typeof pkg.name !== "string") continue;
    const dependencies: Raw["dependencies"] = [];
    for (const [table, scope] of [["dependencies", "runtime"], ["build-dependencies", "runtime"], ["dev-dependencies", "dev"]] as const) {
      for (const [name, spec] of Object.entries(record(toml[table]))) {
        const detail = record(spec);
        const target = typeof detail.path === "string" ? resolveFrom(dir, detail.path) : undefined;
        dependencies.push({
          name: typeof detail.package === "string" ? detail.package : name,
          scope,
          ...(target === undefined ? {} : { dir: target }),
        });
      }
    }
    result.push({
      name: pkg.name,
      ecosystem: "cargo",
      dir,
      manifest: path,
      private: pkg.publish === false ? true : null,
      version: typeof pkg.version === "string" ? pkg.version : null,
      entry: Array.isArray(toml.bin) || fileSet.has(child(dir, "src/main.rs")),
      testSupport: isTestSupport(pkg.name, dir),
      aliases: [],
      dependencies,
      sources: cargoSources(dir, path, toml),
    });
  }
  return result;
}

/**
 * What Cargo builds a crate from: its manifest, the conventional target directories and build script,
 * and the targets the manifest declares by path. A target file outside the crate's root directory brings
 * its directory, where its modules live.
 */
function cargoSources(dir: string, manifest: string, toml: TomlTable): string[] {
  const sources = new Set([manifest, ...["Cargo.lock", "build.rs", "src", "tests", "benches", "examples"].map((name) => child(dir, name))]);
  const build = record(toml.package).build;
  if (typeof build === "string") {
    const at = resolveFrom(dir, build);
    if (at !== undefined) sources.add(at);
  }
  const targets = [toml.lib, ...["bin", "test", "bench", "example"].flatMap((table) => (Array.isArray(toml[table]) ? (toml[table] as TomlValue[]) : []))];
  for (const target of targets) {
    const path = record(target).path;
    if (typeof path !== "string") continue;
    const at = resolveFrom(dir, path);
    if (at !== undefined) sources.add(dirOf(at) === dir ? at : dirOf(at));
  }
  return [...sources].sort(compareIds);
}

// ---- Go ----

/** A directory Go does not build packages from: `testdata`, `vendor`, and names that start with `.` or `_`. */
const isUnbuiltGoDir = (relative: string): boolean => relative.split("/").some((part) => part === "testdata" || part === "vendor" || part.startsWith(".") || part.startsWith("_"));

/**
 * The Go packages of the repository: every directory with a Go file, owned by the nearest `go.mod` above it,
 * and grouped under that module (`module`). A package is named by its import path. A module is not a package:
 * its manifest checks are made per module over its packages (see the Go packaging language).
 */
async function goPackages(paths: string[], read: Read, ignored: (dir: string) => boolean): Promise<Raw[]> {
  const fileSet = new Set(paths);
  const modules = new Map<string, { name: string; manifest: string }>();
  for (const path of paths.filter((p) => baseOf(p) === "go.mod").sort(compareIds)) {
    const dir = dirOf(path);
    if (ignored(dir)) continue;
    const text = ((await read(path)) ?? "").replace(/\/\/.*$/gm, "");
    const name = /^\s*module\s+(\S+)/m.exec(text)?.[1];
    if (name !== undefined) modules.set(dir, { name, manifest: path });
  }
  const moduleOf = (dir: string): string | undefined => {
    for (let at = dir; ; at = dirOf(at)) {
      if (modules.has(at)) return at;
      if (at === ".") return undefined;
    }
  };

  const dirs = new Set<string>();
  for (const path of paths) if (path.endsWith(".go")) dirs.add(dirOf(path));
  const filesIn = new Map<string, string[]>();
  for (const path of paths) {
    const dir = dirOf(path);
    if (!dirs.has(dir)) continue;
    if (!filesIn.has(dir)) filesIn.set(dir, []);
    filesIn.get(dir)!.push(path);
  }
  const result: Raw[] = [];
  for (const dir of [...dirs].sort(compareIds)) {
    const moduleDir = moduleOf(dir);
    if (moduleDir === undefined || ignored(dir)) continue;
    const relative = moduleDir === "." ? dir : dir === moduleDir ? "." : dir.slice(moduleDir.length + 1);
    if (relative !== "." && isUnbuiltGoDir(relative)) continue;
    const module = modules.get(moduleDir)!;
    const name = relative === "." ? module.name : `${module.name}/${relative}`;
    result.push({
      name,
      ecosystem: "go",
      dir,
      manifest: module.manifest,
      private: relative.split("/").includes("internal") ? true : null,
      version: null,
      entry: fileSet.has(child(dir, "main.go")) || relative === "cmd" || relative.startsWith("cmd/"),
      testSupport: isTestSupport(name, dir),
      aliases: [],
      dependencies: [],
      module: module.name,
      // a Go package is one directory: its files, and the test data beside them
      sources: [...(filesIn.get(dir) ?? []), child(dir, "testdata")].sort(compareIds),
    });
  }
  return result;
}

// ---- discovery ----

const readers: [Ecosystem, (paths: string[], read: Read, ignored: (dir: string) => boolean) => Promise<Raw[]>][] = [
  ["npm", npmPackages],
  ["dotnet", dotnetPackages],
  ["cmake", cmakePackages],
  ["gradle", gradlePackages],
  ["maven", mavenPackages],
  ["python", pythonPackages],
  ["cargo", cargoPackages],
  ["go", goPackages],
];

const lookupKey = (ecosystem: Ecosystem, name: string): string => `${ecosystem}\0${ecosystem === "python" ? normalisePython(name) : name}`;

/**
 * Reads the packages of one tree from its manifests. Only manifests are read: no adapter and no
 * build tool is needed. Where a repository has no manifest at all, the configured components stand in.
 */
export async function discoverPackages(tree: SourceTree, options: DiscoveryOptions): Promise<DiscoveredPackage[]> {
  const excluded = compileGlobs([...options.exclude]);
  const ignoredDirs = compileGlobs([...options.ignore]);
  const paths = [...tree.files.keys()].filter((p) => !excluded(p) && !p.split("/").includes("node_modules"));
  const cache = new Map<string, Promise<string | undefined>>();
  const read: Read = (path) => {
    if (!cache.has(path)) cache.set(path, tree.read(path));
    return cache.get(path)!;
  };
  const ignored = (dir: string): boolean => ignoredDirs(dir) || options.ignore.some((glob) => dir.startsWith(`${glob}/`));

  const raws: Raw[] = [];
  for (const [, readManifests] of readers) raws.push(...(await readManifests(paths, read, ignored)));
  for (const dir of [...options.extra].sort(compareIds)) {
    if (raws.some((r) => r.dir === dir)) continue;
    raws.push({ name: baseOf(dir), ecosystem: "component", dir, manifest: "", private: null, version: null, entry: false, testSupport: isTestSupport(baseOf(dir), dir), aliases: [], dependencies: [] });
  }

  // one id per package: its directory, qualified by ecosystem where two manifests share one
  const idOf = new Map<Raw, string>();
  const taken = new Map<string, number>();
  for (const raw of raws) taken.set(raw.dir, (taken.get(raw.dir) ?? 0) + 1);
  const seen = new Set<string>();
  for (const raw of raws) {
    const id = seen.has(raw.dir) ? `${raw.dir}:${raw.ecosystem}` : raw.dir;
    seen.add(raw.dir);
    idOf.set(raw, id);
  }

  const byName = new Map<string, string>();
  const byDir = new Map<string, string>();
  for (const raw of raws) {
    const id = idOf.get(raw)!;
    for (const name of [raw.name, ...raw.aliases]) byName.set(lookupKey(raw.ecosystem, name), id);
    for (const alias of raw.aliases) {
      const short = alias.includes("::") ? alias.slice(alias.lastIndexOf("::") + 2) : undefined;
      if (short !== undefined && !byName.has(lookupKey(raw.ecosystem, short))) byName.set(lookupKey(raw.ecosystem, short), id);
    }
    if (!byDir.has(`${raw.ecosystem}\0${raw.dir}`)) byDir.set(`${raw.ecosystem}\0${raw.dir}`, id);
  }

  const packages = raws.map((raw): DiscoveredPackage => {
    const id = idOf.get(raw)!;
    const seenTargets = new Set<string>();
    const dependencies: DeclaredDependency[] = [];
    for (const dependency of raw.dependencies) {
      const target =
        (dependency.dir === undefined ? undefined : byDir.get(`${raw.ecosystem}\0${dependency.dir}`)) ??
        byName.get(lookupKey(raw.ecosystem, dependency.name)) ??
        (dependency.name.includes("::") ? byName.get(lookupKey(raw.ecosystem, dependency.name.slice(dependency.name.lastIndexOf("::") + 2))) : undefined) ??
        null;
      const key = `${dependency.name}\0${dependency.scope}`;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      dependencies.push({ name: dependency.name, scope: dependency.scope, target: target === id ? null : target, optional: dependency.optional === true });
    }
    dependencies.sort((a, b) => compareIds(a.name, b.name) || compareIds(a.scope, b.scope));
    return {
      id,
      name: raw.name,
      ecosystem: raw.ecosystem,
      dir: raw.dir,
      manifest: raw.manifest === "" ? null : raw.manifest,
      private: raw.private,
      version: raw.version,
      entry: raw.entry,
      testSupport: raw.testSupport,
      aliases: raw.aliases,
      dependencies,
      module: raw.module ?? null,
      sources: raw.sources ?? null,
    };
  });
  markConfiguredEntries(packages, paths, options.entryPoints ?? []);

  if (packages.length === 0) {
    return options.components
      .map((component): DiscoveredPackage => ({
        id: component.name,
        name: component.name,
        ecosystem: "component",
        dir: null,
        manifest: null,
        private: null,
        version: null,
        entry: false,
        testSupport: isTestSupport(component.name, ""),
        aliases: [],
        dependencies: [],
        module: null,
        sources: null,
      }))
      .sort((a, b) => compareIds(a.id, b.id));
  }
  return packages.sort((a, b) => compareIds(a.id, b.id));
}

/** A package that owns a file matching the configured `entryPoints` is an entry point: nothing is expected to depend on it. */
function markConfiguredEntries(packages: DiscoveredPackage[], paths: readonly string[], entryPoints: readonly string[]): void {
  if (entryPoints.length === 0 || packages.length === 0) return;
  const isEntryFile = compileGlobs([...entryPoints]);
  const index = indexPackages(packages);
  const owners = new Set(paths.filter(isEntryFile).map((path) => index.owner(path)));
  for (const pkg of packages) if (owners.has(pkg.id)) pkg.entry = true;
}

export interface PackageIndex {
  /**
   * The id of the package that owns a file: the first component that matches, or else a package of the deepest
   * package directory above it, when the file lies in that package's sources. Undefined for a file no package owns.
   */
  owner(path: string): string | undefined;
}

export function indexPackages(packages: readonly DiscoveredPackage[], components: readonly ComponentMatcher[] = []): PackageIndex {
  const atDir = new Map<string, { id: string; sources: ReadonlySet<string> | null }[]>();
  for (const pkg of packages) {
    if (pkg.dir === null) continue;
    if (!atDir.has(pkg.dir)) atDir.set(pkg.dir, []);
    atDir.get(pkg.dir)!.push({ id: pkg.id, sources: pkg.sources === null ? null : new Set(pkg.sources) });
  }
  const componentIds = new Set(packages.filter((p) => p.ecosystem === "component" && p.dir === null).map((p) => p.id));
  const matchers = components.filter((c) => componentIds.has(c.name));
  const cache = new Map<string, string | undefined>();
  const packageDirOf = (dir: string): string | undefined => {
    if (cache.has(dir)) return cache.get(dir);
    const found = atDir.has(dir) ? dir : dir === "." ? undefined : packageDirOf(dirOf(dir));
    cache.set(dir, found);
    return found;
  };
  const within = (sources: ReadonlySet<string>, packageDir: string, path: string): boolean => {
    for (let at = path; at !== packageDir && at !== "."; at = dirOf(at)) if (sources.has(at)) return true;
    return false;
  };
  return {
    owner(path) {
      const matched = matchers.find((c) => c.matches(path));
      if (matched !== undefined) return matched.name;
      const dir = packageDirOf(dirOf(path));
      if (dir === undefined) return undefined;
      return atDir.get(dir)!.find((pkg) => pkg.sources === null || within(pkg.sources, dir, path))?.id;
    },
  };
}
