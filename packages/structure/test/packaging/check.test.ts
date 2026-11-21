import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "../support/golden.ts";
import { runStructure } from "../support/run.ts";
import { violationsRepository } from "./support/violations.ts";

let repo: GitFixture;
let base: string;
beforeAll(() => {
  ({ fixture: repo, base } = violationsRepository());
});
afterAll(() => repo.dispose());

const check = (...args: string[]) => runStructure(repo.path, ["packages", "check", ...args, "--json"]);

describe("against a base revision", () => {
  test("exits 1 on a cycle, a deep import and an undeclared dependency that are new", async () => {
    const run = await check("--base", base);
    expect(run.code).toBe(ExitCode.CheckFailed);
    const document = JSON.parse(run.stdout) as { results: { kind: string; key: string; packages: string[]; detail: string }[]; summary: Record<string, unknown> };
    expect(document.results.map((v) => v.key)).toEqual([
      "cycle:packages/a,packages/b",
      "deep:packages/a->packages/b/src/internal.ts",
      "undeclared:packages/c:@chk/b",
    ]);
    expect(document.results.map((v) => v.kind)).toEqual(["package-cycle", "deep-import", "undeclared-dependency"]);
    expect(document.results[1]!.detail).toBe("packages/a imports packages/b/src/internal.ts, past the entry points of packages/b");
  });

  test("a violation that was already there at the base is not new", async () => {
    // c used a without declaring it before the second commit as well
    const run = await check("--base", base);
    const document = JSON.parse(run.stdout) as { results: { key: string }[]; summary: { added: number; existing: number } };
    expect(document.results.map((v) => v.key)).not.toContain("undeclared:packages/c:@chk/a");
    expect(document.summary).toMatchObject({ added: 3, existing: 1 });
  });

  test("against the head itself nothing is new, and it exits 0", async () => {
    const run = await check("--base", "HEAD");
    expect(run.code).toBe(ExitCode.Success);
    expect(JSON.parse(run.stdout)).toMatchObject({ results: [], summary: { added: 0, existing: 4 } });
  });

  test("a base that is not a revision is a usage error", async () => {
    const run = await check("--base", "nowhere");
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toContain("is not a revision");
  });

  test("with no base and no main branch to compare with, it says to pass one", async () => {
    const run = await check();
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toContain("pass --base");
  });
});

test("golden", async () => {
  expectGolden("violations", "packages.check", (await check("--base", base)).stdout);
});
