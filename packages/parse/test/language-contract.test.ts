import { describe, expect, it } from "vitest";
import { profiles } from "@code-health/lexical/profile";
import { analyseTree } from "../src/analyse-tree.ts";
import { GrammarSet } from "../src/grammars.ts";
import { adapterById, adapterForPath, bindingForPath, hasAdapter, isTestPath, registeredAdapters, supportedAdapters } from "../src/languages.ts";
import { treeFromTexts } from "../src/source-tree.ts";
import { toyAdapter } from "./support/toy-adapter.ts";

describe("the adapter registry", () => {
  it("lists adapters in id order, each id once", () => {
    const ids = registeredAdapters.map((adapter) => adapter.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every id the shape of a fixture folder name", () => {
    for (const adapter of registeredAdapters) expect(adapter.id, adapter.id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("lets an extension belong to one adapter only", () => {
    const owners = new Map<string, string>();
    for (const adapter of registeredAdapters) {
      for (const binding of adapter.grammars) {
        for (const extension of binding.extensions) {
          expect(extension, `${adapter.id} extension`).toMatch(/^\.[^./]+$/);
          expect(owners.get(extension), `${extension} is claimed by ${owners.get(extension)} and ${adapter.id}`).toBeUndefined();
          owners.set(extension, adapter.id);
        }
      }
    }
  });

  it("names a lexer profile that exists", () => {
    for (const adapter of registeredAdapters) expect(Object.keys(profiles), adapter.id).toContain(adapter.lexerProfile);
  });

  it("gives each grammar id one spec", () => {
    const specs = new Map<string, string>();
    for (const adapter of registeredAdapters) {
      for (const { spec } of adapter.grammars) {
        const seen = specs.get(spec.id);
        expect(seen === undefined || seen === `${spec.packageName}/${spec.file}`, `grammar ${spec.id} is declared twice with different files`).toBe(true);
        specs.set(spec.id, `${spec.packageName}/${spec.file}`);
      }
    }
  });

  it("finds the adapter, the grammar and the test convention of a path", () => {
    expect(adapterForPath("src/app.tsx")?.id).toBe("typescript");
    expect(bindingForPath("src/app.tsx")?.binding.spec.id).toBe("tsx");
    expect(hasAdapter("notes.txt")).toBe(false);
    expect(adapterById("typescript")?.support).toBe("supported");
    expect(isTestPath("src/app.test.ts")).toBe(true);
    expect(isTestPath("tests/helper.py")).toBe(true);
    expect(isTestPath("src/app.py")).toBe(false);
  });

  it("uses only supported adapters to analyse, unless asked", () => {
    const experimental = toyAdapter("toy", ".toy");
    expect(supportedAdapters()).not.toContain(experimental);
    expect(adapterForPath("a.toy")).toBeUndefined();
    expect(adapterForPath("a.toy", [experimental])).toBe(experimental);
  });
});

describe("the symbol-based dependency model", () => {
  const toy = toyAdapter("toy", ".toy");
  const tree = treeFromTexts({
    "Core/money.toy": "namespace Acme.Core\npublic class Money\n",
    "Core/ledger-a.toy": "namespace Acme.Core\nclass Ledger\n",
    "Core/ledger-b.toy": "namespace Acme.Core\nclass Ledger\n",
    "Billing/invoice.toy": "namespace Acme.Billing\nusing Acme.Core\npublic class Invoice\n  call Money\n  ref Tax\n  ref Ledger\n  ref Unknown\n",
    "Billing/tax.toy": "namespace Acme.Billing\nclass Tax\n",
    "Billing/invoice.test.toy": "namespace Acme.Billing.Tests\nclass InvoiceTests\n  call Invoice\n",
  });

  it("resolves names through the file's namespaces and usings, to every file that declares them", async () => {
    const analysis = await analyseTree(tree, { adapters: [toy] });
    expect(analysis.fileEdges).toEqual([
      { from: "Billing/invoice.test.toy", to: "Billing/invoice.toy", kind: "test", calls: 1, references: 0 },
      { from: "Billing/invoice.toy", to: "Billing/tax.toy", kind: "reference", calls: 0, references: 1 },
      { from: "Billing/invoice.toy", to: "Core/ledger-a.toy", kind: "reference", calls: 0, references: 1 },
      { from: "Billing/invoice.toy", to: "Core/ledger-b.toy", kind: "reference", calls: 0, references: 1 },
      { from: "Billing/invoice.toy", to: "Core/money.toy", kind: "call", calls: 1, references: 0 },
    ]);
  });

  it("reports consumers with the unit they sit in, the unit they use and a test kind for test files", async () => {
    const analysis = await analyseTree(tree, { adapters: [toy] });
    expect(analysis.consumers.map((c) => `${c.from}#${c.fromUnit} -> ${c.to}#${c.toSymbol} ${c.kind} x${c.count}`)).toEqual([
      "Billing/invoice.test.toy#InvoiceTests -> Billing/invoice.toy#Invoice test x1",
      "Billing/invoice.toy#Invoice -> Billing/tax.toy#Tax reference x1",
      "Billing/invoice.toy#Invoice -> Core/ledger-a.toy#Ledger reference x1",
      "Billing/invoice.toy#Invoice -> Core/ledger-b.toy#Ledger reference x1",
      "Billing/invoice.toy#Invoice -> Core/money.toy#Money call x1",
    ]);
  });

  it("reports every file edge as an import edge, because the graph consumers read those", async () => {
    const analysis = await analyseTree(tree, { adapters: [toy] });
    expect(analysis.importEdges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual(analysis.fileEdges.map((edge) => `${edge.from} -> ${edge.to}`));
  });

  it("marks exported units and lists the public declarations as exports", async () => {
    const analysis = await analyseTree(tree, { adapters: [toy] });
    expect(analysis.units.filter((unit) => unit.exported).map((unit) => unit.id)).toEqual(["Billing/invoice.toy#Invoice", "Core/money.toy#Money"]);
    expect(analysis.exports.map((exported) => `${exported.file} ${exported.name} ${exported.defined.kind}`)).toEqual([
      "Billing/invoice.toy Acme.Billing.Invoice class",
      "Core/money.toy Acme.Core.Money class",
    ]);
  });

  it("gives the same answer whatever order the tree lists its files in", async () => {
    const reversed = { ...tree, files: new Map([...tree.files].reverse()) };
    expect(JSON.stringify(await analyseTree(reversed, { adapters: [toy] }))).toBe(JSON.stringify(await analyseTree(tree, { adapters: [toy] })));
  });
});

describe("dependency groups", () => {
  it("resolve adapters that share a group together, so references cross languages", async () => {
    const left = toyAdapter("toy-a", ".toya", { group: "shared" });
    const right = toyAdapter("toy-b", ".toyb", { group: "shared" });
    const tree = treeFromTexts({ "A.toya": "namespace P\nclass A\n  call B\n", "B.toyb": "namespace P\nclass B\n" });
    expect((await analyseTree(tree, { adapters: [left, right] })).fileEdges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual(["A.toya -> B.toyb"]);
  });

  it("keep adapters of different groups apart", async () => {
    const left = toyAdapter("toy-a", ".toya");
    const right = toyAdapter("toy-b", ".toyb");
    const tree = treeFromTexts({ "A.toya": "namespace P\nclass A\n  call B\n", "B.toyb": "namespace P\nclass B\n" });
    expect((await analyseTree(tree, { adapters: [left, right] })).fileEdges).toEqual([]);
  });
});

describe("grammar loading", () => {
  it("loads only the grammars of the files a repository has", async () => {
    const grammars = new GrammarSet();
    await grammars.forPath("src/a.ts");
    await grammars.forPath("README.md");
    expect(grammars.loaded()).toEqual(["typescript"]);
    await grammars.forPath("src/b.jsx");
    expect(grammars.loaded()).toEqual(["javascript", "typescript"]);
  });
});
