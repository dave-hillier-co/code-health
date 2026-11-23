import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { runLocality } from "./support/run.ts";

const add = (path: string, content: string): Change => ({ op: "add", path, content });

/**
 * An unexported Go name is reached only from its own package, so a file that declares one used by its siblings does not leave them,
 * and a file does not leave siblings whose unexported names it uses.
 *
 * - lib/store/proxy/rev.go declares the unexported newRev, which lib/store/proxy/a.go and lib/store/proxy/b.go call, and uses lib/store/sub, so it is
 *   pulled towards lib/store although its consumers are beside it.
 * - lib/store/proxy/free.go uses only lib/store/sub and exported names, so it can move.
 * - tools/one/one.go (package one) and tools/two/two.go (package two) are each used by tools/a and tools/b, so both are pulled towards
 *   tools, which has no Go file.
 */
let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Add the app",
      date: "2024-01-01T09:00:00Z",
      changes: [
        add("code-health.json", JSON.stringify({ entryPoints: ["cmd/app/main.go"], locality: { useHistory: false } })),
        add("go.mod", "module example.com/m\n\ngo 1.22\n"),
        add(
          "cmd/app/main.go",
          'package main\n\nimport (\n\t"example.com/m/lib/store/proxy"\n\t"example.com/m/lib/store/sub"\n\t"example.com/m/tools/a"\n\t"example.com/m/tools/b"\n)\n\nfunc main() {\n\t_ = proxy.A() + proxy.B() + proxy.User() + proxy.Free() + sub.Get() + a.A() + b.B()\n}\n',
        ),
        add("lib/store/sub/sub.go", "package sub\n\nfunc Get() int {\n\treturn 1\n}\n\nfunc Put() int {\n\treturn 2\n}\n"),
        add("lib/store/proxy/rev.go", 'package proxy\n\nimport "example.com/m/lib/store/sub"\n\nfunc newRev() int {\n\treturn sub.Get() + sub.Put()\n}\n'),
        add("lib/store/proxy/a.go", "package proxy\n\nfunc A() int {\n\treturn newRev()\n}\n"),
        add("lib/store/proxy/b.go", "package proxy\n\nfunc B() int {\n\treturn newRev()\n}\n"),
        add("lib/store/proxy/user.go", 'package proxy\n\nimport "example.com/m/lib/store/sub"\n\nfunc User() int {\n\treturn sub.Get() + sub.Put()\n}\n'),
        add("lib/store/proxy/free.go", 'package proxy\n\nimport "example.com/m/lib/store/sub"\n\nfunc Free() int {\n\treturn sub.Get() + sub.Put()\n}\n'),
        add("tools/one/one.go", "package one\n\nfunc One() int {\n\treturn 1\n}\n"),
        add("tools/two/two.go", "package two\n\nfunc Two() int {\n\treturn 2\n}\n"),
        add("tools/a/a.go", 'package a\n\nimport (\n\t"example.com/m/tools/one"\n\t"example.com/m/tools/two"\n)\n\nfunc A() int {\n\treturn one.One() + two.Two()\n}\n'),
        add("tools/b/b.go", 'package b\n\nimport (\n\t"example.com/m/tools/one"\n\t"example.com/m/tools/two"\n)\n\nfunc B() int {\n\treturn one.One() + two.Two()\n}\n'),
      ],
    },
  ]);
});
afterAll(() => repo.dispose());

interface Move {
  refusals: { code: string; detail: string }[];
  results: { from: string; to: string }[];
}

async function plan(unit: string, to: string): Promise<Move> {
  const run = await runLocality(repo.path, ["move", "--json", unit, "--to", to, "--reason", "test"]);
  return JSON.parse(run.stdout || run.stderr) as Move;
}

test("a Go file whose unexported name is used by its siblings is not moved away from them", async () => {
  const move = await plan("lib/store/proxy/rev.go", "lib/store");
  expect(move.refusals).toEqual([{ code: "unexported-use", detail: "unexported symbol used in its package: newRev used by lib/store/proxy/a.go" }]);
});

test("a Go file that shares no unexported name with its siblings still moves", async () => {
  const move = await plan("lib/store/proxy/free.go", "lib/store");
  expect(move.refusals).toEqual([]);
  expect(move.results).toEqual([{ from: "lib/store/proxy/free.go", to: "lib/store/free.go", role: "unit" }]);
});

test("the analysis proposes no target that leaves an unexported name behind", async () => {
  const run = await runLocality(repo.path, ["analyse", "--json", "--limit", "all"]);
  const rows = JSON.parse(run.stdout).results as { path: string; target: string; recommendation: string }[];
  const proposed = rows.filter((row) => row.recommendation === "move").map((row) => `${row.path} -> ${row.target}`);
  expect(proposed).not.toContain("lib/store/proxy/rev.go -> lib/store");
});

test("a Go file moved into a folder with no Go file keeps its package name, so a second package cannot join it", async () => {
  expect((await plan("tools/one/one.go", "tools")).refusals).toEqual([]);
  expect((await plan("tools/two/two.go", "tools")).refusals).toEqual([]);
});

test("the report lists one move into a folder with no Go file and counts the other as left out", async () => {
  const run = await runLocality(repo.path, ["report", "locality", "--slots"]);
  expect(run.code).toBe(0);
  const text = run.stdout;
  const planned = (JSON.parse(text).slots as { about: { ref: string } }[]).map((slot) => slot.about.ref);
  expect(planned).toContain("tools/one/one.go");
  expect(planned).not.toContain("tools/two/two.go");
  expect(text).toContain("another proposed move lands in the same empty folder");
  expect(text).not.toContain("also lands there");
});
