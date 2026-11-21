import { describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { treeFromTexts } from "../src/source-tree.ts";

const project = '<Project Sdk="Microsoft.NET.Sdk"></Project>';

const edgesOf = (analysis: Awaited<ReturnType<typeof analyseTree>>) => analysis.fileEdges.map((edge) => `${edge.from} -> ${edge.to}`).sort();

describe("C# partial types", () => {
  it("does not take Result and Result<T> declared in two files for the parts of one type", async () => {
    const analysis = await analyseTree(
      treeFromTexts({
        "A/A.csproj": project,
        "A/Result.cs": "namespace A { public static class Result { public static int Ok() { return 1; } } }",
        "A/ResultOfT.cs": "namespace A { public class Result<T> { public T Value; } }",
        "A/Use.cs": "namespace A { public class Use { int F() { return Result.Ok(); } } }",
      }),
    );
    expect(edgesOf(analysis).filter((edge) => edge.startsWith("A/Result"))).toEqual([]);
    expect(analysis.consumers.filter((consumer) => consumer.from.startsWith("A/Result"))).toEqual([]);
  });

  it("sends every edge to a partial type to the part named for it, and none to the other parts", async () => {
    const analysis = await analyseTree(
      treeFromTexts({
        "A/A.csproj": project,
        "A/Ledger.cs": "namespace A { public partial class Ledger { public int Add() { return 1; } } }",
        "A/Ledger.Audit.cs": "namespace A { public partial class Ledger { public int Audit() { return 2; } } }",
        "A/Client.cs": "namespace A { public class Client { int F() { return new Ledger().Add(); } } }",
      }),
    );
    expect(edgesOf(analysis).filter((edge) => edge.startsWith("A/Client.cs"))).toEqual(["A/Client.cs -> A/Ledger.cs"]);
    expect(analysis.importEdges.filter((edge) => edge.from === "A/Client.cs").map((edge) => edge.to)).toEqual(["A/Ledger.cs"]);
  });
});

describe("C# names across namespaces and projects", () => {
  const edges = async (texts: Record<string, string>) => edgesOf(await analyseTree(treeFromTexts(texts)));

  it("reads a file-scoped namespace and a global using the way a block namespace and a using are read", async () => {
    expect(
      await edges({
        "A/A.csproj": project,
        "A/Money.cs": "namespace Acme.Billing;\n\npublic class Money { }\n",
        "A/Globals.cs": "global using Acme.Billing;\n",
        "A/Use.cs": "namespace Acme.Shop;\n\npublic class Use { Money total; }\n",
      }),
    ).toContain("A/Use.cs -> A/Money.cs");
  });

  it("does not see a namespace of another project through a global using of this one", async () => {
    expect(
      await edges({
        "A/A.csproj": project,
        "B/B.csproj": project,
        "A/Globals.cs": "global using Acme.Billing;\n",
        "B/Money.cs": "namespace Acme.Billing;\n\npublic class Money { }\n",
        "B/Use.cs": "namespace Acme.Shop;\n\npublic class Use { Money total; }\n",
      }),
    ).toEqual([]);
  });

  it("leaves a use of a type from an extern alias with no edge, and no edge to a type of the same name elsewhere", async () => {
    expect(
      await edges({
        "A/A.csproj": project,
        "A/Money.cs": "namespace Acme.Billing;\n\npublic class Money { }\n",
        "A/Use.cs": "extern alias Other;\n\nnamespace Acme.Shop;\n\npublic class Use { Other::Acme.Billing.Money total; }\n",
      }),
    ).toEqual([]);
  });

  it("takes the type of the namespace the file has in scope when two namespaces declare one name", async () => {
    expect(
      await edges({
        "A/A.csproj": project,
        "A/Billing.cs": "namespace Acme.Billing;\n\npublic class Money { }\n",
        "A/Payments.cs": "namespace Acme.Payments;\n\npublic class Money { }\n",
        "A/Use.cs": "using Acme.Payments;\n\nnamespace Acme.Shop;\n\npublic class Use { Money total; }\n",
      }),
    ).toEqual(["A/Use.cs -> A/Payments.cs"]);
  });
});
