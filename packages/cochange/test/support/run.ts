import { runCli, type CliDefinition } from "@code-health/cli-kit/run-cli";
import { cli as realCli } from "../../src/cli.ts";

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in-process against a repository, as the bundle would from its working directory. */
export async function runCochange(cwd: string, argv: string[], cli: CliDefinition = realCli): Promise<Run> {
  return runWithTerminal(cwd, argv, false, cli);
}

/** As `runCochange`, but stdout is a terminal, so the default output is the human readable table. */
export async function runCochangeOnTerminal(cwd: string, argv: string[], cli: CliDefinition = realCli): Promise<Run> {
  return runWithTerminal(cwd, argv, true, cli);
}

async function runWithTerminal(cwd: string, argv: string[], isTTY: boolean, cli: CliDefinition): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(cli, {
    argv,
    cwd,
    stdout: { write: (text) => (stdout += text), isTTY },
    stderr: { write: (text) => (stderr += text) },
  });
  return { code, stdout, stderr };
}
