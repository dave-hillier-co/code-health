import { afterAll, describe, expect, test } from "vitest";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { runStructure } from "./support/run.ts";

const add = (path: string, content: string): Change => ({ op: "add", path, content });

/** A repository of C++ components, each a header with a source file that implements it, as `src/<name>/<Name>.h` and `.cpp`. */
function repository(files: Record<string, string>): GitFixture {
  return GitFixture.build([
    {
      type: "commit",
      message: "Add the components",
      date: "2024-01-01T09:00:00Z",
      changes: [add("code-health.json", JSON.stringify({ includeRoots: ["src"] })), ...Object.entries(files).map(([path, content]) => add(path, content))],
    },
  ]);
}

const fixtures: GitFixture[] = [];
afterAll(() => fixtures.forEach((fixture) => fixture.dispose()));
const build = (files: Record<string, string>) => {
  const fixture = repository(files);
  fixtures.push(fixture);
  return fixture;
};

interface Row {
  nodes: string[];
  breakingSet: { from: string; to: string }[];
}

async function cycles(fixture: GitFixture): Promise<Row[]> {
  const run = await runStructure(fixture.path, ["cycles", "--json", "--limit", "all", "--level", "file"]);
  return (JSON.parse(run.stdout) as { results: Row[] }).results;
}

describe("a header and the source file that implements it", () => {
  test("are no cycle with what the source file includes, when the headers themselves are acyclic", async () => {
    // X.cpp uses Y, and Y.cpp uses X: each implementation depends on the other's header, and no header includes another.
    const fixture = build({
      "src/x/X.h": "#pragma once\nint x();\n",
      "src/x/X.cpp": '#include "x/X.h"\n#include "y/Y.h"\nint x() { return y(); }\n',
      "src/y/Y.h": "#pragma once\nint y();\n",
      "src/y/Y.cpp": '#include "y/Y.h"\n#include "x/X.h"\nint y() { return x(); }\n',
    });
    expect(await cycles(fixture)).toEqual([]);
  });

  test("never put the edge from the header to its source file in a breaking set", async () => {
    // A.h and B.h include each other, and each has an implementation file.
    const fixture = build({
      "src/a/A.h": '#pragma once\n#include "b/B.h"\nint a();\n',
      "src/a/A.cpp": '#include "a/A.h"\nint a() { return b(); }\n',
      "src/b/B.h": '#pragma once\n#include "a/A.h"\nint b();\n',
      "src/b/B.cpp": '#include "b/B.h"\nint b() { return a(); }\n',
    });
    const rows = await cycles(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.nodes).toEqual(["src/a/A.h", "src/b/B.h"]);
    expect(rows[0]!.breakingSet.map((edge) => `${edge.from} -> ${edge.to}`)).toHaveLength(1);
    expect(rows[0]!.breakingSet.every((edge) => !edge.to.endsWith(".cpp"))).toBe(true);
  });
});
