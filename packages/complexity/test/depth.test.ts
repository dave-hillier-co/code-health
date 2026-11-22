import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";

/**
 * The sources are the interface shape fixtures, whose node counts and interface sizes were counted by
 * hand (fixtures/languages/typescript/depth/expected.json), so every depth below is a hand-checked division.
 */
const fixtures = fileURLToPath(new URL("../../../fixtures/languages/typescript/depth/", import.meta.url));
const source = (name: string) => readFileSync(join(fixtures, name), "utf8");

interface Row {
  path: string;
  unit: string;
  id: string;
  kind: string;
  exported: boolean;
  nodes: number;
  interface: number;
  depth: number;
  passThrough: string | null;
  labels: string[];
  score: number;
}

let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Base",
      date: "2024-01-01T00:00:00+00:00",
      changes: [
        { op: "add", path: "src/shapes.ts", content: source("shapes.ts") },
        { op: "add", path: "src/forwarding.ts", content: source("forwarding.ts") },
        { op: "add", path: "src/plain.rb", content: "puts 1\n" },
      ],
    },
  ]);
});
afterAll(() => repo.dispose());

async function depth(...args: string[]) {
  const run = await runComplexity(repo.path, ["depth", "--json", "--limit", "all", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return run;
}
const rows = async (...args: string[]) => JSON.parse((await depth(...args)).stdout).results as Row[];
const byId = (all: Row[], id: string) => all.find((row) => row.id === id)!;

test("matches its golden", async () => {
  expectGolden("depth", "depth", (await depth()).stdout);
});

test("an exported function's depth is its implementation nodes over its parameters, at least one", async () => {
  const all = await rows();
  expect(byId(all, "src/shapes.ts#add")).toMatchObject({ kind: "function", exported: true, nodes: 18, interface: 2, depth: 9 });
  expect(byId(all, "src/shapes.ts#audit")).toMatchObject({ nodes: 22, interface: 1, depth: 22, labels: [] });
  // No parameters: the call itself is the interface.
  expect(byId(all, "src/forwarding.ts#bare")).toMatchObject({ nodes: 8, interface: 1, depth: 8 });
  expect(byId(all, "src/shapes.ts#default")).toMatchObject({ nodes: 5, interface: 1, depth: 5 });
});

test("an exported class's interface is its constructor parameters and the members a user can reach", async () => {
  const all = await rows();
  // Constructor 2 + find, size and count; the private method and the # field are out.
  expect(byId(all, "src/shapes.ts#Repo")).toMatchObject({ kind: "class", nodes: 58, interface: 5, depth: 11.6 });
  expect(byId(all, "src/forwarding.ts#Shape")).toMatchObject({ kind: "class", nodes: 17, interface: 2, depth: 8.5 });
});

test("a module's interface is what it exports", async () => {
  const all = await rows();
  expect(byId(all, "src/shapes.ts")).toMatchObject({ kind: "module", exported: true, nodes: 183, interface: 7, depth: 26.14 });
  expect(byId(all, "src/forwarding.ts")).toMatchObject({ kind: "module", nodes: 128, interface: 8, depth: 16 });
});

test("a function whose whole body forwards to one call is a pass-through, named with its target", async () => {
  const all = await rows();
  expect(byId(all, "src/shapes.ts#save")).toMatchObject({ passThrough: "store.save", labels: ["pass-through"] });
  expect(byId(all, "src/shapes.ts#load")).toMatchObject({ passThrough: "store.load" });
  expect(byId(all, "src/forwarding.ts#relay")).toMatchObject({ passThrough: "target" });
  // A forwarded argument must be a parameter or a literal. Anything computed is the function doing work.
  for (const id of ["src/shapes.ts#tagged", "src/forwarding.ts#computed", "src/forwarding.ts#creates", "src/forwarding.ts#early"]) {
    expect(byId(all, id).passThrough).toBeNull();
  }
});

test("only exported items have a row: a pass-through that is not exported is counted, and a public method of an exported class is listed", async () => {
  const run = JSON.parse((await depth()).stdout);
  const all = run.results as Row[];
  expect(all.every((row) => row.exported)).toBe(true);
  expect(all.map((row) => row.id)).not.toContain("src/shapes.ts#hidden");
  expect(run.summary.passThroughNotExported).toBeGreaterThan(0);
  expect(byId(all, "src/shapes.ts#Repo.find")).toMatchObject({ kind: "method", exported: true, passThrough: "this.store.find" });
  // Other unexported units and methods are not part of the signal.
  expect(all.map((row) => row.id)).not.toContain("src/shapes.ts#Repo.secret");
  expect(all.map((row) => row.id)).not.toContain("src/shapes.ts#Repo.size");
});

test("a private method of an exported class that forwards has no row, in each language that has the notion", async () => {
  const sources = {
    "src/Service.cs": "public class Service {\n  private readonly Store store = new Store();\n  public int Find(int id) { return store.Find(id); }\n  internal int Lookup(int id) { return store.Find(id); }\n  private int Hidden(int id) { return store.Find(id); }\n}\ninternal class Local {\n  public int Find(int id) { return Other.Find(id); }\n}\n",
    "src/Service.java": "public class Service {\n  public int find(int id) { return store.find(id); }\n  int lookup(int id) { return store.find(id); }\n  private int hidden(int id) { return store.find(id); }\n}\nclass Local {\n  public int find(int id) { return other.find(id); }\n}\n",
    "src/service.go": "package svc\n\ntype Service struct{}\n\nfunc (s *Service) Find(id int) int { return find(id) }\n\nfunc (s *Service) lookup(id int) int { return find(id) }\n\nfunc Exposed(id int) int { return find(id) }\n\nfunc hidden(id int) int { return find(id) }\n\ntype local struct{}\n\nfunc (l local) Find(id int) int { return find(id) }\n",
    "src/service.py": "class Service:\n    def find(self, id):\n        return store.find(id)\n\n    def _hidden(self, id):\n        return store.find(id)\n\n\ndef exposed(id):\n    return store.find(id)\n\n\ndef _private(id):\n    return store.find(id)\n",
  };
  const polyglot = GitFixture.build([
    { type: "commit", message: "Base", date: "2024-01-01T00:00:00+00:00", changes: Object.entries(sources).map(([path, content]) => ({ op: "add" as const, path, content })) },
  ]);
  try {
    const run = JSON.parse((await runComplexity(polyglot.path, ["depth", "--json", "--limit", "all"])).stdout);
    const forwarding = (run.results as Row[]).filter((row) => row.passThrough !== null).map((row) => row.id).sort();
    expect(forwarding).toEqual([
      "src/Service.cs#Service.Find",
      "src/Service.java#Service.find",
      "src/service.go#Exposed",
      "src/service.go#Service.Find",
      "src/service.py#Service.find",
      "src/service.py#exposed",
    ]);
    // Hidden, internal and package-private forwards, and every forward in a type that is not exported, are counted and not listed.
    expect(run.summary.passThroughNotExported).toBe(11);
  } finally {
    polyglot.dispose();
  }
});

test("an exported unit is shallow below ten nodes per interface element, and a pass-through is not shallow for its size alone", async () => {
  const all = await rows();
  expect(all.filter((row) => row.labels.includes("shallow")).map((row) => row.id)).toEqual([
    "src/forwarding.ts#bare",
    "src/shapes.ts#default",
    "src/forwarding.ts#Shape",
    "src/shapes.ts#add",
  ]);
  // `bare` is both: it forwards, and 8 nodes over one is shallow.
  expect(byId(all, "src/forwarding.ts#bare").labels).toEqual(["pass-through", "shallow"]);
});

test("pass-throughs come first, then the shallowest", async () => {
  const all = await rows();
  const ids = all.map((row) => row.id);
  const lastPassThrough = Math.max(...all.map((row, index) => (row.passThrough === null ? -1 : index)));
  const firstOther = all.findIndex((row) => row.passThrough === null);
  expect(lastPassThrough).toBeLessThan(firstOther);
  const others = all.filter((row) => row.passThrough === null).map((row) => row.depth);
  expect(others).toEqual([...others].sort((a, b) => a - b));
  expect(ids[0]).toBe("src/forwarding.ts#bare");
});

test("files with no structural adapter are counted, not listed", async () => {
  const run = JSON.parse((await depth()).stdout);
  expect(run.summary.filesWithoutAdapter).toBe(1);
  expect((run.results as Row[]).some((row) => row.path === "src/plain.rb")).toBe(false);
});

test("paths narrow the rows", async () => {
  const run = JSON.parse((await depth("src/shapes.ts")).stdout);
  expect(new Set((run.results as Row[]).map((row) => row.path))).toEqual(new Set(["src/shapes.ts"]));
  expect(run.summary.filesWithoutAdapter).toBe(0);
});

test("the shallow guideline is configurable", async () => {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ complexity: { interfaceDepth: { shallow: 20 } } }));
  try {
    const all = await rows();
    expect(byId(all, "src/shapes.ts#Repo").labels).toEqual(["shallow"]);
    expect(byId(all, "src/shapes.ts#audit").labels).toEqual([]);
  } finally {
    rmSync(join(repo.path, "code-health.json"));
  }
});

