import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { runLocality } from "./support/run.ts";

const add = (path: string, content: string): Change => ({ op: "add", path, content });

/**
 * A Go folder is a package, so a move that makes a package import itself, makes two packages import each other, or
 * puts a library file into a `package main` folder does not compile. The planner refuses these and the analysis
 * does not propose them as targets.
 *
 * - lib/feature/feat.go imports lib/base, so it cannot move into lib/base.
 * - lib/p/f.go is used by lib/p/a.go, and lib/q/q.go uses lib/p/a.go: moving f.go to lib/q makes p and q import each other.
 * - lib/helper/help.go is used only by cmd/app/main.go, a package main folder.
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
          'package main\n\nimport (\n\t"example.com/m/lib/base"\n\t"example.com/m/lib/feature"\n\t"example.com/m/lib/helper"\n\t"example.com/m/lib/p"\n\t"example.com/m/lib/q"\n)\n\nfunc main() {\n\t_ = base.Base() + feature.Feat() + helper.Help() + p.A() + q.Q()\n}\n',
        ),
        add("lib/base/base.go", "package base\n\nfunc Base() int {\n\treturn 1\n}\n"),
        add("lib/feature/feat.go", 'package feature\n\nimport "example.com/m/lib/base"\n\nfunc Feat() int {\n\treturn base.Base()\n}\n'),
        add("lib/helper/help.go", "package helper\n\nfunc Help() int {\n\treturn 2\n}\n"),
        add("lib/p/a.go", "package p\n\nfunc A() int {\n\treturn F()\n}\n"),
        add("lib/p/f.go", "package p\n\nfunc F() int {\n\treturn 3\n}\n"),
        add("lib/q/q.go", 'package q\n\nimport "example.com/m/lib/p"\n\nfunc Q() int {\n\treturn p.A()\n}\n'),
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

test("a Go file is not moved into a package it imports, where it would import its own package", async () => {
  const move = await plan("lib/feature/feat.go", "lib/base");
  expect(move.refusals).toEqual([expect.objectContaining({ code: "import-cycle", detail: expect.stringContaining("import cycle: lib/feature/feat.go imports lib/base") })]);
});

test("a Go file is not moved into a package that uses the package it leaves when the old package still uses the file", async () => {
  const move = await plan("lib/p/f.go", "lib/q");
  expect(move.refusals).toEqual([expect.objectContaining({ code: "import-cycle", detail: "import cycle: lib/p and lib/q would import each other" })]);
});

test("a Go library file is not moved into a package main folder", async () => {
  const move = await plan("lib/helper/help.go", "cmd/app");
  expect(move.refusals).toEqual([expect.objectContaining({ code: "package-main" })]);
});

test("a move that creates no cycle and leaves no package main is still planned", async () => {
  const move = await plan("lib/helper/help.go", "lib/base");
  expect(move.refusals).toEqual([]);
  expect(move.results).toEqual([{ from: "lib/helper/help.go", to: "lib/base/help.go", role: "unit" }]);
});

test("the analysis proposes none of the refused targets", async () => {
  const run = await runLocality(repo.path, ["analyse", "--json", "--limit", "all"]);
  const rows = JSON.parse(run.stdout).results as { path: string; target: string; recommendation: string }[];
  const proposed = rows.filter((row) => row.recommendation === "move").map((row) => `${row.path} -> ${row.target}`);
  expect(proposed).not.toContain("lib/helper/help.go -> cmd/app");
  expect(proposed).not.toContain("lib/feature/feat.go -> lib/base");
});
