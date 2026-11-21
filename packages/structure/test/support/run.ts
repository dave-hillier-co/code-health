import { runInProcess, type Run } from "@code-health/fixtures/cli-testing";
import { cli } from "../../src/cli.ts";

export type { Run };

/** Runs the CLI in-process against a repository, as the bundle would from its working directory. */
export function runStructure(cwd: string, argv: string[]): Promise<Run> {
  return runInProcess(cli, cwd, argv);
}