test("explain describes both labels", async () => {
  for (const rule of ["shallow", "pass-through"]) {
    const run = await runComplexity(repo.path, ["explain", rule, "--json"]);
    expect(run.code).toBe(ExitCode.Success);
    expect(JSON.parse(run.stdout).results).toMatchObject({ rule });
  }
});

test("the depth of a file's exports and its pass-throughs sit on its row in `files`", async () => {
  const run = await runComplexity(repo.path, ["files", "--json", "--limit", "all"]);
  const files = JSON.parse(run.stdout).results as { path: string; interfaceDepth: number | null; passThroughs: number }[];
  // Mean over exported top-level functions and classes: add 9, save 12.5, load 13, audit 22, tagged 19, Repo 11.6, default 5.
  expect(files.find((file) => file.path === "src/shapes.ts")).toMatchObject({ interfaceDepth: 13.16, passThroughs: 4 });
  // A Ruby file is not code, so `files` does not list it.
  expect(files.find((file) => file.path === "src/plain.rb")).toBeUndefined();
});

test("a module that only re-exports with a star import has no body to measure and is not a row", async () => {
  const star = GitFixture.build([
    {
      type: "commit",
      message: "Package",
      date: "2024-01-01T00:00:00+00:00",
      changes: [
        { op: "add", path: "base/__init__.py", content: "from .core import *\n" },
        { op: "add", path: "base/core.py", content: "def build():\n    return 1\n" },
      ],
    },
  ]);
  try {
    const run = await runComplexity(star.path, ["depth", "--json", "--limit", "all"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(ExitCode.Success);
    const found = (JSON.parse(run.stdout).results as Row[]).map((row) => row.path);
    expect(found).toContain("base/core.py");
    expect(found).not.toContain("base/__init__.py");
  } finally {
    star.dispose();
  }
});
