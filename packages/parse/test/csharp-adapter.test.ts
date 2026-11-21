import { describe, expect, it } from "vitest";
import { adapterById } from "../src/languages.ts";
import { treeFromTexts } from "../src/source-tree.ts";

const csharp = adapterById("csharp")!;

describe("C# test paths", () => {
  it.each([
    ["tests/InvoiceTests.cs", true],
    ["test/InvoiceTest.cs", true],
    ["src/App.Tests/Billing/Invoice.cs", true],
    ["src/App.UnitTests/Invoice.cs", true],
    ["src/App.IntegrationTests/Invoice.cs", true],
    ["src/Billing/InvoiceTests.cs", true],
    ["src/Billing/InvoiceSpec.cs", true],
    ["src/UITests.cs", true],
    ["src/APITests.cs", true],
    ["src/Tests.cs", true],
    ["Tests.cs", true],
    ["src/Billing/Test.cs", true],
    ["src/Billing/Invoice.cs", false],
    ["src/Contest.cs", false],
    ["src/Latest/Invoice.cs", false],
    ["src/Testing/Invoice.cs", false],
  ])("%s is a test file: %s", (path, expected) => {
    expect(csharp.isTestPath(path)).toBe(expected);
  });
});

describe("C# boundaries", () => {
  const tree = treeFromTexts({
    "Acme.sln": "",
    "src/App/App.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><AssemblyName>Acme.Application</AssemblyName></PropertyGroup></Project>',
    "src/App/Program.cs": "class Program {}",
    "src/Core/Core.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup></Project>',
    "src/Lib/Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsPackable>true</IsPackable></PropertyGroup></Project>',
    "src/Plain/Plain.csproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>',
    "src/New/New.slnx": "<Solution />",
  });

  it("takes projects and solutions as the manifests", () => {
    expect(["Acme.sln", "src/App/App.csproj", "src/New/New.slnx", "src/App/Program.cs", "package.json"].map((path) => csharp.boundaries.isManifest(path))).toEqual([true, true, true, false, false]);
  });

  it("names each by its assembly or file, says whether it is internal, and publishes no file as an entry", async () => {
    expect(await csharp.boundaries.discover(tree)).toEqual([
      { dir: ".", manifest: "Acme.sln", name: "Acme", private: null, entryFiles: [] },
      { dir: "src/App", manifest: "src/App/App.csproj", name: "Acme.Application", private: null, entryFiles: [] },
      { dir: "src/Core", manifest: "src/Core/Core.csproj", name: "Core", private: true, entryFiles: [] },
      { dir: "src/Lib", manifest: "src/Lib/Lib.csproj", name: "Lib", private: false, entryFiles: [] },
      { dir: "src/New", manifest: "src/New/New.slnx", name: "New", private: null, entryFiles: [] },
      { dir: "src/Plain", manifest: "src/Plain/Plain.csproj", name: "Plain", private: null, entryFiles: [] },
    ]);
  });
});
