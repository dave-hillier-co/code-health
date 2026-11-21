import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { jvmCycleChanges, polyglotChanges } from "@code-health/fixtures/language-samples";
import { expectGolden } from "./support/golden.ts";
import { runStructure } from "./support/run.ts";

const commit = (changes: ReturnType<typeof polyglotChanges>) => GitFixture.build([{ type: "commit", message: "Add the code", date: "2024-01-01T00:00:00+00:00", changes }]);

let polyglot: GitFixture;
let jvm: GitFixture;
beforeAll(() => {
  polyglot = commit(polyglotChanges());
  jvm = commit(jvmCycleChanges());
});
afterAll(() => {
  polyglot.dispose();
  jvm.dispose();
});

async function run(repo: GitFixture, command: string) {
  const result = await runStructure(repo.path, [command, "--json", "--limit", "all"]);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(ExitCode.Success);
  return result.stdout;
}

test("the census of a repository with every supported language matches its golden", async () => {
  expectGolden("polyglot", "census", await run(polyglot, "census"));
});

test("a Java class and a Kotlin class that use each other are one cycle, because the two languages share one graph", async () => {
  const stdout = await run(jvm, "cycles");
  expectGolden("jvm-mixed", "cycles", stdout);
  const cycles = JSON.parse(stdout).results as { nodes: string[] }[];
  expect(cycles.map((cycle) => cycle.nodes)).toEqual([["src/main/java/acme/Order.java", "src/main/kotlin/acme/Pricing.kt"]]);
});
