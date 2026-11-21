import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { checkSelf } from "../check-self.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Report {
  commands: { plugin: string; command: string; exitCode: number }[];
  failures: string[];
}

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function repoWith(files: Record<string, string>): GitFixture {
  const fixture = GitFixture.build([
    {
      type: "commit",
      message: "initial",
      date: "2024-01-01T00:00:00+00:00",
      changes: Object.entries(files).map(([path, content]) => ({ op: "add" as const, path, content })),
    },
  ]);
  fixtures.push(fixture);
  return fixture;
}

const check = (repo: GitFixture): Promise<Report> => checkSelf({ root: repo.path, plugins: join(repositoryRoot, "plugins") });

const clean = {
  "src/a.ts": "import { b } from './b.ts';\nexport const a = b + 1;\n",
  "src/b.ts": "export const b = 1;\n",
};

describe("check:self", () => {
  it("runs every plugin's analysis commands and passes on a clean repository", async () => {
    const report = await check(repoWith(clean));
    expect(report.failures).toEqual([]);
    expect(report.commands.map((c) => `${c.plugin} ${c.command}`)).toEqual([
      "cochange hotspots",
      "cochange coupling",
      "complexity analyse",
      "locality analyse",
      "structure cycles",
    ]);
  }, 120_000);

  it("fails on an import cycle", async () => {
    const report = await check(
      repoWith({
        "src/a.ts": "import { b } from './b.ts';\nexport const a = () => b();\n",
        "src/b.ts": "import { a } from './a.ts';\nexport const b = () => a();\n",
      }),
    );
    expect(report.failures).toEqual([expect.stringContaining("import cycle of 2: src/a.ts, src/b.ts")]);
  }, 120_000);

  it("does not count a cycle among excluded paths", async () => {
    const report = await check(
      repoWith({
        "code-health.json": JSON.stringify({ exclude: ["legacy/**"] }),
        "legacy/a.ts": "import { b } from './b.ts';\nexport const a = () => b();\n",
        "legacy/b.ts": "import { a } from './a.ts';\nexport const b = () => a();\n",
        ...clean,
      }),
    );
    expect(report.failures).toEqual([]);
  }, 120_000);

  it("fails on a source file with syntax errors", async () => {
    const report = await check(repoWith({ ...clean, "src/broken.ts": "export const = ;\nfunction (\n" }));
    expect(report.failures).toContain("syntax errors in src/broken.ts (complexity analyse)");
    expect(report.failures).toContain("syntax errors in src/broken.ts (locality analyse)");
  }, 120_000);

  it("fails when a command exits non-zero", async () => {
    const report = await check(repoWith({ ...clean, "code-health.json": "{ not json" }));
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures[0]).toMatch(/^cochange hotspots exited 2/);
  }, 120_000);
});
