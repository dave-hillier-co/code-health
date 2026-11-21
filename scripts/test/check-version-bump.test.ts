import { afterEach, expect, test } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { checkVersionBump } from "../check-version-bump.mjs";

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});

const manifest = (version: string) => JSON.stringify({ name: "p", version }) + "\n";
const marketplace = (entry: object = {}) => JSON.stringify({ name: "m", plugins: [{ name: "p", source: "./plugins/p", ...entry }] }) + "\n";

let clock = 0;
const date = () => new Date(Date.UTC(2024, 0, 1, 0, 0, clock++)).toISOString();

/** main holds a plugin at 1.0.0; the work branch starts from there. */
function repo(): GitFixture {
  const fixture = GitFixture.build([
    {
      type: "commit",
      message: "base",
      date: date(),
      changes: [
        { op: "add", path: "plugins/p/.claude-plugin/plugin.json", content: manifest("1.0.0") },
        { op: "add", path: "plugins/p/dist/p.mjs", content: "v1\n" },
        { op: "add", path: ".claude-plugin/marketplace.json", content: marketplace() },
        { op: "add", path: "packages/p/a.ts", content: "a\n" },
      ],
    },
    { type: "branch", name: "work" },
  ]);
  fixtures.push(fixture);
  return fixture;
}

const edit = (fixture: GitFixture, path: string, content: string) =>
  fixture.commit({ message: `edit ${path}`, date: date(), changes: [{ op: "modify", path, content }] });

const check = (fixture: GitFixture) => checkVersionBump({ root: fixture.path, base: "main" });

test("a change under the plugin without a bump fails, naming the plugin", () => {
  const f = repo();
  edit(f, "plugins/p/dist/p.mjs", "v2\n");
  const { problems, skipped } = check(f);
  expect(skipped).toBeNull();
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("plugins/p changed");
  expect(problems[0]).toContain("still 1.0.0");
});

test("the same change with a bumped version passes", () => {
  const f = repo();
  edit(f, "plugins/p/dist/p.mjs", "v2\n");
  edit(f, "plugins/p/.claude-plugin/plugin.json", manifest("1.0.1"));
  expect(check(f).problems).toEqual([]);
});

test("a bump may come in an earlier commit than the change", () => {
  const f = repo();
  edit(f, "plugins/p/.claude-plugin/plugin.json", manifest("1.1.0"));
  edit(f, "plugins/p/dist/p.mjs", "v2\n");
  expect(check(f).problems).toEqual([]);
});

test("lowering the version, or leaving it unchanged while editing plugin.json, fails", () => {
  const f = repo();
  edit(f, "plugins/p/.claude-plugin/plugin.json", manifest("0.9.0"));
  expect(check(f).problems[0]).toContain("(was 1.0.0)");

  const g = repo();
  edit(g, "plugins/p/.claude-plugin/plugin.json", JSON.stringify({ name: "p", version: "1.0.0", extra: 1 }) + "\n");
  expect(check(g).problems).toHaveLength(1);
});

test("a version that is not major.minor.patch fails", () => {
  const f = repo();
  edit(f, "plugins/p/.claude-plugin/plugin.json", manifest("next"));
  expect(check(f).problems[0]).toContain("not major.minor.patch");
});

test("changes outside plugins/ need no bump", () => {
  const f = repo();
  edit(f, "packages/p/a.ts", "b\n");
  expect(check(f).problems).toEqual([]);
});

test("a plugin that is new on the branch needs no bump", () => {
  const f = repo();
  f.commit({
    message: "new plugin",
    date: date(),
    changes: [
      { op: "add", path: "plugins/q/.claude-plugin/plugin.json", content: manifest("0.1.0") },
      { op: "add", path: "plugins/q/dist/q.mjs", content: "q\n" },
    ],
  });
  expect(check(f).problems).toEqual([]);
});

test("the comparison is with the merge base, not the tip of the base branch", () => {
  const f = repo();
  edit(f, "packages/p/a.ts", "work\n");
  f.git("checkout", "--quiet", "main");
  edit(f, "plugins/p/dist/p.mjs", "v2 on main\n");
  edit(f, "plugins/p/.claude-plugin/plugin.json", manifest("1.0.1"));
  f.git("checkout", "--quiet", "work");
  expect(check(f).problems).toEqual([]);
});

test("without a usable base the check is skipped, not failed", () => {
  const f = repo();
  edit(f, "plugins/p/dist/p.mjs", "v2\n");
  expect(checkVersionBump({ root: f.path, base: undefined }).skipped).toMatch(/no base/);
  expect(checkVersionBump({ root: f.path, base: "0".repeat(40) }).skipped).toMatch(/no base/);
  expect(checkVersionBump({ root: f.path, base: "no-such-ref" }).skipped).toMatch(/no merge base/);
});

test("a marketplace entry that sets a version fails, even without a base", () => {
  const f = repo();
  edit(f, ".claude-plugin/marketplace.json", marketplace({ version: "1.0.0" }));
  const { problems } = checkVersionBump({ root: f.path, base: undefined });
  expect(problems).toEqual(['marketplace entry "p" sets a version; set it in plugin.json only']);
});
