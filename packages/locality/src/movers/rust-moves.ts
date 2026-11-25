import { posix } from "node:path";
import type { Node, Tree } from "web-tree-sitter";
import { isManifestPath, ModuleTree, moduleDirectory, readCrates, type ModulePlace } from "@code-health/parse/languages/rust/crates";
import { leavesOf, pathSegments, type Leaf } from "@code-health/parse/languages/rust/extract-facts";
import type { LoadedGrammar } from "@code-health/parse/grammars";
import type { SourceTree } from "@code-health/parse/source-tree";
import { parseToml, type TomlTable, type TomlValue } from "@code-health/parse/toml";
import type { FileOperation } from "../move-plan.ts";
import type { Rewrite } from "./mover-language.ts";

/**
 * Moves Rust files and keeps the module tree and the paths that name them true. A file's module is its place
 * under its crate root (parse/languages/rust/crates.ts), so moving a file moves its module. Three things
 * follow, and each is done here:
 *
 * - The `mod name;` that declares the module is taken from the module that declared it and added to the one
 *   whose folder it now sits in, keeping its visibility and attributes. The `cfg` attributes of the modules it
 *   leaves (on their `mod` lines and as `#![cfg]` in their files) are written on the new `mod` line too, so a
 *   module compiled only for tests is still compiled only for tests. A rename in place renames the
 *   declaration where it stands. A destination with no module file gets a warning, since nothing declares the module.
 * - Every `use` and every path in code that reaches a moved module is rewritten, whether it starts at
 *   `crate`, at `self` or `super`, at a module the file declares or at another crate of the tree. A path
 *   keeps its style where it can: `crate::` stays `crate::`, a path through `self` or `super` is recounted from
 *   where the file now is, and one that would need more than a `super` is written from `crate`.
 * - A rewritten path that passes a private module its file can no longer reach is reported, because only a
 *   visibility change fixes that, and the move does not change visibility. So is a moved file that uses a crate
 *   its manifest lists only in `[dev-dependencies]` when no `#[cfg(test)]` covers its module after the move.
 * - A file that would be in no module tree after the move, or in the tree of another target, and a path that
 *   names a moved file and cannot be rewritten, are breaks: the result does not compile, so the move is refused.
 *
 * Paths in macro arguments are not rewritten (the grammar does not parse them), and neither are paths inside
 * inline modules other than those starting at `crate` or another crate.
 */

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Source {
  path: string;
  text: string;
  tree: Tree;
}

interface Declaration {
  node: Node;
  name: string;
  /** The written visibility, `pub ` or `pub(crate) `, or an empty string. */
  visibility: string;
  /** The attribute items written just before it. */
  attributes: Node[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function visibilityOf(node: Node): string {
  const modifier = node.namedChildren.find((child) => child.type === "visibility_modifier");
  return modifier === undefined ? "" : `${modifier.text} `;
}

function attributesBefore(node: Node): Node[] {
  const out: Node[] = [];
  for (let previous = node.previousNamedSibling; previous !== null && previous.type === "attribute_item"; previous = previous.previousNamedSibling) out.unshift(previous);
  return out;
}

/** True when the node sits inside an inline module, where `self` and `super` count from that module. */
function insideInlineModule(node: Node): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.type === "mod_item" && parent.childForFieldName("body") !== null) return true;
  }
  return false;
}

const isCfg = (attribute: string): boolean => /^#!?\[\s*cfg\s*\(/.test(attribute);
/** True when a `cfg` attribute compiles its item only for tests: it names `test`, and not under `not(...)`. */
const isTestCfg = (attribute: string): boolean => isCfg(attribute) && /\btest\b/.test(attribute) && !/\bnot\s*\(\s*test\b/.test(attribute);
/** An inner `#![cfg(...)]` written as the outer attribute of a `mod` line. */
const asOuter = (attribute: string): string => attribute.replace(/^#!\[/, "#[");

/** True when the node is inside an item that a `#[cfg(test)]` compiles only for tests. */
function inTestCode(node: Node): boolean {
  for (let item: Node | null = node; item !== null; item = item.parent) {
    if (attributesBefore(item).some((attribute) => isTestCfg(attribute.text))) return true;
  }
  return false;
}

const tomlTable = (value: TomlValue | undefined): TomlTable => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as TomlTable) : {});

