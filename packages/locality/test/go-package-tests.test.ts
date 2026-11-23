import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { runLocality } from "./support/run.ts";

const add = (path: string, content: string): Change => ({ op: "add", path, content });

/**
 * A Go test file in the package's own folder is part of the package, so it reaches the package's unexported names and its testdata folder.
 *
 * - lib/flight/flight.go declares the unexported flightCount, which lib/flight/flight_test.go (package flight) uses. The test moves with the unit.
 * - lib/pair/left.go and lib/pair/right.go each declare an unexported name, and lib/pair/pair_test.go uses both, so neither moves alone.
 * - lib/data/data.go has lib/data/data_test.go (package data) and lib/data/testdata, which the test reads: the move is refused.
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
          'package main\n\nimport (\n\t"example.com/m/lib/combined"\n\t"example.com/m/lib/data"\n\t"example.com/m/lib/flight"\n\t"example.com/m/lib/pair"\n)\n\nfunc main() {\n\t_ = combined.One() + combined.Two() + data.Load() + flight.Count() + pair.Left() + pair.Right()\n}\n',
        ),
        add("lib/combined/one.go", 'package combined\n\nimport "example.com/m/lib/flight"\n\nfunc One() int {\n\treturn flight.Count()\n}\n'),
        add("lib/combined/two.go", 'package combined\n\nimport "example.com/m/lib/flight"\n\nfunc Two() int {\n\treturn flight.Count()\n}\n'),
        add("lib/flight/flight.go", "package flight\n\nfunc flightCount() int {\n\treturn 3\n}\n\nfunc Count() int {\n\treturn flightCount()\n}\n"),
        add("lib/flight/flight_test.go", 'package flight\n\nimport "testing"\n\nfunc TestCount(t *testing.T) {\n\tif flightCount() != 3 {\n\t\tt.Fatal("count")\n\t}\n}\n'),
        add("lib/pair/left.go", "package pair\n\nfunc leftValue() int {\n\treturn 1\n}\n\nfunc Left() int {\n\treturn leftValue()\n}\n"),
        add("lib/pair/right.go", "package pair\n\nfunc rightValue() int {\n\treturn 2\n}\n\nfunc Right() int {\n\treturn rightValue()\n}\n"),
        add("lib/pair/pair_test.go", 'package pair\n\nimport "testing"\n\nfunc TestPair(t *testing.T) {\n\tif leftValue()+rightValue() != 3 {\n\t\tt.Fatal("pair")\n\t}\n}\n'),
        add("lib/data/data.go", "package data\n\nfunc Load() int {\n\treturn 1\n}\n"),
        add("lib/data/data_test.go", 'package data\n\nimport (\n\t"os"\n\t"testing"\n)\n\nfunc TestLoad(t *testing.T) {\n\t_, err := os.ReadFile("testdata/input.txt")\n\tif err != nil {\n\t\tt.Fatal(err)\n\t}\n\tif Load() != 1 {\n\t\tt.Fatal("load")\n\t}\n}\n'),
        add("lib/data/testdata/input.txt", "input\n"),
      ],
    },
  ]);
});
afterAll(() => repo.dispose());

interface Move {
  refusals: { code: string; detail: string }[];
  results: { from: string; to: string; role: string }[];
}

async function plan(unit: string, to: string): Promise<Move> {
  const run = await runLocality(repo.path, ["move", "--json", unit, "--to", to, "--reason", "test"]);
  return JSON.parse(run.stdout || run.stderr) as Move;
}

test("a package's own test file that uses an unexported name of the unit moves with it", async () => {
  const move = await plan("lib/flight/flight.go", "lib/combined");
  expect(move.refusals).toEqual([]);
  expect(move.results).toEqual([
    { from: "lib/flight/flight.go", to: "lib/combined/flight.go", role: "unit" },
    { from: "lib/flight/flight_test.go", to: "lib/combined/flight_test.go", role: "test" },
  ]);
});

test("a unit is refused when a test of its package uses an unexported name of another file that stays", async () => {
  const move = await plan("lib/pair/left.go", "lib/combined");
  expect(move.refusals.map((refusal) => refusal.code)).toEqual(["unexported-use"]);
  expect(move.refusals[0]!.detail).toContain("lib/pair/pair_test.go");
});

test("a move that would leave testdata behind a moved test is refused", async () => {
  const move = await plan("lib/data/data.go", "lib/combined");
  expect(move.refusals.map((refusal) => refusal.code)).toEqual(["testdata"]);
  expect(move.refusals[0]!.detail).toContain("lib/data/testdata");
});
