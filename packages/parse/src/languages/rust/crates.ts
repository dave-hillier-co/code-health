import { posix } from "node:path";
import { parseToml, type TomlTable, type TomlValue } from "../../toml.ts";

/**
 * Crates, read from `Cargo.toml` and the layout Cargo expects, and the module tree that follows from a file's
 * place in a crate. A crate has one root file per target (library, binaries, integration tests, examples,
 * benches, the build script), and a file's module path is its path under the directory of its root, with
 * `mod.rs` standing for its directory. `#[path]` modules are resolved at their declaration instead.
 */

export interface Crate {
  manifest: string;
  /** Directory of the manifest, "." for the root. */
  dir: string;
  /** The `[package] name`, or null for a manifest with no package (a virtual workspace). */
  name: string | null;
  /** The name the crate is used under in `use` paths: `[lib] name`, else the package name with `-` as `_`. */
  libName: string | null;
  /** True when `publish = false`, false when `publish` says otherwise, null when the manifest does not say. */
  private: boolean | null;
  libRoot: string | undefined;
  binRoots: readonly string[];
  /** Every target's root file, sorted. */
  roots: readonly string[];
  /** Crates this one depends on by path, by the name they are written as in `use` paths, to the directory of the manifest. */
  dependencies: ReadonlyMap<string, string>;
  /** False when the manifest could not be read. */
  readable: boolean;
}

export const isManifestPath = (path: string): boolean => path === "Cargo.toml" || path.endsWith("/Cargo.toml");

const underscored = (name: string): string => name.replaceAll("-", "_");

