import { afterEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { runComplexity } from "./support/run.ts";

vi.setConfig({ testTimeout: 180_000 });

const fn = (name: string) => `export function ${name}(a: number): number {\n  if (a > 1) {\n    return a;\n  }\n  return 0;\n}\n`;
const js = (name: string) => `function ${name}(a) {\n  if (a > 1) {\n    return a;\n  }\n  return 0;\n}\n`;

const files: Record<string, string> = {
  "src/app.ts": fn("app"),
  "src/orders.ts": fn("orders"),
  "src/prices.ts": fn("prices"),
  "modules/encode/testdata/player.js": js("player"),
  "web/static/lib.min.js": js("lib"),
  "web/static/site.min.css": "a{color:red}\n",
  "docs/reference/generated/api.ts": fn("api"),
  "examples/hello/main.ts": fn("hello"),
  "examples/world/main.ts": fn("world"),
  "crates/core/benches/speed.ts": fn("speed"),
};

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function repo(config?: unknown): GitFixture {
  const changes: Change[] = Object.entries(files).map(([path, content]) => ({ op: "add", path, content }));
  if (config !== undefined) changes.push({ op: "add", path: "code-health.json", content: `${JSON.stringify(config)}\n` });
  const fixture = GitFixture.build([{ type: "commit", message: "add", date: "2024-03-01T10:00:00Z", changes }]);
  fixtures.push(fixture);
  return fixture;
}

async function run(fixture: GitFixture, command: string) {
  const { code, stdout, stderr } = await runComplexity(fixture.path, [command, "--json", "--limit", "all"]);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  return JSON.parse(stdout);
}

const pathsOf = (document: { results: { path: string }[] }) => [...new Set(document.results.map((row) => row.path))].sort();

test("files below testdata are tests, minified files and files below a generated folder are generated, and examples stay production with their share", async () => {
  const document = await run(repo(), "files");
  expect(pathsOf(document)).toEqual(["crates/core/benches/speed.ts", "examples/hello/main.ts", "examples/world/main.ts", "src/app.ts", "src/orders.ts", "src/prices.ts"]);
  expect(document.dropped).toEqual({ generated: 3, tests: 1 });
  expect(document.possibleNonProductionFolders).toEqual({
    productionFiles: 6,
    folders: [
      { folder: "examples", files: 2, share: 0.3333 },
      { folder: "crates/core/benches", files: 1, share: 0.1667 },
    ],
  });
});

test("analyse names the folders and their share in a notice, and still ranks their functions", async () => {
  const fixture = repo();
  const document = await run(fixture, "analyse");
  expect(pathsOf(document)).toContain("examples/hello/main.ts");
  expect(document.possibleNonProductionFolders.folders.map((entry: { folder: string }) => entry.folder)).toEqual(["examples", "crates/core/benches"]);
  const { stdout } = await runComplexity(fixture.path, ["analyse"], true);
  expect(stdout).toContain(
    "Notice: 3 of 6 production files (50.0%) are in folders that often hold examples, samples, test inputs or benchmarks: examples/ 2 (33.3%), crates/core/benches/ 1 (16.7%); they are counted as production code, and listing a folder in exclude (such as examples/**) leaves it out, and possibleNonProductionFolders in the JSON lists every folder.",
  );
});

test("testPatterns, generatedPatterns and exclude override the defaults", async () => {
  const document = await run(repo({ testPatterns: ["!**/testdata/**"], generatedPatterns: ["!*.min.js", "!generated"], exclude: ["examples/**"] }), "files");
  expect(pathsOf(document)).toEqual([
    "crates/core/benches/speed.ts",
    "docs/reference/generated/api.ts",
    "modules/encode/testdata/player.js",
    "src/app.ts",
    "src/orders.ts",
    "src/prices.ts",
    "web/static/lib.min.js",
  ]);
  expect(document.dropped).toEqual({ generated: 1, nonCode: 1 });
  expect(document.possibleNonProductionFolders.folders).toEqual([{ folder: "crates/core/benches", files: 1, share: 0.1429 }]);
});

test("generatedPatterns marks more paths generated", async () => {
  const document = await run(repo({ generatedPatterns: ["src/prices.ts"] }), "files");
  expect(pathsOf(document)).not.toContain("src/prices.ts");
  expect(document.dropped).toEqual({ generated: 4, nonCode: 1, tests: 1 });
});

test("a repository with none of the folders gets no possibleNonProductionFolders", async () => {
  const fixture = GitFixture.build([{ type: "commit", message: "add", date: "2024-03-01T10:00:00Z", changes: [{ op: "add", path: "src/app.ts", content: fn("app") }] }]);
  fixtures.push(fixture);
  expect((await run(fixture, "files")).possibleNonProductionFolders).toBeUndefined();
});
