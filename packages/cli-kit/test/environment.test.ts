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