/** The crates a manifest lists in `[dev-dependencies]` and in no other dependency table, by the name `use` paths write them. */
function devOnlyCrates(manifest: string): Set<string> {
  let toml: TomlTable;
  try {
    toml = parseToml(manifest);
  } catch {
    return new Set();
  }
  const tables = [toml, ...Object.values(tomlTable(toml.target)).map(tomlTable)];
  const names = (section: string) => tables.flatMap((table) => Object.keys(tomlTable(table[section]))).map((name) => name.replaceAll("-", "_"));
  const built = new Set([...names("dependencies"), ...names("build-dependencies")]);
  return new Set(names("dev-dependencies").filter((name) => !built.has(name)));
}

function within(node: Node, type: string): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) if (parent.type === type) return true;
  return false;
}

export class RustMove {
  readonly rewrites: Rewrite[] = [];
  readonly warnings: string[] = [];
  readonly breaks: string[] = [];
  private readonly texts = new Map<string, string>();

  private readonly sources = new Map<string, Source>();
  private readonly destination: Map<string, string>;
  private readonly origin = new Map<string, string>();
  private readonly before: ModuleTree;
  private readonly after: ModuleTree;
  private readonly edits = new Map<string, Edit[]>();
  private readonly declarations = new Map<string, Declaration[]>();
  private readonly grammar: LoadedGrammar;
  private readonly tree: SourceTree;
  private readonly operations: readonly FileOperation[];
  private readonly configs: ReadonlyMap<string, string>;
  /** Whether the new `mod` line of each moved file is covered by a `#[cfg(test)]`, by its path after the move. */
  private readonly gated = new Map<string, boolean>();

  constructor(tree: SourceTree, operations: readonly FileOperation[], grammar: LoadedGrammar, configs: ReadonlyMap<string, string>) {
    this.tree = tree;
    this.operations = operations;
    this.grammar = grammar;
    this.configs = configs;
    this.destination = new Map(operations.map((operation) => [operation.from, operation.to]));
    for (const operation of operations) this.origin.set(operation.to, operation.from);
    const paths = [...tree.files.keys()];
    const afterPaths = [...new Set([...paths.filter((path) => !this.destination.has(path)), ...operations.map((operation) => operation.to)])];
    this.before = new ModuleTree(paths, readCrates(paths, configs));
    this.after = new ModuleTree(afterPaths, readCrates(afterPaths, configs));
  }

  /** Where a file is after the move. */
  private moved(path: string): string {
    return this.destination.get(path) ?? path;
  }

  private declared(path: string): Declaration[] {
    let found = this.declarations.get(path);
    if (found === undefined) {
      found = [];
      const root = this.sources.get(path)?.tree.rootNode;
      for (const node of root?.namedChildren ?? []) {
        const name = node.childForFieldName("name")?.text;
        if (node.type === "mod_item" && node.childForFieldName("body") === null && name !== undefined) {
          found.push({ node, name, visibility: visibilityOf(node), attributes: attributesBefore(node) });
        }
      }
      this.declarations.set(path, found);
    }
    return found;
  }

  private edit(path: string, edit: Edit): void {
    this.edits.set(path, [...(this.edits.get(path) ?? []), edit]);
  }

  async run(): Promise<{ rewrites: Rewrite[]; texts: Map<string, string>; warnings: string[]; breaks: string[] }> {
    const rust = [...this.tree.files.keys()].filter((path) => path.endsWith(".rs")).sort(compare);
    for (const [path, text] of await this.tree.readMany(rust)) this.sources.set(path, { path, text, tree: this.grammar.parse(text) });
    try {
      for (const operation of this.operations) {
        if (!this.sources.has(operation.from)) this.warnings.push(`${operation.from} could not be read as a Rust source file`);
      }
      for (const source of this.sources.values()) this.paths(source);
      for (const operation of this.operations) this.moduleDeclaration(operation);
      for (const operation of this.operations) this.devDependencies(operation);
      this.apply();
    } finally {
      for (const source of this.sources.values()) source.tree.delete();
    }
    this.rewrites.sort((a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.from, b.from));
    return { rewrites: this.rewrites, texts: this.texts, warnings: this.warnings, breaks: this.breaks };
  }

