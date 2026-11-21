import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { distantHelpers } from "../../packages/locality/test/support/scenarios.ts";
import { manifestsRepository } from "../../packages/structure/test/packaging/support/scenarios.ts";
import { cyclesRepository } from "../../packages/structure/test/support/scenarios.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The committed bundles, installed as a plugin is: a copy with no node_modules beside it. A module that the
 * bundle left out, or a grammar or ts-morph that fails to load, breaks here and not in the source tests.
 */
let installed: string;
const fixtures: GitFixture[] = [];
beforeAll(() => {
  installed = mkdtempSync(join(tmpdir(), "dist-smoke-"));
  for (const plugin of ["cochange", "complexity", "locality", "structure"]) cpSync(join(root, "plugins", plugin, "dist"), join(installed, plugin, "dist"), { recursive: true });
});
afterAll(() => {
  rmSync(installed, { recursive: true, force: true });
  for (const fixture of fixtures) fixture.dispose();
});

function run(plugin: string, cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [join(installed, plugin, "dist", `${plugin}.mjs`), ...args, "--json"], { cwd, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, document: result.stdout === "" ? undefined : JSON.parse(result.stdout) };
}

const fixture = (make: () => GitFixture): GitFixture => {
  const made = make();
  fixtures.push(made);
  return made;
};

describe("every plugin's installed bundle runs its newest commands", () => {
  test("cochange: blame refresh and risk explain", () => {
    const repo = fixture(distantHelpers);
    expect(run("cochange", repo.path, ["blame", "refresh"])).toMatchObject({ status: 0, stderr: "", document: { command: "blame" } });
    expect(run("cochange", repo.path, ["risk", "explain"])).toMatchObject({ status: 0, document: { command: "risk" } });
  });

  test("locality: a move dry run, which loads ts-morph from the bundle", () => {
    const repo = fixture(distantHelpers);
    const { status, document } = run("locality", repo.path, ["move", "src/shared/utils/money.ts"]);
    expect(status).toBe(0);
    expect(document).toMatchObject({ command: "move", applied: false, mode: "dry-run" });
  });

  test("structure: the census and the package list", () => {
    expect(run("structure", fixture(cyclesRepository).path, ["census"])).toMatchObject({ status: 0, document: { command: "census" } });
    expect(run("structure", fixture(manifestsRepository).path, ["packages", "list"])).toMatchObject({ status: 0, document: { command: "packages" } });
  });

  test("complexity: analyse, which loads the grammars from the bundle's folder", () => {
    expect(run("complexity", fixture(distantHelpers).path, ["analyse"])).toMatchObject({ status: 0, stderr: "", document: { command: "analyse" } });
  });
});
