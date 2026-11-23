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
  return { stdout: run.stdout, inputs: document.inputs as Record<string, unknown>, factor: factors.find((f) => f.name === "abandoned-touched")!, findings: document.results.findings as { id: string; response: string; factor: string | null }[] };
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

  test("a file held by one active developer has the probability the turnover model gives every file, so it does not count however high that is", async () => {
    configure({ turnoverRate: 100, atRiskProbability: 10 });
    const { factor } = await risk("main..living");
    expect(factor.value).toMatchObject({ count: 0 });
    expect(Number(factor.value.baseline)).toBeGreaterThan(0.9);
    expect(factor.evidence).toEqual([]);
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

  describe("with the abandonment report", () => {
    test("reads the report of the simulation when it describes the tip of the change, and names it in the inputs", async () => {
      configure({});
      repo.git("checkout", "--quiet", "orphans");
      const computed = await risk("main..orphans");
      expect(computed.factor.source).toBe("knowledge analysis");
      expect(computed.inputs.abandonment).toBeNull();

      expect((await runCochange(repo.path, ["abandonment", "simulate"])).code).toBe(ExitCode.Success);
      const composed = await risk("main..orphans");
      expect(composed.factor).toMatchObject({ status: "ok", band: computed.factor.band, source: "abandonment report" });
      expect(composed.factor.value).toMatchObject({ count: 1 });
      expect(composed.factor.evidence).toEqual([expect.objectContaining({ file: engine, abandoned: true, probability: 1 })]);
      expect(composed.inputs.abandonment).toMatchObject({ report: "cochange.abandonment.simulate", config: expect.any(String) });
      expect(composed.stdout).not.toMatch(/Ann Active|Cy Gone|example\.com/);
    });

    test("is not read once the configuration changed, or when the run was not the configured one", async () => {
      configure({});
      repo.git("checkout", "--quiet", "orphans");
      await runCochange(repo.path, ["abandonment", "simulate", "--trials", "50"]);
      expect((await risk("main..orphans")).factor.source).toBe("knowledge analysis");

      await runCochange(repo.path, ["abandonment", "simulate"]);
      expect((await risk("main..orphans")).factor.source).toBe("abandonment report");
      configure({ trials: 300 });
      expect((await risk("main..orphans")).factor.source).toBe("knowledge analysis");
    });

    test("is not read for a change that ends elsewhere than the commit the report describes", async () => {
      configure({});
      repo.git("checkout", "--quiet", "orphans");
      await runCochange(repo.path, ["abandonment", "simulate"]);
      expect((await risk("main..living")).factor.source).toBe("knowledge analysis");
    });
  });
});
