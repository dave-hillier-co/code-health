import { expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { runStructure } from "./support/run.ts";

const help = async (command: string) => {
  const { code, stdout } = await runStructure(process.cwd(), [command, "--help"]);
  expect(code).toBe(ExitCode.Success);
  return stdout;
};

test("every option of a command is described, with the values it accepts", async () => {
  expect(await help("cycles")).toMatch(/--level <level>\s+what a node is: file, folder or package/);
  expect(await help("coupling")).toMatch(/--quadrant <quadrant>\s+only this quadrant: real, incidental, stable, hidden or independent/);
  expect(await help("coupling")).toMatch(/--by <by>\s+what a module is: file, folder or component/);
  expect(await help("check")).toMatch(/--base <base>\s+the revision to compare against/);
});

test("commands that take positional arguments show them in the usage line", async () => {
  expect(await help("evidence")).toContain("Usage: structure evidence <from>-><to> | <finding id> [options]");
  const outcome = await help("outcome");
  expect(outcome).toContain("Usage: structure outcome <from>-><to> [options]");
  expect(outcome).toMatch(/--at <at>\s+the revision that made the break/);
});
