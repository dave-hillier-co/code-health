import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { runComplexity } from "./support/run.ts";

// A file type the suite has no profile for, written in the syntax of the profile it is mapped to.
const zig = "pub fn run(a: i32) -> i32 {\n  if (a > 1) {\n    if (a > 2) {\n      return a;\n    }\n  }\n  return 0;\n}\n";

let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Add a language the suite has no profile for",
      date: "2024-01-01T00:00:00+00:00",
      changes: [
        { op: "add", path: "tools/run.zig", content: zig },
        { op: "add", path: "code-health.json", content: JSON.stringify({ languages: { zig: "rust" } }) },
      ],
    },
  ]);
});
afterAll(() => repo.dispose());

async function json(args: string[]) {
  const run = await runComplexity(repo.path, [...args, "--json", "--limit", "all"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return JSON.parse(run.stdout);
}

describe("a file type mapped to a lexer profile in languages", () => {
  test("gets per-function values from that profile, each marked unverified", async () => {
    const { results } = await json(["analyse"]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ path: "tools/run.zig", unit: "run", source: "lexical", unverified: true, nesting: 2 });
  });

  test("marks the file unverified and names the profile, and no agreement travels with it", async () => {
    const document = await json(["files"]);
    expect(document.results[0]).toMatchObject({ path: "tools/run.zig", profile: "rust", source: "lexical", unverified: true, functions: 1 });
    const analysed = await json(["analyse"]);
    expect(analysed.agreement).toEqual({});
  });

  test("without the mapping no profile claims the file, so it is not code and `files` leaves it out and counts it", async () => {
    repo.apply([{ type: "commit", message: "Drop the mapping", date: "2024-01-02T00:00:00+00:00", changes: [{ op: "modify", path: "code-health.json", content: "{}" }] }]);
    const { results } = await json(["analyse"]);
    expect(results).toEqual([]);
    const files = await json(["files"]);
    expect(files.results).toEqual([]);
    expect(files.dropped).toEqual({ nonCode: 2 });
  });

  test("a profile that does not exist is a config error that names it", async () => {
    repo.apply([
      { type: "commit", message: "Map to nothing", date: "2024-01-03T00:00:00+00:00", changes: [{ op: "modify", path: "code-health.json", content: JSON.stringify({ languages: { zig: "nope" } }) }] },
    ]);
    const run = await runComplexity(repo.path, ["files", "--json"]);
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toMatch(/languages\.zig.*nope.*csharp/s);
  });
});
