import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { GOLDEN_DIR, withoutMeta } from "./support/golden.ts";
import { distantHelpers } from "./support/scenarios.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(root, "plugins", "locality", "dist");
const source = join(root, "packages", "locality", "src", "main.ts");

let repo: GitFixture;
let installed: string;
beforeAll(() => {
  repo = distantHelpers();
  // The bundle as a user has it: copied out of the repository, with no node_modules to fall back on.
  installed = mkdtempSync(join(tmpdir(), "locality-install-"));
  cpSync(dist, installed, { recursive: true });
});
afterAll(() => {
  repo.dispose();
  rmSync(installed, { recursive: true, force: true });
});

const run = (entry: string, ...args: string[]) =>
  spawnSync(process.execPath, [entry, ...args], { cwd: repo.path, encoding: "utf8", env: { ...process.env, CI: "" } });

test("the committed bundle ships its grammars beside it", () => {
  expect(existsSync(join(dist, "locality.mjs"))).toBe(true);
  expect(existsSync(join(dist, "grammars"))).toBe(true);
});

for (const [label, entry] of [
  ["the source entry point", () => source],
  ["the committed bundle", () => join(dist, "locality.mjs")],
  ["the bundle copied outside the repository", () => join(installed, "locality.mjs")],
] as const) {
  test(`${label} prints the analysis matching the golden, with a piped stdout`, () => {
    rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
    const result = run(entry(), "analyse", "--limit", "all");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(ExitCode.Success);
    expect(withoutMeta(result.stdout)).toBe(readFileSync(join(GOLDEN_DIR, "distant-helpers", "analyse.json"), "utf8"));
  });

  test(`${label} exits with the usage code for an unknown command`, () => {
    const result = run(entry(), "nonsense");
    expect(result.status).toBe(ExitCode.Usage);
    expect(result.stderr).toContain("unknown command");
  });
}
