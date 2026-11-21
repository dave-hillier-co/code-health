import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { reportPath } from "../src/reports.ts";
import { ann, engine, knowledgeHistory, view } from "./support/knowledge-scenario.ts";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 120_000 });

let repo: GitFixture;
beforeAll(() => {
  repo = knowledgeHistory();
  const touch = (path: string, content: string) => ({ op: "modify" as const, path, content });
  repo.apply([
    { type: "branch", name: "orphans", from: "main" },
    { type: "checkout", name: "orphans" },
    {
      type: "commit",
      message: "Touch the engine, whose only author has left",
      date: "2025-03-10T09:00:00Z",
      author: ann,
      changes: [touch(engine, `${readFileSync(join(repo.path, engine), "utf8")}export const more = 1;\n`)],
    },
    { type: "branch", name: "living", from: "main" },
    { type: "checkout", name: "living" },
    {
      type: "commit",
      message: "Touch the view, held by someone who is here",
      date: "2025-03-10T09:00:00Z",
      author: ann,
      changes: [touch(view, `${readFileSync(join(repo.path, view), "utf8")}export const more = 1;\n`)],
    },
  ]);
  repo.git("checkout", "--quiet", "main");
});
afterAll(() => repo.dispose());

function configure(knowledge: Record<string, unknown> | null): void {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify(knowledge === null ? {} : { cochange: { knowledge: { enabled: true, trials: 200, turnoverRate: 10, ...knowledge } } }));
}
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
  repo.git("checkout", "--quiet", "main");
});

interface Factor {
  name: string;
  status: string;
  band: string | null;
  source: string;
  value: Record<string, unknown>;
  evidence: Record<string, unknown>[];
  reason: string | null;
}
async function risk(...args: string[]) {
  const run = await runCochange(repo.path, ["risk", ...args, "--json"]);
  expect(run.code, run.stderr).toBe(ExitCode.Success);
  const document = JSON.parse(run.stdout);
  const factors: Factor[] = document.results.factors;
  return { stdout: run.stdout, factor: factors.find((f) => f.name === "abandoned-touched")!, findings: document.results.findings as { id: string; response: string; factor: string | null }[] };
}

describe("abandoned-touched", () => {
  test("is unavailable until the repository opts in to the knowledge analysis", async () => {
    configure(null);
    const { factor, findings } = await risk("main..orphans");
    expect(factor).toMatchObject({ status: "unavailable", band: null });
    expect(factor.reason).toMatch(/cochange\.knowledge\.enabled/);
    expect(findings.map((f) => f.id)).not.toContain("abandoned-touched");
  });

  test("counts touched files whose lines belong to people who have left, and names them as a finding with its response", async () => {
    configure({});
    const { factor, findings } = await risk("main..orphans");
    expect(factor).toMatchObject({ status: "ok", band: "moderate", source: "knowledge analysis" });
    expect(factor.value).toMatchObject({ count: 1, files: 1 });
    expect(factor.evidence).toEqual([expect.objectContaining({ file: engine, abandoned: true })]);
    const finding = findings.find((f) => f.id === "abandoned-touched");
    expect(finding).toMatchObject({ factor: "abandoned-touched" });
    expect(finding!.response).toMatch(/[Cc]haracterisation tests/);
  });

  test("is low, and raises no finding, when the touched files are held by people who are still here", async () => {
    configure({ turnoverRate: 0.01 });
    const { factor, findings } = await risk("main..living");
    expect(factor).toMatchObject({ status: "ok", band: "low" });
    expect(factor.value).toMatchObject({ count: 0 });
    expect(findings.map((f) => f.id)).not.toContain("abandoned-touched");
  });

  test("a file likely to become abandoned within the horizon counts, by its simulated probability", async () => {
    configure({ turnoverRate: 100, atRiskProbability: 10 });
    const { factor } = await risk("main..living");
    expect(factor.value).toMatchObject({ count: 1 });
    expect(factor.evidence[0]).toMatchObject({ file: view, abandoned: false });
    expect(Number(factor.evidence[0]!.probability)).toBeGreaterThan(0.1);
  });

  test("names no one in the output and is never stored in the report another plugin reads", async () => {
    configure({});
    const { stdout } = await risk("main..orphans");
    expect(stdout).not.toMatch(/Ann Active|Bob Builder|Cy Gone|Di Departed|Eve Newer|example\.com/);
    repo.git("checkout", "--quiet", "orphans");
    await risk();
    const stored = readFileSync(reportPath(repo.path, "risk"), "utf8");
    expect(stored).not.toContain("abandoned-touched");
    expect(stored).not.toMatch(/Cy Gone|example\.com/);
  });

  test("a change that only adds files has nothing abandoned to touch", async () => {
    configure({});
    repo.apply([
      { type: "branch", name: "fresh", from: "main" },
      { type: "checkout", name: "fresh" },
      { type: "commit", message: "Add a file", date: "2025-03-10T09:00:00Z", author: ann, changes: [{ op: "add", path: "src/new.ts", content: "export const n = 1;\n" }] },
    ]);
    const { factor } = await risk("main..fresh");
    expect(factor).toMatchObject({ status: "ok", band: "low" });
    expect(factor.value).toMatchObject({ count: 0, files: 0 });
  });
});
