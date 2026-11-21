import { runCli } from "@code-health/cli-kit/run-cli";
import { cli } from "./cli.ts";

process.exitCode = await runCli(cli, {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});
