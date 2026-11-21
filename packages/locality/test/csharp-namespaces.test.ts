import { describe, expect, it } from "vitest";
import { treeFromTexts } from "@code-health/parse/source-tree";
import { namespaceAfterMove, planNamespaceUpdate } from "../src/movers/csharp-namespaces.ts";

/** The optional second commit of a C# move: namespaces follow the folders the files moved to. The tree is the one after the move. */
describe("the namespace a moved file follows its folder to", () => {
  it.each([
    ["Acme.Billing", "src/Billing/Money.cs", "src/Payments/Money.cs", "Acme.Payments"],
    ["Acme.Billing.Invoices", "src/Billing/Invoices/Invoice.cs", "src/Accounts/Invoices/Invoice.cs", "Acme.Accounts.Invoices"],
    ["Acme.Billing", "src/Billing/Money.cs", "src/Billing/Domain/Money.cs", "Acme.Billing.Domain"],
    ["Acme.Billing.Domain", "src/Billing/Domain/Money.cs", "src/Billing/Money.cs", "Acme.Billing"],
    ["Acme.Sales", "src/Billing/Money.cs", "src/Payments/Money.cs", undefined],
  ])("%s, moved from %s to %s, becomes %s", (namespace, from, to, expected) => {
    expect(namespaceAfterMove(namespace, from, to)).toBe(expected);
  });
});

describe("planning the namespace update after a move", () => {
  const moves = [
    { from: "src/Billing/Money.cs", to: "src/Payments/Money.cs", role: "unit" as const },
    { from: "src/Billing/Invoice.cs", to: "src/Payments/Invoice.cs", role: "unit" as const },
  ];

  it("renames a namespace the move vacates, in its declarations and in the usings that name it", async () => {
    const tree = treeFromTexts({
      "src/Payments/Money.cs": "namespace Acme.Billing;\n\npublic record Money(decimal Amount);\n",
      "src/Payments/Invoice.cs": "namespace Acme.Billing\n{\n    public class Invoice { }\n}\n",
      "src/Shop/Cart.cs": "using System;\nusing Acme.Billing;\nusing static Acme.Billing.Money;\n\nnamespace Acme.Shop;\n\npublic class Cart { }\n",
    });
    const plan = await planNamespaceUpdate(tree, moves);
    expect(plan.renamed).toEqual({ "Acme.Billing": "Acme.Payments" });
    expect(plan.rewrites).toEqual([
      { path: "src/Payments/Invoice.cs", line: 1, from: "Acme.Billing", to: "Acme.Payments" },
      { path: "src/Payments/Money.cs", line: 1, from: "Acme.Billing", to: "Acme.Payments" },
      { path: "src/Shop/Cart.cs", line: 2, from: "Acme.Billing", to: "Acme.Payments" },
      { path: "src/Shop/Cart.cs", line: 3, from: "Acme.Billing", to: "Acme.Payments" },
    ]);
    expect(Object.fromEntries(plan.texts)).toEqual({
      "src/Payments/Invoice.cs": "namespace Acme.Payments\n{\n    public class Invoice { }\n}\n",
      "src/Payments/Money.cs": "namespace Acme.Payments;\n\npublic record Money(decimal Amount);\n",
      "src/Shop/Cart.cs": "using System;\nusing Acme.Payments;\nusing static Acme.Payments.Money;\n\nnamespace Acme.Shop;\n\npublic class Cart { }\n",
    });
    expect(plan.warnings).toEqual([]);
  });

  it("reports a fully qualified use, which it does not rewrite", async () => {
    const tree = treeFromTexts({
      "src/Payments/Money.cs": "namespace Acme.Billing;\npublic record Money(decimal Amount);\n",
      "src/Payments/Invoice.cs": "namespace Acme.Billing;\npublic class Invoice { }\n",
      "src/Shop/Cart.cs": "namespace Acme.Shop;\npublic class Cart { public Acme.Billing.Money Total; }\n",
    });
    const plan = await planNamespaceUpdate(tree, moves);
    expect(plan.warnings).toEqual(["src/Shop/Cart.cs:2 names Acme.Billing in full, which is not rewritten"]);
  });

  it("leaves a namespace alone that other files still declare, since their users would need a new using", async () => {
    const tree = treeFromTexts({
      "src/Payments/Money.cs": "namespace Acme.Billing;\npublic record Money(decimal Amount);\n",
      "src/Payments/Invoice.cs": "namespace Acme.Billing;\npublic class Invoice { }\n",
      "src/Tax/Rate.cs": "namespace Acme.Billing;\npublic class Rate { }\n",
    });
    const plan = await planNamespaceUpdate(tree, moves);
    expect(plan.renamed).toEqual({});
    expect(plan.texts.size).toBe(0);
    expect(plan.warnings).toEqual(["Acme.Billing is still declared by src/Tax/Rate.cs: its users would need a new using, so it is left alone"]);
  });

  it("leaves alone a namespace that encloses another, and one that does not follow its folder", async () => {
    const tree = treeFromTexts({
      "src/Payments/Money.cs": "namespace Acme.Billing;\npublic record Money(decimal Amount);\n",
      "src/Payments/Invoice.cs": "namespace Acme.Sales;\npublic class Invoice { }\n",
      "src/Reports/Report.cs": "namespace Acme.Billing.Reports;\npublic class Report { }\n",
    });
    const plan = await planNamespaceUpdate(tree, moves);
    expect(plan.renamed).toEqual({});
    expect(plan.warnings).toEqual([
      "src/Payments/Invoice.cs: namespace Acme.Sales does not follow the folder src/Billing, so it is left alone",
      "Acme.Billing encloses Acme.Billing.Reports, which reach its types without a using: it is left alone",
    ]);
  });
});
