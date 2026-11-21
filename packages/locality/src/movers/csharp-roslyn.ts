import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SourceTree } from "@code-health/parse/source-tree";
import type { FileOperation } from "../move-plan.ts";
import type { MoveResult } from "./language.ts";

/**
 * Confirms a C# move with the Roslyn language server (`Microsoft.CodeAnalysis.LanguageServer`), when it is
 * installed. The repository is written to a scratch folder twice, as it was and as the move leaves it, and the
 * server is asked for the compile errors of the moved files in each. The move is confirmed when it adds no
 * error the files did not already have: errors both trees share are the restore, SDK and package problems of
 * a machine that has not built the code, and they say nothing about the move.
 *
 * The server speaks the language server protocol over stdio. Projects are opened with the `solution/open` and
 * `project/open` notifications of the Roslyn server, and loading is done when it sends
 * `workspace/projectInitializationComplete`.
 */

const buildFiles = /(?:\.cs|\.csproj|\.sln|\.slnx|\.props|\.targets|\.editorconfig|global\.json|nuget\.config)$/i;

interface Message {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

/** A minimal JSON-RPC connection over a child process's stdio, with `Content-Length` framing. */
class Connection {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly notifications = new Map<string, { resolve(): void; reject(error: Error): void }[]>();
  private readonly seen = new Set<string>();
  private closed: Error | undefined;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code) => this.fail(new Error(`the language server exited with code ${code}`)));
  }

  private fail(error: Error): void {
    this.closed ??= error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    for (const waiters of this.notifications.values()) for (const waiter of waiters) waiter.reject(error);
    this.notifications.clear();
  }

  private send(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const length = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, separator).toString("ascii"))?.[1];
      if (length === undefined) {
        this.fail(new Error("the language server sent a message with no Content-Length"));
        return;
      }
      const end = separator + 4 + Number(length);
      if (this.buffer.length < end) return;
      const message = JSON.parse(this.buffer.subarray(separator + 4, end).toString("utf8")) as Message;
      this.buffer = this.buffer.subarray(end);
      this.dispatch(message);
    }
  }

  private dispatch(message: Message): void {
    if (message.method !== undefined && message.id !== undefined) {
      // A request from the server (configuration, registration, progress): nothing here needs answering with more than null.
      this.send({ id: message.id, result: null });
    } else if (message.method !== undefined) {
      this.seen.add(message.method);
      for (const waiter of this.notifications.get(message.method) ?? []) waiter.resolve();
      this.notifications.delete(message.method);
    } else if (message.id !== undefined) {
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error !== undefined) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed !== undefined) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  /** Resolves when the server sends the notification, or when it already has. */
  waitFor(method: string, timeoutMs: number): Promise<void> {
    if (this.seen.has(method)) return Promise.resolve();
    if (this.closed !== undefined) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the language server did not send ${method} within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      this.notifications.set(method, [
        ...(this.notifications.get(method) ?? []),
        { resolve: () => (clearTimeout(timer), resolve()), reject: (error) => (clearTimeout(timer), reject(error)) },
      ]);
    });
  }

  async close(): Promise<void> {
    try {
      await Promise.race([this.request("shutdown", null), new Promise((resolve) => setTimeout(resolve, 2000))]);
      this.notify("exit", null);
    } catch {
      // The server is gone already.
    }
    this.child.kill();
  }
}

export interface Problem {
  /** The file as it was before the move. */
  file: string;
  code: string;
  message: string;
}

