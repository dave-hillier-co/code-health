import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Node } from "web-tree-sitter";
import { GrammarSet, type LoadedGrammar } from "@code-health/parse/grammars";
import { pathSegments } from "@code-health/parse/languages/rust/extract-facts";
import type { SourceTree } from "@code-health/parse/source-tree";
import type { FileOperation } from "../move-plan.ts";
import { oncePerTree, type MoveResult, type MoverBackend, type Skeleton } from "./mover-language.ts";
import { readProject, RustMove } from "./rust-moves.ts";

let grammar: LoadedGrammar | undefined;

function insideUse(node: Node): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) if (parent.type === "use_declaration") return true;
  return false;
}

async function loadGrammar(): Promise<LoadedGrammar> {
  if (grammar === undefined) {
    const language = await new GrammarSet().forPath("x.rs");
    if (language === undefined) throw new Error("the Rust grammar is not available");
    grammar = language.grammar;
  }
  return grammar;
}

/** The Rust files and manifests of a tree, read and parsed once for the tree (see `oncePerTree`). */
const projectOf = oncePerTree(async (tree) => readProject(tree, await loadGrammar()));

async function performMove(tree: SourceTree, operations: readonly FileOperation[]): Promise<Omit<MoveResult, "confirmations">> {
  const move = new RustMove(tree, operations, await projectOf(tree));
  return move.run();
}

/**
 * The text with each path blanked that a move may rewrite: the argument of every `use`, and every path in
 * code that starts at `crate`, `self` or `super`. What remains is everything a rewritten path leaves alone.
 * Needs the grammar a move has loaded, which `verifyMove` always has by the time it asks: without it, the
 * text is returned as it is.
 */
function skeleton(_path: string, text: string): Skeleton {
  if (grammar === undefined) return { text, specifiers: [] };
  const tree = grammar.parse(text);
  try {
    const found: { start: number; end: number; value: string; line: number }[] = [];
    const root = tree.rootNode;
    for (const declaration of root.descendantsOfType("use_declaration")) {
      const argument = declaration.childForFieldName("argument");
      if (argument !== null) found.push({ start: argument.startIndex, end: argument.endIndex, value: argument.text.replace(/\s+/g, ""), line: argument.startPosition.row + 1 });
    }
    const paths: Node[] = [...root.descendantsOfType("scoped_identifier"), ...root.descendantsOfType("scoped_type_identifier")];
    for (const node of paths) {
      if (node.parent?.type === "scoped_identifier" || node.parent?.type === "scoped_type_identifier") continue;
      if (node.parent?.type === "use_declaration" || node.parent?.type === "use_wildcard" || node.parent?.type === "use_as_clause" || node.parent?.type === "scoped_use_list") continue;
      if (insideUse(node)) continue;
      const segments: string[] = [];
      if (!pathSegments(node, segments) || !["crate", "self", "super"].includes(segments[0]!)) continue;
      found.push({ start: node.startIndex, end: node.endIndex, value: node.text, line: node.startPosition.row + 1 });
    }
    found.sort((a, b) => a.start - b.start);
    let blanked = text;
    for (const entry of [...found].reverse()) blanked = `${blanked.slice(0, entry.start)}${blanked.slice(entry.end)}`;
    return { text: blanked, specifiers: found.map(({ value, line }) => ({ value, line })) };
  } finally {
    tree.delete();
  }
}

/** Files rust-analyzer needs to load a workspace: sources, manifests, the lock file and toolchain and cargo configuration. */
const needed = /(\.rs|(^|\/)Cargo\.(toml|lock)|(^|\/)rust-toolchain(\.toml)?|(^|\/)\.cargo\/config(\.toml)?)$/;

function run(executable: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: String(error.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

const unresolved = /unresolved[ -](?:import|module|extern crate)|\bE0(?:432|433|583)\b/;

/**
 * Asks rust-analyzer to check the moved workspace: it writes the files as the move leaves them to a scratch
 * folder and runs `rust-analyzer diagnostics` there. A workspace that cannot be loaded (dependencies it
 * cannot fetch) is not confirmed, never a failure.
 */
async function confirm(tree: SourceTree, operations: readonly FileOperation[], tool: { name: string; path: string }): Promise<{ status: "confirmed" | "not confirmed"; detail: string }> {
  const result = await performMove(tree, operations);
  const removed = new Set(operations.map((operation) => operation.from));
  const origin = new Map(operations.map((operation) => [operation.to, operation.from]));
  const wanted = [...tree.files.keys()].filter((path) => needed.test(path));
  const originals = await tree.readMany(wanted);
  const files = new Map<string, string>();
  for (const [path, text] of originals) if (!removed.has(path)) files.set(path, text);
  for (const operation of operations) {
    const text = originals.get(operation.from);
    if (text !== undefined) files.set(operation.to, text);
  }
  for (const [path, text] of result.texts) if (origin.has(path) || files.has(path)) files.set(path, text);

  const directory = await mkdtemp(join(tmpdir(), "code-health-rust-"));
  try {
    for (const [path, text] of files) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), text);
    }
    const ran = await run(tool.path, ["diagnostics", "."], directory, 300_000);
    const problems = ran.output.split("\n").filter((line) => unresolved.test(line));
    if (ran.code !== 0 && problems.length === 0) {
      return { status: "not confirmed", detail: `${tool.name} could not check the workspace: ${ran.output.trim().split("\n").slice(-1)[0] ?? `exit ${ran.code}`}` };
    }
    if (problems.length > 0) return { status: "not confirmed", detail: `${tool.name} reports ${problems.length} unresolved module or import: ${problems[0]!.trim()}` };
    return { status: "confirmed", detail: `${tool.name} found no unresolved module or import` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const backend: MoverBackend = { performMove, skeleton, confirm };
