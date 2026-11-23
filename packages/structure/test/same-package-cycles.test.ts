import { afterAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Change, type Identity } from "@code-health/fixtures/git-fixture";
import { runStructure } from "./support/run.ts";

const author: Identity = { name: "Alice", email: "alice@example.com" };
const fixtures: GitFixture[] = [];
afterAll(() => fixtures.forEach((fixture) => fixture.dispose()));

const repository = (first: Change[], second: Change[]): GitFixture => {
  const fixture = GitFixture.build([
    { type: "commit", message: "Add the packages", date: "2024-01-10T09:00:00Z", author, changes: first },
    { type: "commit", message: "Add the files that use each other", date: "2024-02-10T09:00:00Z", author, changes: second },
  ]);
  fixtures.push(fixture);
  return fixture;
};

const add = (path: string, content: string): Change => ({ op: "add", path, content });

// Two files of package `store` use each other without an import, and `app` imports `store`.
const goFirst = [
  add("go.mod", "module example.com/m\n\ngo 1.22\n"),
  add("store/get.go", "package store\n\nfunc Get() int {\n\treturn Limit\n}\n"),
  add("store/limit.go", "package store\n\nconst Limit = 3\n"),
  add("app/main.go", 'package app\n\nimport "example.com/m/store"\n\nfunc Run() int {\n\treturn store.Get()\n}\n'),
];
const goSecond = [
  add("store/put.go", "package store\n\nfunc Put() int {\n\treturn Get() + Limit\n}\n"),
  { op: "modify", path: "store/limit.go", content: "package store\n\nconst Limit = 3\n\nfunc Cap() int {\n\treturn Put()\n}\n" } as Change,
];

interface Cycles {
  results: { id: string; level: string; nodes: string[] }[];
  inputs: { level: string };
  projectFolderCycles?: { count: number; largest: { id: string; size: number; nodes: string[]; project: string }[] };
}

async function cycles(fixture: GitFixture, ...args: string[]): Promise<Cycles> {
  const run = await runStructure(fixture.path, ["cycles", "--json", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return JSON.parse(run.stdout) as Cycles;
}

describe("Go files of one package", () => {
  const repo = repository(goFirst, goSecond);

  test("are not a cycle at the default level, which is the Go package", async () => {
    const document = await cycles(repo);
    expect(document.inputs.level).toBe("default");
    expect(document.results).toEqual([]);
  });

  test("are not a cycle at file level either, because they reference each other without imports", async () => {
    expect((await cycles(repo, "--level", "file")).results).toEqual([]);
  });

  test("do not make check exit 1", async () => {
    const run = await runStructure(repo.path, ["check", "--json", "--base", "HEAD~1"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(ExitCode.Success);
    expect(JSON.parse(run.stdout).results).toEqual([]);
  });

  test("print the symbols used across the edge with a readable name", async () => {
    const run = await runStructure(repo.path, ["evidence", "store/get.go->store/limit.go", "--json"]);
    expect(run.stdout).not.toContain("\\u0000");
    expect(run.stdout).not.toContain("\0");
    expect(run.stdout).toContain("store/limit.go#Limit");
  });
});

describe("Go packages", () => {
  test("are cycles when the imports between packages run both ways, at the default level", async () => {
    const repo = repository(
      [add("go.mod", "module example.com/m\n\ngo 1.22\n"), add("a/a.go", "package a\n\nfunc A() int {\n\treturn 1\n}\n")],
      [
        { op: "modify", path: "a/a.go", content: 'package a\n\nimport "example.com/m/b"\n\nfunc A() int {\n\treturn b.B()\n}\n' } as Change,
        add("b/b.go", 'package b\n\nimport "example.com/m/a"\n\nfunc B() int {\n\treturn a.A()\n}\n'),
      ],
    );
    const document = await cycles(repo);
    expect(document.results.map((r) => [r.id, r.nodes])).toEqual([["cycle:default:a", ["a", "b"]]]);
    const run = await runStructure(repo.path, ["check", "--json", "--base", "HEAD~1"]);
    expect(run.code).toBe(ExitCode.CheckFailed);
    expect(JSON.parse(run.stdout).results.map((r: { id: string }) => r.id)).toEqual(["cycle:default:a"]);
  });
});

describe("C# files", () => {
  const csproj = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n';
  const repo = repository(
    [add("Core/Core.csproj", csproj), add("Core/Order.cs", "namespace Acme;\n\npublic class Order\n{\n    public int Total() => 1;\n}\n")],
    [
      { op: "modify", path: "Core/Order.cs", content: "namespace Acme;\n\npublic class Order\n{\n    public int Total() => new Invoice().Lines();\n}\n" } as Change,
      add("Core/Invoice.cs", "namespace Acme;\n\npublic class Invoice\n{\n    public int Lines() => new Order().Total();\n}\n"),
    ],
  );

  test("are not a cycle at the default level, which is the project", async () => {
    expect((await cycles(repo)).results).toEqual([]);
  });

  test("are a cycle at file level on request", async () => {
    const document = await cycles(repo, "--level", "file");
    expect(document.results.map((r) => r.nodes)).toEqual([["Core/Invoice.cs", "Core/Order.cs"]]);
  });

  test("do not make check exit 1 by default", async () => {
    const run = await runStructure(repo.path, ["check", "--json", "--base", "HEAD~1"]);
    expect(run.code).toBe(ExitCode.Success);
  });
});

describe("C# folders of one project", () => {
  const csproj = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n';
  const klass = (name: string, uses: string) => `namespace Acme;\n\npublic class ${name}\n{\n    public int Run() => new ${uses}().Run();\n}\n`;
  const stub = (name: string) => `namespace Acme;\n\npublic class ${name}\n{\n    public int Run() => 1;\n}\n`;
  const build = (config: object | undefined): GitFixture =>
    repository(
      [add("Core/Core.csproj", csproj), add("Core/Orders/Order.cs", stub("Order")), add("Core/Billing/Invoice.cs", stub("Invoice")), ...(config === undefined ? [] : [add("code-health.json", JSON.stringify(config))])],
      [
        { op: "modify", path: "Core/Orders/Order.cs", content: klass("Order", "Invoice") } as Change,
        { op: "modify", path: "Core/Billing/Invoice.cs", content: klass("Invoice", "Order") } as Change,
      ],
    );

  test("are not a cycle at the default level, which is the project", async () => {
    const document = await cycles(build(undefined));
    expect(document.results).toEqual([]);
    expect(document).not.toHaveProperty("projectFolderCycles");
  });

  test("are listed at folder level on request", async () => {
    const document = await cycles(build(undefined), "--level", "folder");
    expect(document.results.map((r) => r.nodes)).toEqual([["Core/Billing", "Core/Orders"]]);
  });

  test("are a count with the largest few, and not rows, when csharpFolderCycles is set", async () => {
    const document = await cycles(build({ structure: { csharpFolderCycles: true } }));
    expect(document.results).toEqual([]);
    expect(document.projectFolderCycles).toEqual({ count: 1, largest: [{ id: "cycle:folder:Core/Billing", size: 2, nodes: ["Core/Billing", "Core/Orders"], project: "Core" }] });
  });

  test("do not make check exit 1 by default", async () => {
    const run = await runStructure(build(undefined).path, ["check", "--json", "--base", "HEAD~1"]);
    expect(run.code).toBe(ExitCode.Success);
  });
});
