import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { GOLDEN_DIR, withoutMeta } from "./support/golden.ts";
import { cyclesRepository } from "./support/scenarios.ts";

// A cold node and the grammars' wasm can take long on a loaded machine, and these suites run beside every other.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let repo: GitFixture;
let installed: string;
beforeAll(() => {
  repo = cyclesRepository();
  // As Claude Code installs a plugin: a copy of dist with no node_modules anywhere above it.
  installed = mkdtempSync(join(tmpdir(), "structure-installed-"));
  cpSync(join(root, "plugins", "structure", "dist"), join(installed, "dist"), { recursive: true });
});
afterAll(() => {
  // beforeAll may have failed before either exists, so each is released only if it was made.
  repo?.dispose();
  if (installed !== undefined) rmSync(installed, { recursive: true, force: true });
});

const run = (...args: string[]) =>
  spawnSync(process.execPath, [join(installed, "dist", "structure.mjs"), ...args], {
    cwd: repo.path,
    encoding: "utf8",
    env: { ...process.env, CI: "" },
  });

test("the installed bundle loads its grammars from beside it and prints output matching the golden", () => {
  const result = run("cycles", "--level", "folder");
  expect(result.stderr).toBe("");
  expect(result.status).toBe(ExitCode.Success);
  expect(withoutMeta(result.stdout)).toBe(readFileSync(join(GOLDEN_DIR, "cycles", "cycles.folder.json"), "utf8"));
});

test("the installed bundle explains its rules", () => {
  const result = run("explain", "import-cycle");
  expect(result.status).toBe(ExitCode.Success);
  expect(result.stdout).toContain("breaking set");
});
