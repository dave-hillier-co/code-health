import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { runLocality } from "./support/run.ts";

/** The optional second commit of a C# move: namespaces follow the folders, in a commit of its own. */
const add = (path: string, content: string): Change => ({ op: "add", path, content });

interface Document {
  applied: boolean;
  commit: string | null;
  renamed: Record<string, string>;
  rewrites: { path: string; line: number; from: string; to: string }[];
  warnings: string[];
}

function build(extra: Change[]): GitFixture {
  const fixture = GitFixture.build([
    {
      type: "commit",
      message: "Add the app",
      date: "2024-01-01T09:00:00Z",
      changes: [
        add("src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk"></Project>\n'),
        add("src/App/Billing/Money.cs", "namespace Acme.Billing;\n\npublic record Money(decimal Amount);\n"),
        add("src/App/Shop/Cart.cs", "using Acme.Billing;\n\nnamespace Acme.Shop;\n\npublic class Cart { public Money Total; }\n"),
        add("src/App/Other/Thing.cs", "namespace Acme.Other;\n\npublic class Thing { }\n"),
        ...extra,
      ],
    },
    {
      type: "commit",
      message: "Move Billing to Payments\n\nCode-Health: locality distant",
      date: "2024-01-02T09:00:00Z",
      changes: [{ op: "rename", from: "src/App/Billing/Money.cs", path: "src/App/Payments/Money.cs" }],
    },
  ]);
  fixture.git("config", "user.name", "Agent");
  fixture.git("config", "user.email", "agent@example.com");
  return fixture;
}

let repo: GitFixture;
beforeEach(() => {
  repo = build([]);
});
afterEach(() => repo.dispose());

async function run(...args: string[]) {
  const result = await runLocality(repo.path, ["update-namespaces", "--json", ...args]);
  return { code: result.code, stderr: result.stderr, document: JSON.parse(result.stdout || "{}") as Document };
}

test("plans the namespace of a moved file and the usings that name it, changing nothing", async () => {
  const { code, document } = await run();
  expect(code).toBe(ExitCode.Success);
  expect(document.applied).toBe(false);
  expect(document.renamed).toEqual({ "Acme.Billing": "Acme.Payments" });
  expect(document.rewrites.map((rewrite) => `${rewrite.path}:${rewrite.line}`)).toEqual(["src/App/Payments/Money.cs:1", "src/App/Shop/Cart.cs:1"]);
  expect(repo.git("status", "--porcelain")).toBe("");
});

test("with --apply makes it a commit of its own that carries the trailer", async () => {
  const { code, document } = await run("--apply");
  expect(code).toBe(ExitCode.Success);
  expect(document.applied).toBe(true);
  expect(readFileSync(join(repo.path, "src/App/Payments/Money.cs"), "utf8")).toContain("namespace Acme.Payments;");
  expect(readFileSync(join(repo.path, "src/App/Shop/Cart.cs"), "utf8")).toContain("using Acme.Payments;");
  expect(repo.git("log", "-1", "--format=%B")).toMatch(/\n\nCode-Health: locality namespaces$/);
  expect(repo.git("rev-list", "--count", "HEAD")).toBe("3");
});

test("reports a namespace the move does not vacate and leaves it alone", async () => {
  repo.dispose();
  repo = build([add("src/App/Billing/Invoice.cs", "namespace Acme.Billing;\n\npublic class Invoice { }\n")]);
  const { document } = await run();
  expect(document.renamed).toEqual({});
  expect(document.rewrites).toEqual([]);
  expect(document.warnings).toEqual(["Acme.Billing is still declared by src/App/Billing/Invoice.cs: its users would need a new using, so it is left alone"]);
});

test("refuses a commit that is not a move commit of the suite", async () => {
  const result = await run("--commit", "HEAD~1");
  expect(result.code).not.toBe(ExitCode.Success);
});

test("refuses --apply over a dirty working tree", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(repo.path, "notes.txt"), "x");
  const { code } = await run("--apply");
  expect(code).not.toBe(ExitCode.Success);
  expect(repo.git("rev-list", "--count", "HEAD")).toBe("2");
});
