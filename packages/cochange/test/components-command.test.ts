import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { GROUPING_FOLDERS, componentsBlock, inferComponents } from "../src/component-map.ts";
import { componentOf, readComponents } from "../src/components.ts";
import { expectGolden } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";
import { steadyHistory } from "./support/scenarios.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = steadyHistory();
});
afterAll(() => repo.dispose());

const run = async (...args: string[]) => JSON.parse((await runCochange(repo.path, ["components", ...args, "--limit", "all"])).stdout);

test("without configured components the map is inferred from the folders, and the output says so", async () => {
  const { stdout } = await runCochange(repo.path, ["components", "--limit", "all"]);
  const document = JSON.parse(stdout);
  expect(document.source).toBe("inferred");
  expect(document.results.map((r: { component: string; group: string }) => `${r.group}/${r.component}`)).toEqual(["src/billing", "src/reporting"]);
  expect(document.filesInNoComponent).toBe(0);
  expectGolden("steady", "components", stdout);
});

test("--propose prints a components block that reads back as the inferred map", async () => {
  const document = await run("--propose");
  const block = document.proposal.components as Record<string, { paths: string[]; group: string }>;
  expect(block.billing).toEqual({ paths: ["src/billing/**"], group: "src" });
  const read = readComponents(block);
  expect(componentOf(read, "src/billing/invoice.ts")).toBe("billing");
});

test("a configured map is printed as configured, with groups, and --propose still infers", async () => {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ components: { money: { paths: ["src/billing/**"], group: "product" }, other: "src/reporting" } }));
  try {
    const configured = await run();
    expect(configured.source).toBe("configured");
    expect(configured.results).toMatchObject([{ component: "money", group: "product", files: 1 }, { component: "other", group: null, files: 1 }]);
    expect((await run("--propose")).source).toBe("inferred");
  } finally {
    writeFileSync(join(repo.path, "code-health.json"), "{}");
  }
});

test("a grouping folder's children are the components and files directly in it, or in the root, get a component of their own", () => {
  const map = inferComponents(["README.go", "docs/a.go", "src/main.go", "src/core/a.go", "src/web/b.go", "test/unit/t.go", "pkg/web/c.go"]);
  expect(map.map((d) => [d.group, d.name, d.globs])).toEqual([
    ["pkg", "pkg/web", ["pkg/web/**"]],
    ["src", "core", ["src/core/**"]],
    ["src", "src", ["src/*.go"]],
    ["src", "src/web", ["src/web/**"]],
    ["test", "unit", ["test/unit/**"]],
    ["top level", "(root)", ["/*.go"]],
    ["top level", "docs", ["docs/**"]],
  ]);
  const read = readComponents(componentsBlock(map).components);
  expect(componentOf(read, "src/main.go")).toBe("src");
  expect(componentOf(read, "src/core/deep/x.go")).toBe("core");
  expect(componentOf(read, "main.go")).toBe("(root)");
  expect(componentOf(read, "docs/x/y.go")).toBe("docs");
});

test("components that would share a name are named with their group", () => {
  const map = inferComponents(["src/web/a.go", "pkg/web/b.go"]);
  expect(map.map((d) => d.name)).toEqual(["pkg/web", "src/web"]);
});

test("the grouping folders include the suite's test folder names", () => {
  expect(GROUPING_FOLDERS).toEqual(expect.arrayContaining(["src", "packages", "test", "tests", "e2e"]));
});

test("a component's group must be a non-empty string", () => {
  expect(() => readComponents({ a: { paths: "x", group: 3 } })).toThrowError("group");
});
