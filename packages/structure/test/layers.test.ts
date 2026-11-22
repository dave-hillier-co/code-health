import { afterAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { allowedLayers, layerClassifier, readLayerRules } from "../src/layers.ts";
import { expectGolden } from "./support/golden.ts";
import { cleanBranch, layersRepository, violatingBranch } from "./support/layer-scenarios.ts";
import { runStructure } from "./support/run.ts";

const fixtures: GitFixture[] = [];
function track(fixture: GitFixture): GitFixture {
  fixtures.push(fixture);
  return fixture;
}
afterAll(() => fixtures.forEach((f) => f.dispose()));

const rules = readLayerRules(
  [
    { name: "ui", paths: ["src/ui/**"] },
    { name: "domain", paths: ["src/domain/**", "src/shared/**"] },
    { name: "plugins", paths: ["src/plugins/**"], allow: ["domain"] },
    { name: "data", paths: ["src/data/**"] },
  ],
  "layers",
);

describe("layer rules", () => {
  test("a layer may depend on itself and on the layers below it unless it names its own", () => {
    expect(allowedLayers(rules, "ui")).toEqual(["ui", "domain", "plugins", "data"]);
    expect(allowedLayers(rules, "domain")).toEqual(["domain", "plugins", "data"]);
    expect(allowedLayers(rules, "plugins")).toEqual(["domain", "plugins"]);
    expect(allowedLayers(rules, "data")).toEqual(["data"]);
  });

  test("a file belongs to the first layer whose globs match, and to none otherwise", () => {
    const layerOf = layerClassifier(rules);
    expect(layerOf("src/shared/money.ts")).toBe("domain");
    expect(layerOf("src/ui/a/b.ts")).toBe("ui");
    expect(layerOf("src/util/log.ts")).toBeUndefined();
  });

  test.each([
    [[{ name: "a", paths: [] }], /paths/],
    [[{ name: "a", paths: ["x/**"] }, { name: "a", paths: ["y/**"] }], /used by another layer/],
    [[{ name: "a", paths: ["x/**"], allow: ["nope"] }], /not a layer/],
    [[{ name: "a", paths: ["x/**"], extra: 1 }], /unknown setting/],
    ["ui", /array/],
  ])("a malformed declaration %# is a config error", (value, message) => {
    expect(() => readLayerRules(value, "structure.layers")).toThrow(message);
  });
});

describe("structure layers", () => {
  test("lists each import the rules do not allow, with the symbols across it", async () => {
    const repo = track(layersRepository());
    const run = await runStructure(repo.path, ["layers", "--json"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(ExitCode.Success);
    const document = JSON.parse(run.stdout);
    expect(document.results).toMatchObject([
      {
        id: "layer:src/data/store.ts->src/domain/rules.ts",
        fromLayer: "data",
        toLayer: "domain",
        allowed: ["data"],
        typeOnly: false,
        symbols: [{ symbol: "src/domain/rules.ts#rules", sites: 1 }],
      },
    ]);
    expectGolden("layers", "layers", run.stdout);
  });

  test("a type-only import is listed, marked, and after the value imports", async () => {
    const repo = track(layersRepository());
    repo.apply([
      {
        type: "commit",
        message: "A type import from data to ui",
        date: "2024-01-11T09:00:00Z",
        author: { name: "Alice", email: "alice@example.com" },
        changes: [
          { op: "add", path: "src/data/aaa.ts", content: 'import type { View } from "../ui/view.ts";\nexport const aaa = (v: View): number => 0;\n' },
          { op: "modify", path: "src/ui/view.ts", content: "export type View = () => number;\nexport function view(): number {\n  return 1;\n}\n" },
        ],
      },
    ]);
    const run = await runStructure(repo.path, ["layers", "--json"]);
    const rows = JSON.parse(run.stdout).results as { id: string; typeOnly: boolean }[];
    expect(rows.map((r) => [r.id, r.typeOnly])).toEqual([
      ["layer:src/data/store.ts->src/domain/rules.ts", false],
      ["layer:src/data/aaa.ts->src/ui/view.ts", true],
    ]);
  });

  test("finds nothing when no layers are configured", async () => {
    const repo = track(layersRepository({ config: {} }));
    const run = await runStructure(repo.path, ["layers", "--json"]);
    expect(JSON.parse(run.stdout).results).toEqual([]);
  });
});

describe("structure check", () => {
  test("exits 1 on a layer violation and a cycle that are new since the merge base, and ignores the existing violation", async () => {
    const repo = track(layersRepository());
    violatingBranch(repo);
    const run = await runStructure(repo.path, ["check", "--json"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(ExitCode.CheckFailed);
    const document = JSON.parse(run.stdout);
    // the folder cycle is the file cycle seen from above, and it grows the existing domain and data cycle
    expect(document.results.map((r: { id: string }) => r.id)).toEqual([
      "cycle:default:src/domain/order.ts",
      "cycle:folder:src/data",
      "layer:src/domain/order.ts->src/ui/view.ts",
    ]);
    expect(document.inputs).toMatchObject({ base: "main" });
    expectGolden("layers", "check.violations", run.stdout);
  });

  test("--level limits which cycles count", async () => {
    const repo = track(layersRepository());
    violatingBranch(repo);
    const run = await runStructure(repo.path, ["check", "--json", "--level", "package"]);
    expect(JSON.parse(run.stdout).results.map((r: { id: string }) => r.id)).toEqual(["layer:src/domain/order.ts->src/ui/view.ts"]);
  });

  test("exits 0 when the branch only adds allowed dependencies", async () => {
    const repo = track(layersRepository());
    cleanBranch(repo);
    const run = await runStructure(repo.path, ["check", "--json"]);
    expect(run.code).toBe(ExitCode.Success);
    expect(JSON.parse(run.stdout).results).toEqual([]);
  });

  test("--base compares against any revision", async () => {
    const repo = track(layersRepository());
    violatingBranch(repo);
    const head = repo.git("rev-parse", "HEAD").trim();
    const same = await runStructure(repo.path, ["check", "--json", "--base", head]);
    expect(same.code).toBe(ExitCode.Success);
    const older = await runStructure(repo.path, ["check", "--json", "--base", "main"]);
    expect(older.code).toBe(ExitCode.CheckFailed);
  });

  test("a base that is not a revision is a usage error", async () => {
    const repo = track(layersRepository());
    const run = await runStructure(repo.path, ["check", "--base", "no-such-rev"]);
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toContain("no-such-rev");
  });

  test("a repository with no main branch needs a base", async () => {
    const repo = track(layersRepository({ config: { structure: { mainBranch: "trunk" } } }));
    const run = await runStructure(repo.path, ["check"]);
    expect(run.code).toBe(ExitCode.Environment);
    expect(run.stderr).toContain("--base");
  });

  test("a file that is new on the branch counts as a new violation (file level)", async () => {
    const repo = track(layersRepository());
    repo.apply([
      { type: "branch", name: "added", from: "main" },
      { type: "checkout", name: "added" },
      {
        type: "commit",
        message: "Add a data helper that reaches up",
        date: "2024-02-02T09:00:00Z",
        changes: [{ op: "add", path: "src/data/cache.ts", content: 'import { view } from "../ui/view.ts";\nexport const cache = () => view();\n' }],
      },
    ]);
    const run = await runStructure(repo.path, ["check", "--json", "--level", "file"]);
    expect(run.code).toBe(ExitCode.CheckFailed);
    expect(JSON.parse(run.stdout).results.map((r: { id: string }) => r.id)).toEqual(["layer:src/data/cache.ts->src/ui/view.ts"]);
  });
});

describe("structure evidence for a layer violation", () => {
  test("names the rule, and the finding id of the import names the edge", async () => {
    const repo = track(layersRepository());
    const run = await runStructure(repo.path, ["evidence", "--json", "layer:src/data/store.ts->src/domain/rules.ts"]);
    expect(run.stderr).toBe("");
    const [pack] = JSON.parse(run.stdout).results;
    expect(pack).toMatchObject({
      kind: "layer-violation",
      kinds: ["layer-violation"],
      findings: ["layer:src/data/store.ts->src/domain/rules.ts"],
      layerRule: [{ fromLayer: "data", toLayer: "domain", allowed: ["data"], fileEdges: [{ from: "src/data/store.ts", to: "src/domain/rules.ts" }] }],
    });
  });

  test("a folder edge carries the rules its file imports break, and a lawful edge none", async () => {
    const repo = track(layersRepository());
    const folders = await runStructure(repo.path, ["evidence", "--json", "--level", "folder", "src/data->src/domain"]);
    expect(JSON.parse(folders.stdout).results[0]).toMatchObject({ kinds: ["cycle", "layer-violation"], layerRule: [{ fromLayer: "data", toLayer: "domain" }] });
    const lawful = await runStructure(repo.path, ["evidence", "--json", "--level", "folder", "src/ui->src/domain"]);
    expect(JSON.parse(lawful.stdout).results[0]).toMatchObject({ kind: null, layerRule: null });
  });
});
