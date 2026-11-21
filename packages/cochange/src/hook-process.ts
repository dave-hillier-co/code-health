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

/**
 * Runs the hook as a process: stdin is the event, stdout is the answer, and
 * the exit code is 0 on every path. The process exits as soon as the answer
 * is written, so abandoned work cannot hold it open past the time budget.
 */
export async function runHookProcess(): Promise<never> {
  let output = "";
  try {
    output = await runHook({ stdin: await readStdin(DEFAULT_BUDGET_MS), cwd: process.cwd(), startedAt: 0 });
  } catch {
    // runHook does not throw; this keeps the exit code 0 even so.
  }
  return new Promise<never>(() => {
    const exit = () => process.exit(0);
    if (output === "") exit();
    process.stdout.write(output + "\n", exit);
  });
}