  // ---- paths ----

  private paths(source: Source): void {
    const place = this.before.placeOf(source.path);
    const newPath = this.moved(source.path);
    const newPlace = this.after.placeOf(newPath);
    if (place === undefined || newPlace === undefined) return;
    const root = source.tree.rootNode;
    const mods = new Set(this.declared(source.path).map((declaration) => declaration.name));
    const context = { source, place, newPlace, newPath, mods };

    for (const declaration of root.descendantsOfType("use_declaration")) {
      const leaves: Leaf[] = [];
      leavesOf(declaration.childForFieldName("argument"), [], leaves);
      const inline = insideInlineModule(declaration);
      const rendered = leaves.map((leaf) => ({ leaf, path: this.render(context, leaf.segments, inline, leaf.line) }));
      if (rendered.every((entry) => entry.path === undefined)) continue;
      const indent = /[ \t]*$/.exec(source.text.slice(source.text.lastIndexOf("\n", declaration.startIndex - 1) + 1, declaration.startIndex))?.[0] ?? "";
      const visibility = visibilityOf(declaration);
      const lines = rendered.map(({ leaf, path }) => {
        const text = path ?? leaf.segments.join("::");
        return `${visibility}use ${text}${leaf.glob ? "::*" : ""}${leaf.alias === undefined ? "" : ` as ${leaf.alias}`};`;
      });
      this.edit(source.path, { start: declaration.startIndex, end: declaration.endIndex, text: lines.join(`\n${indent}`) });
      for (const { leaf, path } of rendered) {
        if (path !== undefined) this.rewrites.push({ path: newPath, line: leaf.line, from: leaf.segments.join("::"), to: path });
      }
    }

    for (const node of [...root.descendantsOfType("scoped_identifier"), ...root.descendantsOfType("scoped_type_identifier")]) {
      if (within(node, "use_declaration") || node.parent?.type === "scoped_identifier" || node.parent?.type === "scoped_type_identifier") continue;
      const segments: string[] = [];
      if (!pathSegments(node, segments)) continue;
      const path = this.render(context, segments, insideInlineModule(node), node.startPosition.row + 1);
      if (path === undefined) continue;
      this.edit(source.path, { start: node.startIndex, end: node.endIndex, text: path });
      this.rewrites.push({ path: newPath, line: node.startPosition.row + 1, from: segments.join("::"), to: path });
    }
  }

