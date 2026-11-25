import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { distantHelpers } from "../../packages/locality/test/support/scenarios.ts";
import { bundle, bundleChunks, grammarsPath } from "../bundle.mjs";

vi.setConfig({ testTimeout: 120_000 });

/**
 * Locality carries ts-morph, which is most of 14 MB. A command that moves or reviews a unit needs it, and
 * every other command, `--help` included, does not: so it is a chunk beside the bundle that is read only
 * when a command imports it, and the bundle itself stays the size of the other plugins'.
 */
let work: string;
let repo: GitFixture;
let main: string;
let compiler: string;
let mainText: string;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "locality-chunks-"));
  cpSync(grammarsPath(), join(work, "grammars"), { recursive: true });
  main = join(work, "locality.mjs");
  mainText = await bundle("locality");
  writeFileSync(main, mainText);
  const chunks = await bundleChunks("locality");
  for (const [name, text] of chunks) writeFileSync(join(work, name), text);
  compiler = [...chunks].sort(([, a], [, b]) => b.length - a.length)[0]![0];
  repo = distantHelpers();
});
afterAll(() => {
  repo.dispose();
  rmSync(work, { recursive: true, force: true });
});

const run = (...args: string[]) => spawnSync("node", [main, ...args, "--json"], { cwd: repo.path, encoding: "utf8" });

test("the bundle itself is small, and the compiler is in a chunk of its own", () => {
  expect(Buffer.byteLength(mainText)).toBeLessThan(1_000_000);
  expect(statSync(join(work, compiler)).size).toBeGreaterThan(5_000_000);
  expect(mainText).not.toContain("ts-morph");
  expect(readdirSync(work).filter((name) => /^chunk-.+\.mjs$/.test(name))).toContain(compiler);
});

test("a chunk is named for its content, so a rebuild writes the same files", async () => {
  expect(await bundleChunks("locality")).toEqual(await bundleChunks("locality"));
});

test("analyse never reads the compiler chunk: it runs with the chunk gone", () => {
  rmSync(join(work, compiler));
  try {
    expect(run("--help").status).toBe(0);
    const analysed = run("analyse", "--limit", "all");
    expect(analysed.stderr).toBe("");
    expect(analysed.status).toBe(0);
    expect(JSON.parse(analysed.stdout).results.length).toBeGreaterThan(0);
  } finally {
    writeFileSync(join(work, compiler), "");
  }
});
