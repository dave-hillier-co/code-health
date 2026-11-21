import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { runStructure } from "./support/run.ts";

let repo: GitFixture;
let parent: string;
let clone: string;
beforeAll(() => {
  repo = GitFixture.build(
    [1, 2, 3, 4].map((n) => ({
      type: "commit" as const,
      message: `Change ${n}`,
      date: `2024-0${n}-10T09:00:00+00:00`,
      changes: [
        { op: n === 1 ? ("add" as const) : ("modify" as const), path: "src/a/a.ts", content: `export const a = ${n};\n` },
        { op: n === 1 ? ("add" as const) : ("modify" as const), path: "src/b/b.ts", content: `import { a } from "../a/a.ts";\nexport const b = a + ${n};\n` },
      ],
    })),
  );
  parent = mkdtempSync(join(tmpdir(), "structure-window-"));
  clone = join(parent, "clone");
  execFileSync("git", ["clone", "--quiet", "--depth", "3", `file://${repo.path}`, clone], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
});
afterAll(() => {
  repo.dispose();
  rmSync(parent, { recursive: true, force: true });
});

describe.each(["coupling", "hidden", "stability"])("structure %s in a shallow clone", (command) => {
  test("refuses without a window, and the window the error asks for can be given", async () => {
    const refused = await runStructure(clone, [command, "--json"]);
    expect(refused.code).toBe(ExitCode.Environment);
    expect(JSON.parse(refused.stderr).error.code).toBe("shallow-clone");

    const stated = await runStructure(clone, [command, "--json", "--since", "2023-01-01"]);
    expect(stated.stderr).toBe("");
    expect(stated.code).toBe(ExitCode.Success);
    expect(JSON.parse(stated.stdout).evidence.truncated.shallow).toBe(true);
  });
});

describe("--since and --until on a structure history command", () => {
  test("cut the window: since included, until excluded, a bare until looking back the configured months", async () => {
    const run = await runStructure(repo.path, ["coupling", "--json", "--since", "2023-01-01", "--until", "2025-01-01"]);
    expect(run.code).toBe(ExitCode.Success);
    expect(JSON.parse(run.stdout).window).toEqual({ since: "2023-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" });

    const bare = await runStructure(repo.path, ["coupling", "--json", "--until", "2025-01-01"]);
    expect(JSON.parse(bare.stdout).window).toEqual({ since: "2024-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" });
  });

  test("a window that is not a date, or ends before it starts, is a usage error", async () => {
    expect((await runStructure(repo.path, ["coupling", "--since", "last week"])).code).toBe(ExitCode.Usage);
    expect((await runStructure(repo.path, ["coupling", "--since", "2024-03-01", "--until", "2024-01-01"])).code).toBe(ExitCode.Usage);
  });
});
