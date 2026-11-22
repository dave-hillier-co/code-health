import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

/** Reads stdin to its end, or gives up with what it has when `limitMs` of the process's life is spent. */
function readStdin(limitMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    const chunks: Buffer[] = [];
    const finish = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, Math.max(0, limitMs - performance.now()));
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

/** What the worker is started with. */
interface HookJob {
  /** Names the plugin's hook, so a worker started for another job is not mistaken for this one. */
  kind: string;
  stdin: string;
  cwd: string;
}

/** What a plugin gives the shared hook process. */
export interface HookDefinition {
  /** Names the worker's job, for example `complexity-hook`. */
  kind: string;
  /** The hook's work: the raw stdin and the working directory in, the stdout to print (empty for silence) out. It never throws. */
  run: (request: { stdin: string; cwd: string; budgetMs: number }) => Promise<string>;
  /** The time budget in milliseconds, counted from process start. */
  defaultBudgetMs: number;
  /**
   * The file the worker runs. It must be the plugin's entry point, which calls
   * `inHookWorker` first: the bundle itself, or the plugin's `main.ts` from source.
   */
  entry: URL;
}

/** A plugin's worker entry: its `main.ts` when `moduleUrl` is the source module `sourceModule`, otherwise the bundle that `moduleUrl` is. */
export function workerEntry(moduleUrl: string, sourceModule: string): URL {
  return moduleUrl.endsWith(`/${sourceModule}`) ? new URL("./main.ts", moduleUrl) : new URL(moduleUrl);
}

/**
 * Does the hook's work on a worker thread, so this thread's timer can end the process at the
 * budget even while the worker is in a long synchronous stretch of history work. Resolves with
 * the worker's answer, or with silence when the budget is spent first or the worker fails.
 */
function runInWorker(entry: URL, job: HookJob, budgetMs: number): Promise<string> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(entry, { workerData: job });
    } catch {
      return resolve("");
    }
    const timer = setTimeout(() => resolve(""), Math.max(0, budgetMs - performance.now()));
    worker.on("message", (output: string) => {
      clearTimeout(timer);
      resolve(output);
    });
    worker.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    worker.on("exit", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

/** The worker side: runs the hook for the job and posts what it would print. */
export async function runHookWorker(hook: HookDefinition): Promise<void> {
  const job = workerData as HookJob;
  // The parent enforces the budget, so the hook's own timer is set well beyond it.
  const output = await hook.run({ stdin: job.stdin, cwd: job.cwd, budgetMs: 60_000 });
  parentPort?.postMessage(output);
}

/** True in the worker thread this module starts. */
export const inHookWorker = (kind: string): boolean => !isMainThread && (workerData as HookJob | null)?.kind === kind;

/**
 * The process's time budget. `CODE_HEALTH_HOOK_BUDGET_MS` overrides it so that tests of what the
 * hook says do not depend on how loaded the machine is. Claude Code never sets it.
 */
function budgetMs(fallback: number): number {
  const raw = process.env.CODE_HEALTH_HOOK_BUDGET_MS;
  if (raw === undefined || raw.trim() === "") return fallback;
  // Zero is a budget that is already spent, which tests use to see the hook go silent without racing it.
  const override = Number(raw);
  return Number.isInteger(override) && override >= 0 ? override : fallback;
}

/**
 * Runs the hook as a process: stdin is the event, stdout is the answer, and
 * the exit code is 0 on every path. The process exits as soon as the answer
 * is written, so abandoned work cannot hold it open past the time budget.
 */
export async function runHookProcess(hook: HookDefinition): Promise<never> {
  let output = "";
  try {
    const budget = budgetMs(hook.defaultBudgetMs);
    const stdin = await readStdin(budget);
    output = await runInWorker(hook.entry, { kind: hook.kind, stdin, cwd: process.cwd() }, budget);
  } catch {
    // runInWorker does not reject; this keeps the exit code 0 even so.
  }
  return new Promise<never>(() => {
    const exit = () => process.exit(0);
    if (output === "") exit();
    process.stdout.write(output + "\n", exit);
  });
}
