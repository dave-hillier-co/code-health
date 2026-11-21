import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { runCli, type CliDefinition } from "@code-health/cli-kit/run-cli";
import { serialise } from "@code-health/cli-kit/serialise";

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a CLI in-process against a directory, as its bundle would from that
 * working directory. With `isTTY` stdout is a terminal, so the default output is
 * the human readable table instead of JSON.
 */
export async function runInProcess(cli: CliDefinition, cwd: string, argv: string[], isTTY = false): Promise<Run> {
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

/** The output as it is stored: `meta` (timings, timestamps, versions) removed, then serialised byte for byte. */
export function withoutMeta(stdout: string): string {
  const { meta: _meta, ...document } = JSON.parse(stdout);
  return serialise(document);
}

/**
 * Compares a command's JSON output with `<goldenDir>/<scenario>/<name>.json`,
 * byte for byte, ignoring `meta`. Set UPDATE_GOLDEN=1 to write the file instead,
 * then review the diff: an intentional output change updates its golden in the
 * same commit.
 *
 * `name` is `<command>` or `<command>.<variant>`. The part before the first dot
 * names the schema in `plugins/<plugin>/schemas/<command>.schema.json`, which
 * `npm run check:schemas` validates the file against. A scenario directory that
 * starts with an underscore is exempt from that check.
 */
export function expectGoldenIn(goldenDir: string, scenario: string, name: string, stdout: string): void {
  const file = join(goldenDir, scenario, `${name}.json`);
  const actual = withoutMeta(stdout);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  if (!existsSync(file)) {
    throw new Error(`missing golden ${file}; run with UPDATE_GOLDEN=1 to create it, then review it`);
  }
  expect(actual).toBe(readFileSync(file, "utf8"));
}
