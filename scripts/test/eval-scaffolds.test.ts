import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { runInProcess } from "@code-health/fixtures/cli-testing";
import { cli as complexity } from "../../packages/complexity/src/cli.ts";
import { cli as locality } from "../../packages/locality/src/cli.ts";
import { cli as structure } from "../../packages/structure/src/cli.ts";

vi.setConfig({ testTimeout: 120_000 });

const plugins = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins");
const made: string[] = [];
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** What `claude plugin eval --scaffold` does with a case's script: run it in an empty working directory. */
function scaffold(plugin: string, script = "scaffold.sh"): string {
  const dir = mkdtempSync(join(tmpdir(), `${plugin}-eval-`));
  made.push(dir);
  execFileSync("sh", [join(plugins, plugin, "evals", script)], { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  return dir;
}

const head = (dir: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
const json = async (cli: Parameters<typeof runInProcess>[0], dir: string, ...argv: string[]) =>
  JSON.parse((await runInProcess(cli, dir, [...argv, "--json", "--limit", "all"])).stdout);

describe.each(["complexity", "locality", "structure"])("the %s eval scaffold", (plugin) => {
  test("builds the same repository every time, from pinned dates", () => {
    expect(head(scaffold(plugin))).toBe(head(scaffold(plugin)));
  });

  test("leaves a clean working tree", () => {
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: scaffold(plugin), encoding: "utf8" })).toBe("");
  });
});

describe("complexity", () => {
  test("its scaffold has tests that pass, and a function over the default guidelines that ranks first", async () => {
    const dir = scaffold("complexity");
    execFileSync("npm", ["test", "--silent"], { cwd: dir, stdio: "pipe" });
    const { results } = await json(complexity, dir, "analyse");
    expect(results[0]).toMatchObject({ id: "src/ship.js#ship" });
    expect(results[0].labels).toEqual(expect.arrayContaining(["cognitive-warn", "nesting-warn"]));
  });

  test("the cases share one scaffold, not copies of it", () => {
    for (const name of ["behaviour-simplify", "trigger-hardest-functions"]) {
      expect(existsSync(join(plugins, "complexity", "evals", name, "scaffold.sh"))).toBe(false);
    }
  });

  test("the flat scaffold holds a long function that is not complex", async () => {
    const dir = mkdtempSync(join(tmpdir(), "complexity-flat-"));
    made.push(dir);
    execFileSync("sh", [join(plugins, "complexity", "evals", "flat-scaffold.sh")], { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    const { results } = await json(complexity, dir, "analyse");
    expect(results[0]).toMatchObject({ id: "src/describe.js#describe", cognitive: 0, nesting: 0 });
    expect(results[0].length).toBeGreaterThan(30);
    expect(results[0].labels).not.toContain("cognitive-warn");
  });
});

describe("locality", () => {
  test("its scaffold gives the answers the graders look for: slugify is inlined and formatMoney's two consumers get a move", async () => {
    const { results } = await json(locality, scaffold("locality"), "analyse");
    const by = (path: string) => results.find((row: { path: string }) => row.path === path);
    expect(by("src/shared/utils/slug.ts")).toMatchObject({ recommendation: "inline", rule: "single-consumer-tiny" });
    expect(by("src/shared/utils/money.ts")).toMatchObject({ recommendation: "move", rule: "two-consumers" });
    expect(by("src/shared/api.ts")).toMatchObject({ recommendation: "review", rule: "package-entry" });
  });
});

describe("structure's packaging scaffold", () => {
  const packagingScaffold = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "packaging-eval-"));
    made.push(dir);
    execFileSync("sh", [join(plugins, "structure", "evals", "packaging-scaffold.sh")], { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    return dir;
  };

  test("builds the same repository every time and leaves a clean working tree", () => {
    const dir = packagingScaffold();
    expect(head(dir)).toBe(head(packagingScaffold()));
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");
  });

  test("holds the shapes the cases ask about: ui and api change together, nothing uses the date helpers but ui, and ui and api merge without a cross-check against it", async () => {
    const dir = packagingScaffold();
    const cohesion = await json(structure, dir, "packages", "cohesion");
    const together = cohesion.results.find((f: { id: string }) => f.id === "always-together:packages/api->packages/ui");
    expect(together.evidence).toMatchObject({ shared: 15, fromChanges: 17, toChanges: 17, confidenceFromTo: 0.882 });
    const candidates = await json(structure, dir, "packages", "candidates", "--kind", "merge");
    const merge = candidates.results.find((c: { findings: string[] }) => c.findings.includes("always-together:packages/api->packages/ui"));
    expect(merge).toMatchObject({ status: "proposed", against: [] });
    const list = await json(structure, dir, "packages", "list");
    expect(list.results.map((r: { id: string; kind: string }) => [r.id, r.kind])).toEqual([
      ["packages/api", "internal"],
      ["packages/app", "internal"],
      ["packages/shared", "internal"],
      ["packages/ui", "internal"],
    ]);
  });
});

describe("structure", () => {
  test("its scaffold holds an import cycle between orders and billing, with a breaking set of one edge", async () => {
    const { results } = await json(structure, scaffold("structure"), "cycles");
    expect(results).toHaveLength(1);
    expect(results[0].breakingSet).toHaveLength(1);
    expect(results[0].nodes).toEqual(["src/billing/charge.ts", "src/orders/total.ts"]);
  });

  test("its census finds no mechanism, so any would be new", async () => {
    const { results } = await json(structure, scaffold("structure"), "census");
    expect(results.map((row: { mechanism: string; count: number }) => [row.mechanism, row.count]).filter(([, count]: [string, number]) => count > 0)).toEqual([]);
  });

  test("the events scaffold keeps the same cycle and adds an event emitter the census finds", async () => {
    const dir = scaffold("structure", "scaffold-events.sh");
    const { results: cycles } = await json(structure, dir, "cycles");
    expect(cycles).toHaveLength(1);
    const { results } = await json(structure, dir, "census");
    const events = results.find((row: { mechanism: string }) => row.mechanism === "events");
    expect(events.count).toBe(3);
    expect(events.folders.map((f: { folder: string }) => f.folder).sort()).toEqual(["src/events", "src/notifications", "src/shipping"]);
    expect(results.filter((row: { mechanism: string; count: number }) => row.mechanism !== "events" && row.count > 0)).toEqual([]);
  });

  test("the events scaffold is reproducible and leaves a clean tree", () => {
    expect(head(scaffold("structure", "scaffold-events.sh"))).toBe(head(scaffold("structure", "scaffold-events.sh")));
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: scaffold("structure", "scaffold-events.sh"), encoding: "utf8" })).toBe("");
  });
});