const table = (value: TomlValue | undefined): TomlTable => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as TomlTable) : {});
const text = (value: TomlValue | undefined): string | undefined => (typeof value === "string" ? value : undefined);
const list = (value: TomlValue | undefined): TomlTable[] => (Array.isArray(value) ? value.filter((entry): entry is TomlTable => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : []);

function join(dir: string, path: string): string {
  return posix.normalize(dir === "." ? path : posix.join(dir, path));
}

const rootOfDirectory = (dir: string, base: string, tree: ReadonlySet<string>, targets: Set<string>): void => {
  // `dir/name.rs` and `dir/name/main.rs` are targets of their own, which Cargo discovers by layout.
  const prefix = dir === "." ? "" : `${dir}/`;
  for (const path of tree) {
    if (!path.startsWith(`${prefix}${base}/`)) continue;
    const rest = path.slice(prefix.length + base.length + 1);
    if (/^[^/]+\.rs$/.test(rest) || /^[^/]+\/main\.rs$/.test(rest)) targets.add(path);
  }
};

/** Every crate manifest among `configs` (path to text), sorted by path, with the target roots that exist in `paths`. */
export function readCrates(paths: readonly string[], configs: ReadonlyMap<string, string>): Crate[] {
  const tree = new Set(paths);
  const manifests = [...configs.keys()].filter(isManifestPath).sort();
  const raw = new Map<string, TomlTable | undefined>();
  for (const manifest of manifests) {
    try {
      raw.set(manifest, parseToml(configs.get(manifest) ?? ""));
    } catch {
      raw.set(manifest, undefined);
    }
  }
  const workspaces = manifests.filter((manifest) => raw.get(manifest)?.workspace !== undefined);

  const workspaceDependency = (from: string, key: string): { dir: string; path: string } | undefined => {
    for (const manifest of workspaces) {
      const dir = posix.dirname(manifest);
      if (dir !== "." && !from.startsWith(`${dir}/`)) continue;
      const entry = table(table(table(raw.get(manifest)?.workspace).dependencies)[key]);
      const path = text(entry.path);
      if (path !== undefined) return { dir, path };
    }
    return undefined;
  };

  const crates: Crate[] = [];
  for (const manifest of manifests) {
    const toml = raw.get(manifest);
    const dir = posix.dirname(manifest);
    if (toml === undefined) {
      crates.push({ manifest, dir, name: null, libName: null, private: null, libRoot: undefined, binRoots: [], roots: [], dependencies: new Map(), readable: false });
      continue;
    }
    const pkg = table(toml.package);
    const name = text(pkg.name) ?? null;
    const lib = table(toml.lib);
    const libName = name === null ? null : (text(lib.name) ?? underscored(name));
    const libPath = join(dir, text(lib.path) ?? "src/lib.rs");
    const libRoot = name !== null && tree.has(libPath) ? libPath : undefined;

    const bins = new Set<string>();
    for (const bin of list(toml.bin)) {
      const binName = text(bin.name) ?? name ?? "";
      const declared = text(bin.path);
      const candidates = declared === undefined ? [join(dir, `src/bin/${binName}.rs`), join(dir, `src/bin/${binName}/main.rs`), join(dir, "src/main.rs")] : [join(dir, declared)];
      const found = candidates.find((candidate) => tree.has(candidate));
      if (found !== undefined) bins.add(found);
    }
    if (name !== null) {
      if (tree.has(join(dir, "src/main.rs"))) bins.add(join(dir, "src/main.rs"));
      rootOfDirectory(dir, "src/bin", tree, bins);
    }

    const others = new Set<string>();
    if (name !== null) {
      if (tree.has(join(dir, "build.rs"))) others.add(join(dir, "build.rs"));
      for (const folder of ["tests", "examples", "benches"]) rootOfDirectory(dir, folder, tree, others);
      for (const key of ["test", "example", "bench"]) {
        for (const target of list(toml[key])) {
          const declared = text(target.path);
          if (declared !== undefined && tree.has(join(dir, declared))) others.add(join(dir, declared));
        }
      }
    }

    const dependencies = new Map<string, string>();
    for (const section of ["dependencies", "dev-dependencies", "build-dependencies"]) {
      for (const [key, value] of Object.entries(table(toml[section]))) {
        const spec = table(value);
        const local = text(spec.path);
        const inherited = spec.workspace === true ? workspaceDependency(manifest, key) : undefined;
        const target = local !== undefined ? join(dir, local) : inherited === undefined ? undefined : join(inherited.dir, inherited.path);
        if (target !== undefined) dependencies.set(underscored(key), target);
      }
    }

    const publish = pkg.publish;
    crates.push({
      manifest,
      dir,
      name,
      libName,
      private: publish === false ? true : publish === undefined ? null : false,
      libRoot,
      binRoots: [...bins].sort(),
      roots: [...new Set([...(libRoot === undefined ? [] : [libRoot]), ...bins, ...others])].sort(),
      dependencies,
      readable: true,
    });
  }
  return crates;
}

/** The module a file is, and the crate and root file it belongs to. */
export interface ModulePlace {
  /** The root file of the target whose module tree holds the file. */
  root: string;
  /** Module names from the root, empty for the root itself. */
  path: readonly string[];
  /** The crate, when a manifest owns the file. */
  crate: Crate | undefined;
}

/** The directory a module's children are looked up in: its own for `mod.rs` and root files, otherwise the folder named after it. */
export function moduleDirectory(file: string, root: string): string {
  const base = posix.basename(file);
  if (file === root || base === "mod.rs") return posix.dirname(file);
  return posix.join(posix.dirname(file), base.slice(0, -3));
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Finds files' places in the module tree from the layout alone. A file under a crate's root directory is a
 * module of the nearest root; the library root wins a tie, then a `main.rs`, then the first by path. Files
 * of no manifest's crate are placed under any `lib.rs` or `main.rs` above them, so loose sources still resolve.
 */
export class ModuleTree {
  readonly crates: readonly Crate[];
  private readonly tree: ReadonlySet<string>;
  private readonly implicitRoots: readonly string[];
  private readonly places = new Map<string, ModulePlace | undefined>();

  constructor(paths: readonly string[], crates: readonly Crate[]) {
    this.tree = new Set(paths);
    this.crates = crates;
    const owned = (path: string): boolean => crates.some((crate) => crate.name !== null && (crate.dir === "." || path.startsWith(`${crate.dir}/`)));
    this.implicitRoots = paths.filter((path) => /(^|\/)(lib|main)\.rs$/.test(path) && !owned(path)).sort();
  }

  has(path: string): boolean {
    return this.tree.has(path);
  }

  crateOf(file: string): Crate | undefined {
    let best: Crate | undefined;
    for (const crate of this.crates) {
      if (crate.name === null) continue;
      if (crate.dir !== "." && !file.startsWith(`${crate.dir}/`)) continue;
      if (best === undefined || crate.dir.length > best.dir.length) best = crate;
    }
    return best;
  }

  placeOf(file: string): ModulePlace | undefined {
    if (this.places.has(file) || !file.endsWith(".rs")) return this.places.get(file);
    const crate = this.crateOf(file);
    const roots = crate === undefined ? this.implicitRoots : crate.roots;
    let root: string | undefined;
    if (roots.includes(file)) root = file;
    else {
      const rank = (candidate: string): number => (candidate === crate?.libRoot || /(^|\/)lib\.rs$/.test(candidate) ? 0 : /(^|\/)main\.rs$/.test(candidate) ? 1 : 2);
      const candidates = roots.filter((candidate) => {
        const dir = posix.dirname(candidate);
        return dir === "." || file.startsWith(`${dir}/`);
      });
      candidates.sort((a, b) => posix.dirname(b).length - posix.dirname(a).length || rank(a) - rank(b) || compare(a, b));
      const shortest = candidates[0] === undefined ? undefined : posix.dirname(candidates[0]).length;
      root = candidates.find((candidate) => posix.dirname(candidate).length === shortest);
    }
    let place: ModulePlace | undefined;
    if (root !== undefined) {
      const dir = posix.dirname(root);
      const relative = dir === "." ? file : file.slice(dir.length + 1);
      const names = file === root ? [] : relative.slice(0, -3).split("/");
      if (names.at(-1) === "mod") names.pop();
      place = { root, path: names, crate };
    }
    this.places.set(file, place);
    return place;
  }

  /** The file of the child module `name` in a module directory: `name.rs`, else `name/mod.rs`. */
  child(directory: string, name: string): string | undefined {
    const flat = posix.join(directory, `${name}.rs`);
    if (this.tree.has(flat)) return flat;
    const nested = posix.join(directory, name, "mod.rs");
    return this.tree.has(nested) ? nested : undefined;
  }

  /**
   * Walks module names from a module. A name with a file moves into it. A lower-case name without one is taken
   * for an inline module and stepped over, so the files of modules declared inside it are still found. A
   * name that starts with a capital is an item, which ends the walk. `consumed` counts the names up to the
   * last file reached, so the rest name items of that file.
   */
  walk(from: { file: string; root: string }, names: readonly string[]): { file: string; consumed: number } {
    let file = from.file;
    let directory = moduleDirectory(file, from.root);
    let consumed = 0;
    for (let index = 0; index < names.length; index++) {
      const name = names[index]!;
      const found = this.child(directory, name);
      if (found !== undefined) {
        file = found;
        directory = moduleDirectory(found, from.root);
        consumed = index + 1;
      } else if (/^[a-z_]/.test(name)) {
        directory = posix.join(directory, name);
      } else break;
    }
    return { file, consumed };
  }
}
