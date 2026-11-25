import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { runStructure } from "./support/run.ts";

/** Two Rust files whose only path back to each other is a `use` in a `#[cfg(test)]` module. */
let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Add a reader and the test helpers its unit tests use",
      date: "2024-01-01T00:00:00+00:00",
      changes: [
        { op: "add", path: "Cargo.toml", content: '[package]\nname = "app"\n' },
        { op: "add", path: "src/lib.rs", content: "pub mod reader;\npub mod scratch;\n" },
        { op: "add", path: "src/reader.rs", content: "pub fn read() -> u8 {\n    1\n}\n\n#[cfg(test)]\nmod tests {\n    use crate::scratch::temp_file;\n\n    #[test]\n    fn reads() {\n        temp_file();\n    }\n}\n" },
        { op: "add", path: "src/scratch.rs", content: "use crate::reader::read;\n\npub fn temp_file() -> u8 {\n    read()\n}\n" },
      ],
    },
  ]);
});
afterAll(() => repo.dispose());

test("cycles leaves out an edge made only by test code inside a production file", async () => {
  const run = await runStructure(repo.path, ["cycles", "--json", "--level", "file"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  expect(JSON.parse(run.stdout).results).toEqual([]);
});
