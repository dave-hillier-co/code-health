import type { CliDefinition } from "@code-health/cli-kit/run-cli";
import { runInProcess, type Run } from "@code-health/fixtures/cli-testing";
import { cli as realCli } from "../../src/cli.ts";

export type { Run };

/** Runs the CLI in-process against a repository, as the bundle would from its working directory. */
export function runCochange(cwd: string, argv: string[], cli: CliDefinition = realCli): Promise<Run> {
  return runInProcess(cli, cwd, argv, false);
}

/** As `runCochange`, but stdout is a terminal, so the default output is the human readable table. */
export function runCochangeOnTerminal(cwd: string, argv: string[], cli: CliDefinition = realCli): Promise<Run> {
  return runInProcess(cli, cwd, argv, true);
}
