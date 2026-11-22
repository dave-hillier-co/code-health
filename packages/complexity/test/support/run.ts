import { runInProcess, type Run } from "@code-health/fixtures/cli-testing";
import { cli } from "../../src/cli.ts";

export type { Run };

/** Runs the CLI in-process against a repository, as the bundle would from its working directory. */
export function runComplexity(cwd: string, argv: string[], isTTY = false): Promise<Run> {
  return runInProcess(cli, cwd, argv, isTTY);
}
