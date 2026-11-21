import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectGoldenIn, withoutMeta } from "@code-health/fixtures/cli-testing";

export { withoutMeta };

export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "golden");

/** Compares a command's JSON output with `golden/<scenario>/<name>.json`; see `expectGoldenIn`. */
export function expectGolden(scenario: string, name: string, stdout: string): void {
  expectGoldenIn(GOLDEN_DIR, scenario, name, stdout);
}
