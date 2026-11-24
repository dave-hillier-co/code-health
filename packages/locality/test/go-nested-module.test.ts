import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adapterById, overrideSupportedAdapters } from "@code-health/parse/languages";
import { treeFromTexts } from "@code-health/parse/source-tree";
import { manifestFolders, placementRefusals } from "../src/placement.ts";
import { performMove } from "../src/move-engine.ts";

beforeAll(() => overrideSupportedAdapters([adapterById("go")!]));
afterAll(() => overrideSupportedAdapters(undefined));

const nested = treeFromTexts({
  "go.mod": "module example.com/m\n\ngo 1.22\n",
  "root.go": "package m\n",
  "e2e/go.mod": "module example.com/m/e2e\n\ngo 1.22\n\nreplace example.com/m => ../\n",
  "e2e/run.go": "package e2e\n\nfunc Run() {}\n\nfunc GoRun() { Run() }\n",
  "e2e/client.go": "package e2e\n\ntype Client struct{}\n",
  "e2e/spice/spice.go": 'package spice\n\nimport "example.com/m/e2e"\n\nfunc Go() {\n\te2e.GoRun()\n}\n',
  "e2e/cockroach/cockroach.go": 'package cockroach\n\nimport "example.com/m/e2e"\n\nfunc Start() {\n\te2e.Run()\n}\n',
});

describe("moving a file of a package in a nested module", () => {
  it("renames the package clause and rewrites the references in the consumers", async () => {
    const result = await performMove(nested, [{ from: "e2e/run.go", to: "e2e/cockroach/run.go", role: "unit" }]);
    expect(result.breaks).toBeUndefined();
    expect(result.rewrites).toEqual([
      { path: "e2e/cockroach/cockroach.go", line: 3, from: "example.com/m/e2e", to: "" },
      { path: "e2e/spice/spice.go", line: 3, from: "", to: "example.com/m/e2e/cockroach" },
      { path: "e2e/spice/spice.go", line: 3, from: "example.com/m/e2e", to: "" },
    ]);
    expect(result.texts.get("e2e/cockroach/run.go")).toBe("package cockroach\n\nfunc Run() {}\n\nfunc GoRun() { Run() }\n");
    expect(result.texts.get("e2e/cockroach/cockroach.go")).toBe('package cockroach\n\nfunc Start() {\n\tRun()\n}\n');
    expect(result.texts.get("e2e/spice/spice.go")).toContain("cockroach.GoRun()");
    expect(result.texts.get("e2e/spice/spice.go")).toContain('"example.com/m/e2e/cockroach"');
  });

  it("reports a consumer that cannot follow as a break", async () => {
    const tree = treeFromTexts({
      "go.mod": "module example.com/m\n\ngo 1.22\n",
      "e2e/go.mod": "module example.com/m/e2e\n\ngo 1.22\n",
      "e2e/run.go": "package e2e\n\nfunc Run() { helper() }\n",
      "e2e/helper.go": "package e2e\n\nfunc helper() {}\n",
      "e2e/cockroach/c.go": 'package cockroach\n\nimport "example.com/m/e2e"\n\nfunc S() { e2e.Run() }\n',
    });
    const result = await performMove(tree, [{ from: "e2e/run.go", to: "e2e/cockroach/run.go", role: "unit" }]);
    expect(result.breaks?.length).toBeGreaterThan(0);
  });
});

describe("a move between modules", () => {
  const manifests = manifestFolders(Object.keys({ "go.mod": 1, "e2e/go.mod": 1 }));
  const files = new Set(["go.mod", "e2e/go.mod", "e2e/run.go", "pkg/a.go"]);
  it.each([
    ["out of the nested module", "e2e/run.go", "pkg/run.go"],
    ["into the nested module", "pkg/a.go", "e2e/a.go"],
  ])("is refused as a package boundary, %s", (_name, from, to) => {
    const refusals = placementRefusals([{ from, to, role: "unit" }], manifests, files);
    expect(refusals.map((refusal) => refusal.code)).toEqual(["package-boundary"]);
  });
});
