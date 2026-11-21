import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { runStructure } from "./support/run.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("the packages of this repository have no import cycles", async () => {
  const run = await runStructure(root, ["cycles", "--json", "--level", "file"]);
  expect(run.code).toBe(ExitCode.Success);
  const document = JSON.parse(run.stdout) as { results: { nodes: string[] }[] };
  const own = document.results.map((row) => row.nodes).filter((nodes) => nodes.some((node) => node.startsWith("packages/")));
  expect(own).toEqual([]);
}, 120_000);
