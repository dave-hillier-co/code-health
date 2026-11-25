import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { runLocality } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Add a file the grammar cannot read",
      date: "2024-01-01T00:00:00+00:00",
      changes: [
        { op: "add", path: "src/main.rs", content: "mod broken;\n\nfn main() {\n    broken::fine();\n}\n" },
        { op: "add", path: "src/broken.rs", content: "pub fn fine() {}\n\nfn broken() {\n    let x = 1 @ 2;\n}\n" },
      ],
    },
  ]);
});
afterAll(() => repo.dispose());

test("analyse lists each file with syntax errors with the line, column and text of its first error", async () => {
  const run = await runLocality(repo.path, ["analyse", "--json", "--limit", "all"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  expect(JSON.parse(run.stdout).filesWithSyntaxErrors).toEqual([{ path: "src/broken.rs", line: 4, column: 15, kind: "unexpected", text: "@ 2" }]);
});
