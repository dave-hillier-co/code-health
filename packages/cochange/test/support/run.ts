import { runCli, type CliDefinition } from "@code-health/cli-kit/run-cli";
import { cli as realCli } from "../../src/cli.ts";

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in-process against a repository, as the bundle would from its working directory. */
export async function runCochange(cwd: string, argv: string[], cli: CliDefinition = realCli): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(cli, {
    argv,
    cwd,
    stdout: { write: (text) => (stdout += text), isTTY: false },
    stderr: { write: (text) => (stderr += text) },
  });
  return { code, stdout, stderr };
}
