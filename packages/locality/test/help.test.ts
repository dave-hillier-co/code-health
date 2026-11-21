import { expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { runLocality } from "./support/run.ts";

const help = async (...command: string[]) => {
  const { code, stdout } = await runLocality(process.cwd(), [...command, "--help"]);
  expect(code).toBe(ExitCode.Success);
  return stdout;
};

test("analyse shows its path arguments and the values its options accept", async () => {
  const text = await help("analyse");
  expect(text).toContain("Usage: locality analyse [<path>...] [options]");
  expect(text).toMatch(/--recommendation <recommendation>\s+only units with this recommendation: inline, move, split/);
  expect(text).toMatch(/--source <source>\s+where candidates come from: structural/);
});

test("history and measure name their subcommands", async () => {
  expect(await help("history")).toContain("Usage: locality history refresh [options]");
  const measure = await help("measure");
  expect(measure).toContain("Usage: locality measure baseline | compare | premise [options]");
  expect(measure).toMatch(/--since <since>\s+baseline and compare: start the after window/);
});