  /**
   * The path as it must now be written, or undefined when it is right as it is, names nothing the move
   * touches, or cannot be followed.
   */
  private render(
    context: { source: Source; place: ModulePlace; newPlace: ModulePlace; newPath: string; mods: ReadonlySet<string> },
    segments: readonly string[],
    inline: boolean,
    line: number,
  ): string | undefined {
    const { place, newPlace, mods } = context;
    const [first, ...rest] = segments;
    if (first === undefined) return undefined;
    let root = place.root;
    let chain: string[];
    let style: "crate" | "relative" | "bare" | "extern";
    if (first === "crate") {
      chain = rest;
      style = "crate";
    } else if (first === "self" || first === "super") {
      if (inline) return undefined;
      let up = 0;
      let remainder: string[] = [...segments];
      while (remainder[0] === "super") {
        up++;
        remainder = remainder.slice(1);
      }
      if (first === "self") remainder = remainder.slice(1);
      if (up > place.path.length) return undefined;
      chain = [...place.path.slice(0, place.path.length - up), ...remainder];
      style = "relative";
    } else if (mods.has(first) && !inline) {
      chain = [...place.path, first, ...rest];
      style = "bare";
    } else {
      const crate = this.crateNamed(place, first);
      if (crate?.libRoot === undefined) return undefined;
      root = crate.libRoot;
      chain = rest;
      style = "extern";
    }

    const walked = this.before.walk({ file: root, root }, chain);
    const movedTo = this.destination.get(walked.file);
    let newRoot = root;
    let newChain = chain;
    if (movedTo !== undefined) {
      const target = this.after.placeOf(movedTo);
      if (target === undefined) {
        this.breaks.push(`${context.source.path}:${line} "${segments.join("::")}" names ${walked.file}, which is in no module tree after the move, so the path cannot be rewritten`);
        return undefined;
      }
      newRoot = target.root;
      newChain = [...target.path, ...chain.slice(walked.consumed)];
    }
    const fileMoved = context.newPath !== context.source.path;
    if (movedTo === undefined && (!fileMoved || style === "crate" || style === "extern")) return undefined;

    let written: string[];
    if (style === "extern") written = [first, ...newChain];
    else if (newRoot !== newPlace.root) {
      this.warnings.push(`${context.newPath}:${line} "${segments.join("::")}" reaches another crate or target after the move, so it was left as it is`);
      return undefined;
    } else if (style === "crate") written = ["crate", ...newChain];
    else {
      let common = 0;
      while (common < newPlace.path.length && common < newChain.length && newPlace.path[common] === newChain[common]) common++;
      const up = newPlace.path.length - common;
      const below = newChain.slice(common);
      if (up >= 2) written = ["crate", ...newChain];
      else if (up === 1) written = ["super", ...below];
      else written = style === "bare" && below.length > 0 ? below : ["self", ...below];
    }
    const text = written.join("::");
    if (text === segments.join("::")) return undefined;
    this.privacy(context.newPath, line, text, newRoot, newChain, newPlace);
    return text;
  }

  private crateNamed(place: ModulePlace, name: string) {
    if (place.crate?.libName === name) return place.crate;
    const directory = place.crate?.dependencies.get(name);
    return directory === undefined ? undefined : this.before.crates.find((crate) => crate.dir === directory && crate.name !== null);
  }

  /** Warns when the path passes a private module that the file is no longer inside. */
  private privacy(path: string, line: number, text: string, root: string, chain: readonly string[], from: ModulePlace): void {
    for (let length = 1; length <= chain.length; length++) {
      const prefix = chain.slice(0, length);
      const walked = this.after.walk({ file: root, root }, prefix);
      if (walked.consumed !== length) return;
      const declaring = this.origin.get(walked.file) ?? walked.file;
      const declaration = this.declarationOf(declaring);
      if (declaration === undefined || declaration.visibility !== "") continue;
      const parent = prefix.slice(0, -1);
      const reachable = from.root === root && parent.every((name, index) => from.path[index] === name);
      if (!reachable) {
        const name = (names: readonly string[]) => ["crate", ...names].join("::");
        this.warnings.push(`${path}:${line} "${text}" goes through the private module ${name(prefix)}, which only ${name(parent)} can reach: it needs pub(crate) or pub(super)`);
        return;
      }
    }
  }

  /** The `mod name;` declaration of a module file, as written before the move. */
  private declarationOf(file: string): Declaration | undefined {
    const place = this.before.placeOf(file);
    if (place === undefined || place.path.length === 0) return undefined;
    const parent = this.before.walk({ file: place.root, root: place.root }, place.path.slice(0, -1));
    return this.declared(parent.file).find((declaration) => declaration.name === place.path.at(-1));
  }

  // ---- module declarations ----

