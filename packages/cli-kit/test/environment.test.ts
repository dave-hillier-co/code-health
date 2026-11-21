import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { CliError, ExitCode } from "../src/errors.ts";
import { assertNodeVersion } from "../src/environment.ts";

test("accepts Node at or above 22.13", () => {
  expect(() => assertNodeVersion("22.13.0")).not.toThrow();
  expect(() => assertNodeVersion("22.21.1")).not.toThrow();
  expect(() => assertNodeVersion("24.0.0")).not.toThrow();
});

test("rejects older Node with an environment error", () => {
  for (const version of ["22.12.9", "20.19.0", "18.0.0"]) {
    try {
      assertNodeVersion(version);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(ExitCode.Environment);
      expect((error as CliError).message).toContain(version);
    }
  }
});

test("importing node:sqlite prints no experimental warning once suppressed", () => {
  const script = `
    import { suppressSqliteWarning } from ${JSON.stringify(new URL("../src/environment.ts", import.meta.url).href)};
    suppressSqliteWarning();
    await import("node:sqlite");
  `;
  const stderr = runScript(script);
  expect(stderr).not.toMatch(/ExperimentalWarning|SQLite/);
});

test("without suppression node prints the warning (guards the test above)", () => {
  const stderr = runScript(`await import("node:sqlite");`);
  if (!/SQLite/.test(stderr)) return; // newer Node releases no longer warn
  expect(stderr).toMatch(/ExperimentalWarning/);
});

test("other warnings still get through", () => {
  const script = `
    import { suppressSqliteWarning } from ${JSON.stringify(new URL("../src/environment.ts", import.meta.url).href)};
    suppressSqliteWarning();
    process.emitWarning("something else", "ExperimentalWarning");
  `;
  expect(runScript(script)).toContain("something else");
});

function runScript(source: string): string {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
  return result.stderr;
}
