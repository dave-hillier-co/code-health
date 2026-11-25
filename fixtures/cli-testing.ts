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

/** What a stored output carries in place of the effective-config hash, so a config default changing does not churn every golden. */
export const GOLDEN_CONFIG_HASH = "0000000000000000";

/** The output with only `meta` removed, serialised byte for byte: the form a stored report takes, hash included. */
export function withoutMetaOnly(stdout: string): string {
  const { meta: _meta, ...document } = JSON.parse(stdout);
  return serialise(document);
}

/**
 * The output as it is stored: `meta` (timings, timestamps, versions) removed, the effective-config hash
 * masked and the note of which inputs came from the results cache (`inputs.resultsCache`) removed, then
 * serialised byte for byte. The note says how this run got its answer, never what the answer is, so a cold run
 * and a warm one compare equal. How the hash is computed is pinned once, in the cli-kit config tests.
 */
export function withoutMeta(stdout: string): string {
  const { meta: _meta, ...document } = JSON.parse(stdout);
  if (document.inputs !== null && typeof document.inputs === "object") {
    const { resultsCache: _resultsCache, ...inputs } = document.inputs;
    document.inputs = inputs;
  }
  return serialise("config" in document ? { ...document, config: GOLDEN_CONFIG_HASH } : document);
}

/**
 * Compares a command's JSON output with `<goldenDir>/<scenario>/<name>.json`,
 * byte for byte, ignoring `meta`. Set UPDATE_GOLDEN=1 to write the file instead,
 * then review the diff: an intentional output change updates its golden in the
 * same commit.
 *
 * `name` is `<command>` or `<command>.<variant>`. The part before the first dot
 * names the schema in `plugins/code-health/schemas/<tool>/<command>.schema.json`, which
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
