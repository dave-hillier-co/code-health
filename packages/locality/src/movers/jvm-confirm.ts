import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SourceTree } from "@code-health/parse/source-tree";
import type { FileOperation } from "../move-plan.ts";
import { LspSession, within, type Diagnostic } from "./lsp-session.ts";

/** A diagnostic that says a name no longer resolves, which is what a move that broke a reference leaves. */
const unresolved = /cannot be resolved|cannot find symbol|unresolved reference|does not exist|not found|is not visible|cannot access|unresolved import/i;

/** How the server of each tool is started. The language servers are optional, so none of this runs without one. */
function argumentsOf(tool: string, workspace: string): string[] {
  if (tool === "jdtls") return ["-data", join(workspace, ".jdtls-data")];
  if (tool === "kotlin-lsp") return ["--stdio"];
  return [];
}

const languageIds: Record<string, string> = { ".java": "java", ".kt": "kotlin" };
const materialised = /\.(java|kt|kts|gradle|xml|properties|toml)$/;

export interface Confirmation {
  status: "confirmed" | "not confirmed";
  detail: string;
}

/**
 * Asks a language server whether the references of a move still resolve. The tree after the move is written to a
 * temporary folder, the files the move changed are opened in the server, and the diagnostics it publishes for
 * them are read. The move is confirmed when every one of those files was checked and none reports a name that
 * does not resolve. A server that does not answer in time, or cannot be started, leaves it not confirmed: the
 * tool is an extra check, never a reason to fail.
 */
export async function confirmWithLanguageServer(
  tree: SourceTree,
  operations: readonly FileOperation[],
  texts: ReadonlyMap<string, string>,
  tool: { name: string; path: string },
  options: { timeoutMs?: number; arguments?: readonly string[] } = {},
): Promise<Confirmation> {
  const workspace = await mkdtemp(join(tmpdir(), "code-health-lsp-"));
  const session = LspSession.start(tool.path, options.arguments ?? argumentsOf(tool.name, workspace), workspace);
  try {
    const moved = new Set(operations.map((operation) => operation.from));
    const files = new Map<string, string>();
    for (const [path, text] of await tree.readMany([...tree.files.keys()].filter((path) => materialised.test(path) && !moved.has(path)))) files.set(path, text);
    for (const [path, text] of texts) files.set(path, text);
    for (const operation of operations) {
      if (!texts.has(operation.to)) {
        const text = await tree.read(operation.from);
        if (text !== undefined) files.set(operation.to, text);
      }
    }
    for (const [path, text] of files) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(join(workspace, path), text);
    }

    const opened = [...texts.keys()].filter((path) => languageIds[path.slice(path.lastIndexOf("."))] !== undefined).sort();
    if (opened.length === 0) return { status: "confirmed", detail: `${tool.name}: the move changed no source text, so there is no reference to check` };
    const reported = new Map<string, Diagnostic[]>();
    const everyFile = new Promise<true>((resolve) => {
      session.on("textDocument/publishDiagnostics", (params) => {
        const { uri, diagnostics } = params as { uri: string; diagnostics: { severity?: number; message: string; range: { start: { line: number } } }[] };
        reported.set(uri, diagnostics.map((d) => ({ severity: d.severity ?? 1, message: d.message, line: d.range.start.line + 1 })));
        if (opened.every((path) => reported.has(pathToFileURL(join(workspace, path)).href))) resolve(true);
      });
    });

    const root = pathToFileURL(workspace).href;
    const started = await within(options.timeoutMs ?? 60_000, session.request("initialize", { processId: process.pid, rootUri: root, workspaceFolders: [{ uri: root, name: "workspace" }], capabilities: { textDocument: { publishDiagnostics: {} } } }));
    if (started === undefined) return { status: "not confirmed", detail: `${tool.name} did not start in time` };
    session.notify("initialized", {});
    for (const path of opened) {
      session.notify("textDocument/didOpen", { textDocument: { uri: pathToFileURL(join(workspace, path)).href, languageId: languageIds[path.slice(path.lastIndexOf("."))], version: 1, text: files.get(path) } });
    }
    const finished = await within(options.timeoutMs ?? 60_000, everyFile);
    const broken = [...reported].flatMap(([uri, list]) => list.filter((d) => d.severity === 1 && unresolved.test(d.message)).map((d) => `${decodeURIComponent(uri.slice(root.length + 1))}:${d.line} ${d.message}`));
    if (broken.length > 0) return { status: "not confirmed", detail: `${tool.name} reports ${broken.length} unresolved reference${broken.length === 1 ? "" : "s"}: ${broken.slice(0, 3).join("; ")}` };
    if (finished === undefined) return { status: "not confirmed", detail: `${tool.name} checked ${reported.size} of ${opened.length} changed files before the time was up` };
    return { status: "confirmed", detail: `${tool.name} resolved every reference in the ${opened.length} changed file${opened.length === 1 ? "" : "s"}` };
  } catch (error) {
    return { status: "not confirmed", detail: `${tool.name} could not check the move: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await session.close();
    await rm(workspace, { recursive: true, force: true });
  }
}