  private moduleDeclaration(operation: FileOperation): void {
    const place = this.before.placeOf(operation.from);
    const newPlace = this.after.placeOf(operation.to);
    if (place === undefined || !operation.to.endsWith(".rs")) return;
    if (newPlace === undefined) {
      this.breaks.push(`${operation.to} is in no module tree after the move: a Rust file is a module only under the folder of its target's root file (${place.root})`);
      return;
    }
    this.childrenLeftBehind(operation, place, newPlace);
    if (place.path.length === 0 || newPlace.path.length === 0) return;
    if (newPlace.root !== place.root) {
      this.breaks.push(`${operation.to} moves into the module tree of ${newPlace.root}, another crate or target, and leaves the tree of ${place.root}`);
      return;
    }
    const oldName = place.path.at(-1)!;
    const newName = newPlace.path.at(-1)!;
    const oldParent = this.before.walk({ file: place.root, root: place.root }, place.path.slice(0, -1));
    const declaration = oldParent.consumed === place.path.length - 1 ? this.declared(oldParent.file).find((candidate) => candidate.name === oldName) : undefined;
    if (declaration === undefined) {
      this.warnings.push(`${operation.from} is not declared by a \`mod ${oldName};\` in ${oldParent.file}, so no declaration was moved`);
      return;
    }
    const newParent = this.after.walk({ file: newPlace.root, root: newPlace.root }, newPlace.path.slice(0, -1));
    const oldParentAfter = this.moved(oldParent.file);
    const parentFound = newParent.consumed === newPlace.path.length - 1;
    if (parentFound && newParent.file === oldParentAfter) {
      if (newName === oldName) return;
      const identifier = declaration.node.childForFieldName("name")!;
      this.edit(oldParent.file, { start: identifier.startIndex, end: identifier.endIndex, text: newName });
      this.rewrites.push({ path: oldParentAfter, line: declaration.node.startPosition.row + 1, from: `${declaration.visibility}mod ${oldName}`, to: `${declaration.visibility}mod ${newName}` });
      return;
    }
    const source = this.sources.get(oldParent.file)!;
    const first = declaration.attributes[0] ?? declaration.node;
    const start = source.text.lastIndexOf("\n", first.startIndex - 1) + 1;
    const newline = source.text.indexOf("\n", declaration.node.endIndex);
    this.edit(oldParent.file, { start, end: newline < 0 ? source.text.length : newline + 1, text: "" });
    this.rewrites.push({ path: oldParentAfter, line: declaration.node.startPosition.row + 1, from: `${declaration.visibility}mod ${oldName}`, to: "" });

    if (!parentFound) {
      this.warnings.push(`${operation.to} has no module file above it to declare it: declare \`mod ${newName};\` in the module whose folder it now sits in`);
      return;
    }
    const target = this.origin.get(newParent.file) ?? newParent.file;
    const own = declaration.attributes.map((attribute) => attribute.text);
    const kept = new Set([...own, ...this.cfgsAbove(newPlace, this.after, true)]);
    const carried = [...new Set(this.cfgsAbove(place, this.before, false).filter((attribute) => !kept.has(attribute)))];
    this.gated.set(operation.to, [...own, ...carried, ...kept].some(isTestCfg));
    const text = [...carried, ...own, `${declaration.visibility}mod ${newName};`].join("\n");
    this.insertDeclaration(target, newParent.file, text, `${declaration.visibility}mod ${newName}`);
  }

  /**
   * The `cfg` attributes of the modules above a module, outermost first, as outer attributes: those on the `mod`
   * line that declares each and the `#![cfg]` at the top of each module's file. The crate root's own are left
   * out, since they cover both sides of a move within the crate. `after` reads the tree after the move.
   */
  private cfgsAbove(place: ModulePlace, tree: ModuleTree, after: boolean): string[] {
    const out: string[] = [];
    for (let length = 1; length < place.path.length; length++) {
      const parent = tree.walk({ file: place.root, root: place.root }, place.path.slice(0, length - 1));
      const module = tree.walk({ file: place.root, root: place.root }, place.path.slice(0, length));
      if (parent.consumed !== length - 1 || module.consumed !== length) continue;
      const source = (file: string) => (after ? (this.origin.get(file) ?? file) : file);
      const declaration = this.declared(source(parent.file)).find((candidate) => candidate.name === place.path[length - 1]);
      for (const attribute of declaration?.attributes ?? []) if (isCfg(attribute.text)) out.push(attribute.text);
      for (const node of this.sources.get(source(module.file))?.tree.rootNode.namedChildren ?? []) {
        if (node.type === "inner_attribute_item" && isCfg(node.text)) out.push(asOuter(node.text));
      }
    }
    return out;
  }

