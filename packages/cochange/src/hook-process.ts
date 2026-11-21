import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { DEFAULT_BUDGET_MS, runHook } from "./hook.ts";

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
  kind: "cochange-hook";
  stdin: string;
  cwd: string;
}

/** The file the worker runs: the bundle itself, or `main.ts` when running from source. */
const entry = import.meta.url.endsWith("/hook-process.ts") ? new URL("./main.ts", import.meta.url) : new URL(import.meta.url);

/**
 * Does the hook's work on a worker thread, so this thread's timer can end the process at the
 * budget even while the worker is in a long synchronous stretch of history work. Resolves with
 * the worker's answer, or with silence when the budget is spent first or the worker fails.
 */
function runInWorker(job: HookJob, budgetMs: number): Promise<string> {
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
export async function runHookWorker(): Promise<void> {
  const job = workerData as HookJob;
  // The parent enforces the budget, so the hook's own timer is set well beyond it.
  const output = await runHook({ stdin: job.stdin, cwd: job.cwd, budgetMs: 60_000 });
  parentPort?.postMessage(output);
}

/** True in the worker thread this module starts. */
export const inHookWorker = (): boolean => !isMainThread && (workerData as HookJob | null)?.kind === "cochange-hook";

/**
 * The process's time budget. `CODE_HEALTH_HOOK_BUDGET_MS` overrides it so that tests of what the
 * hook says do not depend on how loaded the machine is. Claude Code never sets it.
 */
function budgetMs(): number {
  const override = Number(process.env.CODE_HEALTH_HOOK_BUDGET_MS);
  return Number.isInteger(override) && override > 0 ? override : DEFAULT_BUDGET_MS;
}

/**
 * Runs the hook as a process: stdin is the event, stdout is the answer, and
 * the exit code is 0 on every path. The process exits as soon as the answer
 * is written, so abandoned work cannot hold it open past the time budget.
 */
export async function runHookProcess(): Promise<never> {
  let output = "";
  try {
    const budget = budgetMs();
    const stdin = await readStdin(budget);
    output = await runInWorker({ kind: "cochange-hook", stdin, cwd: process.cwd() }, budget);
  } catch {
    // runInWorker does not reject; this keeps the exit code 0 even so.
  }
  return new Promise<never>(() => {
    const exit = () => process.exit(0);
    if (output === "") exit();
    process.stdout.write(output + "\n", exit);
  });
}
