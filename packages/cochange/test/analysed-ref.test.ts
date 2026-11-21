import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";

const content = (version: number) =>
  [...Array.from({ length: 9 }, (_, i) => `export const step${i} = ${i};`), `export const value = ${version};`, ""].join("\n");

/** main is checked out, and the configured branch `feature` is one commit ahead of it. */
let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([
    { type: "commit", message: "start", date: "2024-01-01T09:00:00Z", changes: [{ op: "add", path: "src/a.ts", content: content(1) }] },
    { type: "branch", name: "feature" },
    { type: "checkout", name: "feature" },
    { type: "commit", message: "feature work", date: "2024-02-01T09:00:00Z", changes: [{ op: "modify", path: "src/a.ts", content: content(2) }] },
    { type: "checkout", name: "main" },
  ]);
});
afterAll(() => repo.dispose());

const reports = () => join(repo.path, ".cache", "code-health", "reports");

beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"branch":"feature"}}\n');
  repo.git("checkout", "--quiet", "--", ".");
});

test("a report is never stored for a branch other than HEAD, since it would be stamped with the wrong commit", async () => {
  const { code } = await runCochange(repo.path, ["age", "--json"]);
  expect(code).toBe(0);
  expect(existsSync(join(reports(), "cochange.age.json"))).toBe(false);
});

test("without a configured branch the report is stored as before", async () => {
  rmSync(join(repo.path, "code-health.json"));
  await runCochange(repo.path, ["age", "--json"]);
  expect(existsSync(join(reports(), "cochange.age.json"))).toBe(true);
});

test("a complexity report stamped with HEAD is not used for a different analysed commit", async () => {
  mkdirSync(reports(), { recursive: true });
  const head = repo.git("rev-parse", "HEAD").trim();
  const document = {
    schemaVersion: 1,
    tool: "complexity",
    command: "files",
    repo: { head, dirty: false },
    config: "0".repeat(16),
    results: [{ path: "src/a.ts", complexity: 90 }],
  };
  writeFileSync(join(reports(), "complexity.files.json"), JSON.stringify(document));
  const { stdout } = await runCochange(repo.path, ["hotspots", "--json"]);
  expect(JSON.parse(stdout).complexitySource).toBe("indentation");
});
