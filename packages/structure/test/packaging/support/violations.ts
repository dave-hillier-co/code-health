import { GitFixture } from "@code-health/fixtures/git-fixture";
import { add, commit, modify, module } from "./scenarios.ts";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const manifest = (name: string, dependencies: string[] = []): string =>
  json({ name: `@chk/${name}`, private: true, main: "src/index.ts", dependencies: Object.fromEntries(dependencies.map((d) => [`@chk/${d}`, "*"])) });

/**
 * Three packages and two commits. At the base `c` already uses `a` without declaring it. The second commit
 * makes `b` import `a` (a cycle, declared), makes `a` import a file of `b` that is not its entry, and makes
 * `c` use `b` without declaring it, so three things are new and one is not.
 */
export function violationsRepository(): { fixture: GitFixture; base: string } {
  const fixture = GitFixture.build([
    commit("Add the packages", "2024-01-01T09:00:00Z", [
      add("package.json", json({ name: "chk", private: true, workspaces: ["packages/*"] })),
      add("packages/a/package.json", manifest("a", ["b"])),
      add("packages/a/src/index.ts", module("alpha", [["@chk/b", "beta"]])),
      add("packages/b/package.json", manifest("b")),
      add("packages/b/src/index.ts", module("beta", [])),
      add("packages/b/src/internal.ts", module("hidden", [])),
      add("packages/c/package.json", manifest("c")),
      add("packages/c/src/index.ts", module("gamma", [["@chk/a", "alpha"]])),
    ]),
  ]);
  const base = fixture.git("rev-parse", "HEAD");
  fixture.apply([
    commit("Add the violations", "2024-01-02T09:00:00Z", [
      modify("packages/b/package.json", manifest("b", ["a"])),
      modify("packages/b/src/index.ts", module("beta", [["@chk/a", "alpha"]])),
      modify("packages/a/src/index.ts", module("alpha", [["@chk/b", "beta"], ["@chk/b/src/internal.ts", "hidden"]])),
      modify("packages/c/src/index.ts", module("gamma", [["@chk/a", "alpha"], ["@chk/b", "beta"]])),
    ]),
  ]);
  return { fixture, base };
}
