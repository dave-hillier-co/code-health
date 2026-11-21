import { expect, it } from "vitest";
import { describeWithTool, fixtureCases } from "@code-health/fixtures/language-conformance";
import { adapterById, overrideSupportedAdapters } from "@code-health/parse/languages";
import { treeFromDirectory } from "@code-health/parse/source-tree";
import { performMove } from "../src/move-engine.ts";

/**
 * The C# move fixtures confirmed by the real Roslyn language server. They are skipped, with a notice, when the
 * server is not installed: resolution and moves never need it.
 */
const tool = adapterById("csharp")!.mover.confirmation!;

describeWithTool(tool.executable, "the C# move fixtures confirmed by Roslyn", () => {
  const fixture = fixtureCases("csharp", "moves").find((candidate) => candidate.name === "sdk-project")!;

  it("confirms a file move that changes no name", async () => {
    overrideSupportedAdapters([adapterById("csharp")!]);
    try {
      const result = await performMove(await treeFromDirectory(`${fixture.directory}before/`), [{ from: "src/App/Billing/Invoice.cs", to: "src/App/Domain/Invoice.cs", role: "unit" }]);
      expect(result.confirmations).toMatchObject([{ language: "csharp", tool: tool.name, status: "confirmed" }]);
    } finally {
      overrideSupportedAdapters(undefined);
    }
  }, 300_000);
}, { executable: "dotnet", args: ["--version"] });
