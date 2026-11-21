import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** One diagnostic a language server published for a file. */
export interface Diagnostic {
  /** LSP severity: 1 error, 2 warning, 3 information, 4 hint. */
  severity: number;
  message: string;
  line: number;
}

type Handler = (params: unknown) => void;

/**
 * A language server over stdio, as far as confirming a move needs: initialize it on a folder, open files,
 * and collect the diagnostics it publishes. It speaks JSON-RPC with `Content-Length` framing and answers
 * the requests a server makes of its client with empty results, so none of them wait.
 */
export class LspSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  private readonly notifications = new Map<string, Handler[]>();
  private exited: Promise<void>;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", () => undefined);
    this.exited = new Promise((resolve) => child.on("close", () => resolve()));
    child.on("error", () => undefined);
    child.stdin.on("error", () => undefined);
  }

  static start(executable: string, args: readonly string[], cwd: string): LspSession {
    return new LspSession(spawn(executable, [...args], { cwd, stdio: ["pipe", "pipe", "pipe"] }));
  }

  private send(message: object): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString("ascii"))?.[1]);
      if (!Number.isFinite(length) || this.buffer.length < end + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString("utf8")) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
      this.buffer = this.buffer.subarray(end + 4 + length);
      if (message.method !== undefined && message.id !== undefined) this.send({ id: message.id, result: null });
      else if (message.method !== undefined) for (const handler of this.notifications.get(message.method) ?? []) handler(message.params);
      else if (message.id !== undefined) this.pending.get(message.id)?.(message);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => (message.error === undefined ? resolve(message.result) : reject(new Error(message.error.message))));
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  on(method: string, handler: Handler): void {
    this.notifications.set(method, [...(this.notifications.get(method) ?? []), handler]);
  }

  /** Asks the server to shut down, then ends it if it does not go by itself. */
  async close(): Promise<void> {
    try {
      await Promise.race([this.request("shutdown", null), new Promise((resolve) => setTimeout(resolve, 2000))]);
      this.notify("exit", null);
    } catch {
      // the server is gone already
    }
    const stopped = await Promise.race([this.exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))]);
    if (!stopped) this.child.kill("SIGKILL");
  }
}

/** Runs `session` against a deadline: resolves with what `body` finds, or undefined when the time is up. */
export async function within<T>(milliseconds: number, body: Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([body, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), milliseconds)))]);
  } finally {
    clearTimeout(timer);
  }
}
