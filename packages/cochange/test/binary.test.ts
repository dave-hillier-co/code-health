import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { GOLDEN_DIR, withoutMeta } from "./support/golden.ts";
import { steadyHistory } from "./support/scenarios.ts";

// A cold node and the grammars' wasm can take long on a loaded machine, and these suites run beside every other.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const bundle = join(root, "plugins", "cochange", "dist", "cochange.mjs");
const source = join(root, "packages", "cochange", "src", "main.ts");

/** The two real entry points: the TypeScript source under Node's own type stripping, and the committed bundle. */
const binaries: [string, string[]][] = [
  ["the source entry point", [source]],
  ["the committed bundle", [bundle]],
];

let repo: GitFixture;
beforeAll(() => {
  repo = steadyHistory();
});
afterAll(() => repo?.dispose());

const run = (entry: string[], ...args: string[]) =>
  spawnSync(process.execPath, [...entry, ...args], { cwd: repo.path, encoding: "utf8", env: { ...process.env, CI: "" } });
const golden = (name: string) => readFileSync(join(GOLDEN_DIR, "steady", `${name}.json`), "utf8");

test("the committed bundle exists", () => {
  expect(existsSync(bundle)).toBe(true);
});

for (const [label, entry] of binaries) {
  test(`${label} runs in a child process and prints output matching the goldens, with a piped stdout`, () => {
    rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
    for (const command of ["age", "hotspots", "coupling"]) {
      const result = run(entry, command);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(ExitCode.Success);
      // Piped, so not a terminal: JSON without being asked.
      expect(withoutMeta(result.stdout)).toBe(golden(command));
    }
  });

  test(`${label} exits with the usage code and a message on stderr for an unknown command`, () => {
    const result = run(entry, "nonsense");
    expect(result.status).toBe(ExitCode.Usage);
    expect(result.stderr).toContain("unknown command");
    expect(result.stdout).toBe("");
  });

  test(`${label} does not truncate a large output when the process exits`, () => {
    const result = run(entry, "coupling", "--min-support", "1", "--min-degree", "0", "--limit", "all");
    expect(result.status).toBe(ExitCode.Success);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
}
