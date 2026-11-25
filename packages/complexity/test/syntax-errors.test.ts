import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { runComplexity } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Add a file the grammar cannot read and one it can only read repaired",
      date: "2024-01-01T00:00:00+00:00",
      changes: [
        { op: "add", path: "src/broken.rs", content: "pub fn fine() {}\n\nfn broken() {\n    let x = 1 @ 2;\n}\n" },
        { op: "add", path: "src/raw.rs", content: "pub fn split(raw: &str) -> usize {\n    count(&raw)\n}\n" },
      ],
    },
  ]);
});
afterAll(() => repo.dispose());

test("analyse lists each file with syntax errors with the line, column and text of its first error", async () => {
  const run = await runComplexity(repo.path, ["analyse", "--json", "--limit", "all"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  const document = JSON.parse(run.stdout);
  expect(document.filesWithSyntaxErrors).toEqual([{ path: "src/broken.rs", line: 4, column: 15, kind: "unexpected", text: "@ 2" }]);
  expect(document.parseCoverage).toMatchObject({ parsedFiles: 2, filesWithSyntaxErrors: 1 });
});
