import { runCli } from "@code-health/cli-kit/run-cli";
import { cli } from "./cli.ts";
import { inHookWorker, runHookProcess, runHookWorker } from "@code-health/history/hook-process";
import { cochangeHook } from "./hook-definition.ts";

const argv = process.argv.slice(2);

if (inHookWorker(cochangeHook.kind)) {
  // The hook's process starts this same file on a worker thread so that its budget can be enforced.
  await runHookWorker(cochangeHook);
} else {
  // The hook is not a command of the CLI: it reads an event on stdin, skips the repository
  // state and config checks every command makes, and exits 0 whatever happens.
  if (argv[0] === "hook") await runHookProcess(cochangeHook);

  process.exitCode = await runCli(cli, {
    argv,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
