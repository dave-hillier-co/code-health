import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { runStructure } from "../../support/run.ts";

export interface PackagesDocument {
  command: string;
  inputs: Record<string, unknown>;
  results: any[];
  [key: string]: any;
}

/** Runs `structure packages <args> --json` and returns the raw output and the parsed document. */
export async function packages(fixture: GitFixture, ...args: string[]): Promise<{ stdout: string; document: PackagesDocument }> {
  const run = await runStructure(fixture.path, ["packages", ...args, "--json", "--limit", "all"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return { stdout: run.stdout, document: JSON.parse(run.stdout) as PackagesDocument };
}

/** Runs `structure packages <args>` and returns the exit code and streams, for the cases that fail. */
export function packagesRun(fixture: GitFixture, ...args: string[]) {
  return runStructure(fixture.path, ["packages", ...args, "--json", "--limit", "all"]);
}

/**
 * Runs `body` with the `structure.packages` settings of the fixture's code-health.json merged with `settings`,
 * and puts the file back afterwards.
 */
export async function withPackageSettings<T>(fixture: GitFixture, settings: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const file = join(fixture.path, "code-health.json");
  const original = readFileSync(file, "utf8");
  const document = JSON.parse(original) as { structure?: { packages?: Record<string, unknown> } };
  document.structure = { ...document.structure, packages: { ...document.structure?.packages, ...settings } };
  writeFileSync(file, JSON.stringify(document));
  try {
    return await body();
  } finally {
    writeFileSync(file, original);
  }
}
