import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { runLocality } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Add a module",
      date: "2024-01-01T00:00:00Z",
      changes: [{ op: "add", path: "src/answer.ts", content: "export const answer = 42;\n" }],
    },
  ]);
});
afterAll(() => repo.dispose());

test("parse reports in the suite's envelope", async () => {
  const { code, stdout, stderr } = await runLocality(repo.path, ["parse", "src/answer.ts"]);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 1, tool: "locality", command: "parse" });
});
