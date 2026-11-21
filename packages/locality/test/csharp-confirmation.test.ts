import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { adapterById } from "@code-health/parse/languages";
import { treeFromTexts } from "@code-health/parse/source-tree";
import { performMove } from "../src/move-engine.ts";

/**
 * The Roslyn confirmation of a C# move, against a stand-in language server that is a real process speaking the
 * protocol over stdio (the process boundary is the only thing replaced). The conformance suite runs the same
 * move against the real server when it is installed.
 */
const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function serverOnPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "code-health-roslyn-path-"));
  scratch.push(directory);
  const executable = join(directory, "Microsoft.CodeAnalysis.LanguageServer");
  copyFileSync(fileURLToPath(new URL("./support/fake-roslyn.mjs", import.meta.url)), executable);
  chmodSync(executable, 0o755);
  return directory;
}

const csharp = adapterById("csharp")!;
const tree = treeFromTexts({
  "App.sln": "",
  "src/App/App.csproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  "src/App/Billing/Invoice.cs": "namespace Acme.App.Billing;\npublic class Invoice { }\n",
  "src/App/old-error/Legacy.cs": "namespace Acme.App;\npublic class Legacy { }\n",
});

const confirmations = async (to: string, from = "src/App/Billing/Invoice.cs") => (await performMove(tree, [{ from, to, role: "unit" }], { adapters: [csharp], searchPath: serverOnPath() })).confirmations;

describe("confirming a C# move with the Roslyn language server", () => {
  it("confirms a move that adds no compile error to the files it moves", async () => {
    expect(await confirmations("src/App/Domain/Invoice.cs")).toEqual([
      { language: "csharp", tool: "roslyn-lsp", status: "confirmed", detail: "roslyn-lsp found no compile error in 1 moved file that they did not have before the move" },
    ]);
  });

  it("does not confirm a move after which a moved file has a compile error it did not have", async () => {
    const [confirmation] = await confirmations("src/App/broken/Invoice.cs");
    expect(confirmation).toMatchObject({ language: "csharp", tool: "roslyn-lsp", status: "not confirmed" });
    expect(confirmation!.detail).toBe("roslyn-lsp found 1 new compile error after the move: src/App/Billing/Invoice.cs: CS0246 The type or namespace name 'Money' could not be found");
  });

  it("ignores an error the moved file had before the move, and warnings", async () => {
    const [confirmation] = await confirmations("src/App/old-error/Moved.cs", "src/App/old-error/Legacy.cs");
    expect(confirmation!.status).toBe("confirmed");
  });

  it("says not confirmed, and does not fail, when the server cannot be used", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-health-roslyn-broken-"));
    scratch.push(directory);
    const executable = join(directory, "Microsoft.CodeAnalysis.LanguageServer");
    // A server that exits as soon as it starts.
    writeFileSync(executable, "#!/bin/sh\nexit 3\n");
    chmodSync(executable, 0o755);
    const result = await performMove(tree, [{ from: "src/App/Billing/Invoice.cs", to: "src/App/Domain/Invoice.cs", role: "unit" }], { adapters: [csharp], searchPath: directory });
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0]).toMatchObject({ status: "not confirmed" });
    expect(result.confirmations[0]!.detail).toContain("roslyn-lsp could not check the move");
  });
});