  /** Warns when a moved file uses a crate that is a dev-dependency only, and no `#[cfg(test)]` covers it after the move. */
  private devDependencies(operation: FileOperation): void {
    const gated = this.gated.get(operation.to);
    const source = this.sources.get(operation.from);
    const crate = this.after.placeOf(operation.to)?.crate;
    if (gated !== false || source === undefined || crate === undefined) return;
    const manifest = this.configs.get(crate.manifest);
    if (manifest === undefined) return;
    const devOnly = devOnlyCrates(manifest);
    if (devOnly.size === 0) return;
    const root = source.tree.rootNode;
    if (root.namedChildren.some((node) => node.type === "inner_attribute_item" && isTestCfg(node.text))) return;
    const used = new Set<string>();
    for (const declaration of root.descendantsOfType("use_declaration")) {
      if (inTestCode(declaration)) continue;
      const leaves: Leaf[] = [];
      leavesOf(declaration.childForFieldName("argument"), [], leaves);
      for (const leaf of leaves) if (devOnly.has(leaf.segments[0] ?? "")) used.add(leaf.segments[0]!);
    }
    for (const node of [...root.descendantsOfType("scoped_identifier"), ...root.descendantsOfType("scoped_type_identifier")]) {
      if (within(node, "use_declaration") || inTestCode(node)) continue;
      const segments: string[] = [];
      if (pathSegments(node, segments) && devOnly.has(segments[0] ?? "")) used.add(segments[0]!);
    }
    if (used.size === 0) return;
    this.warnings.push(
      `${operation.to} uses ${[...used].sort(compare).join(", ")}, which ${crate.manifest} lists only in [dev-dependencies], and no #[cfg(test)] covers its module after the move, so the build without tests does not compile`,
    );
  }

  /** The module files declared by a moved file that do not move with it, which it can no longer find. */
  private childrenLeftBehind(operation: FileOperation, place: ModulePlace, newPlace: ModulePlace): void {
    const here = moduleDirectory(operation.from, place.root);
    if (here === moduleDirectory(operation.to, newPlace.root)) return;
    for (const declaration of this.declared(operation.from)) {
      const child = this.before.child(here, declaration.name);
      if (child !== undefined && !this.destination.has(child)) {
        this.warnings.push(`${operation.to} declares \`mod ${declaration.name};\` but ${child} does not move with it, so the module is no longer found`);
      }
    }
  }

  private insertDeclaration(target: string, afterPath: string, text: string, shown: string): void {
    const source = this.sources.get(target);
    if (source === undefined) return;
    const top = source.tree.rootNode.namedChildren;
    const lastOf = (type: string): Node | undefined => top.filter((node) => node.type === type && (type !== "mod_item" || node.childForFieldName("body") === null)).at(-1);
    const anchor = lastOf("mod_item") ?? lastOf("use_declaration");
    if (anchor !== undefined) {
      const newline = source.text.indexOf("\n", anchor.endIndex);
      const at = newline < 0 ? source.text.length : newline + 1;
      this.edit(target, { start: at, end: at, text: newline < 0 ? `\n${text}\n` : `${text}\n` });
      this.rewrites.push({ path: afterPath, line: anchor.endPosition.row + 2, from: "", to: shown });
      return;
    }
    const first = top.find((node) => !(node.type === "inner_attribute_item" || (node.type === "line_comment" && node.text.startsWith("//!"))));
    const at = first === undefined ? source.text.length : source.text.lastIndexOf("\n", first.startIndex - 1) + 1;
    const blankAfter = first === undefined || source.text[at] === "\n" ? "" : "\n";
    this.edit(target, { start: at, end: at, text: `${text}\n${blankAfter}` });
    this.rewrites.push({ path: afterPath, line: (first?.startPosition.row ?? 0) + 1, from: "", to: shown });
  }

  // ---- result ----

  private apply(): void {
    for (const source of this.sources.values()) {
      const edits = [...(this.edits.get(source.path) ?? [])].sort((a, b) => b.start - a.start || b.end - a.end);
      let text = source.text;
      for (const edit of edits) text = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
      if (text !== source.text) this.texts.set(this.moved(source.path), text);
    }
  }
}

/** The `Cargo.toml` files a move reads to find crates. */
export async function readConfigs(tree: SourceTree): Promise<Map<string, string>> {
  return tree.readMany([...tree.files.keys()].filter(isManifestPath));
}