/** Writes the files a build needs to a scratch folder. */
async function materialise(root: string, tree: SourceTree, texts: ReadonlyMap<string, string>, moves: ReadonlyMap<string, string>): Promise<void> {
  const paths = [...tree.files.keys()].filter((path) => buildFiles.test(path));
  const contents = await tree.readMany(paths);
  for (const [path, text] of contents) {
    const target = moves.get(path) ?? path;
    mkdirSync(dirname(join(root, target)), { recursive: true });
    writeFileSync(join(root, target), texts.get(target) ?? text);
  }
  for (const [path, text] of texts) {
    if (contents.has(path)) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** The compile errors of `files` (paths under `root`) in the projects of `root`. */
async function errorsOf(executable: string, root: string, projects: readonly string[], solution: string | undefined, files: ReadonlyMap<string, string>, timeoutMs: number): Promise<Problem[]> {
  const log = join(root, ".code-health-lsp");
  mkdirSync(log, { recursive: true });
  const child = spawn(executable, ["--stdio", "--logLevel", "Warning", "--extensionLogDirectory", log], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const connection = new Connection(child);
  try {
    await connection.request("initialize", { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: { textDocument: { diagnostic: { dynamicRegistration: false } } }, workspaceFolders: [{ uri: pathToFileURL(root).href, name: "root" }] });
    connection.notify("initialized", {});
    if (solution !== undefined) connection.notify("solution/open", { solution: pathToFileURL(join(root, solution)).href });
    else connection.notify("project/open", { projects: projects.map((project) => pathToFileURL(join(root, project)).href) });
    await connection.waitFor("workspace/projectInitializationComplete", timeoutMs);

    const problems: Problem[] = [];
    for (const [path, original] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const uri = pathToFileURL(join(root, path)).href;
      connection.notify("textDocument/didOpen", { textDocument: { uri, languageId: "csharp", version: 1, text: readFileSync(join(root, path), "utf8") } });
      const report = (await connection.request("textDocument/diagnostic", { textDocument: { uri } })) as { items?: { severity?: number; code?: string | number; message: string }[] } | null;
      for (const item of report?.items ?? []) if (item.severity === 1) problems.push({ file: original, code: String(item.code ?? ""), message: item.message });
    }
    return problems;
  } finally {
    await connection.close();
  }
}

export interface RoslynOptions {
  /** How long project loading may take. */
  timeoutMs?: number;
}

/** The result of checking a move with the Roslyn language server. Never throws: a server that cannot be used leaves the move not confirmed. */
export async function confirmWithRoslyn(
  tree: SourceTree,
  operations: readonly FileOperation[],
  tool: { name: string; path: string },
  perform: (tree: SourceTree, operations: readonly FileOperation[]) => Promise<Omit<MoveResult, "confirmations">>,
  options: RoslynOptions = {},
): Promise<{ status: "confirmed" | "not confirmed"; detail: string }> {
  const moved = operations.filter((operation) => operation.from.endsWith(".cs") && tree.files.has(operation.from));
  if (moved.length === 0) return { status: "not confirmed", detail: `${tool.name} had no C# file to check` };
  const timeoutMs = options.timeoutMs ?? 180_000;
  const root = mkdtempSync(join(tmpdir(), "code-health-roslyn-"));
  try {
    const after = await perform(tree, operations);
    const moves = new Map(operations.map((operation) => [operation.from, operation.to]));
    const paths = [...tree.files.keys()].sort();
    const solutionOf = (all: readonly string[]): string | undefined => all.filter((path) => /\.(sln|slnx)$/i.test(path)).sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1))[0];
    const projectsOf = (all: readonly string[]): string[] => all.filter((path) => path.endsWith(".csproj")).sort();

    const beforeRoot = join(root, "before");
    await materialise(beforeRoot, tree, new Map(), new Map());
    const before = await errorsOf(tool.path, beforeRoot, projectsOf(paths), solutionOf(paths), new Map(moved.map((operation) => [operation.from, operation.from])), timeoutMs);

    const afterRoot = join(root, "after");
    await materialise(afterRoot, tree, after.texts, moves);
    const afterPaths = paths.map((path) => moves.get(path) ?? path);
    const checked = await errorsOf(tool.path, afterRoot, projectsOf(afterPaths), solutionOf(afterPaths), new Map(moved.map((operation) => [operation.to, operation.from])), timeoutMs);

    const known = new Set(before.map((problem) => `${problem.file}\0${problem.code}\0${problem.message}`));
    const added = checked.filter((problem) => !known.has(`${problem.file}\0${problem.code}\0${problem.message}`));
    if (added.length === 0) return { status: "confirmed", detail: `${tool.name} found no compile error in ${moved.length} moved file${moved.length === 1 ? "" : "s"} that they did not have before the move` };
    const shown = added.slice(0, 3).map((problem) => `${problem.file}: ${problem.code} ${problem.message}`);
    return { status: "not confirmed", detail: `${tool.name} found ${added.length} new compile error${added.length === 1 ? "" : "s"} after the move: ${shown.join("; ")}${added.length > 3 ? "; ..." : ""}` };
  } catch (error) {
    return { status: "not confirmed", detail: `${tool.name} could not check the move: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
