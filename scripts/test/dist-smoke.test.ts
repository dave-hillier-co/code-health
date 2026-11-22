import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { adapterSamples } from "@code-health/fixtures/language-samples";
import { api, signatureHistory } from "../../packages/cochange/test/support/composition-scenario.ts";
import { adoptionHistory } from "../../packages/cochange/test/support/adoption-scenario.ts";
import { knowledgeHistory } from "../../packages/cochange/test/support/knowledge-scenario.ts";
import { invoice, outcomeHistory } from "../../packages/cochange/test/support/outcome-scenario.ts";
import { buildOutcomeRepo } from "../../packages/complexity/test/support/outcome-scenario.ts";
import { relocationApp } from "../../packages/locality/test/support/measure-scenarios.ts";
import { distantHelpers } from "../../packages/locality/test/support/scenarios.ts";
import { leadingRepository } from "../../packages/structure/test/support/leading-scenarios.ts";
import { incidentalRepository } from "../../packages/structure/test/support/incidental-scenarios.ts";
import { manifestsRepository } from "../../packages/structure/test/packaging/support/scenarios.ts";
import { cyclesRepository } from "../../packages/structure/test/support/scenarios.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The committed bundles, installed as a plugin is: a copy with no node_modules beside it. A module that the
 * bundle left out, or a grammar or ts-morph that fails to load, breaks here and not in the source tests.
 */
let installed: string;
const fixtures: GitFixture[] = [];
beforeAll(() => {
  installed = mkdtempSync(join(tmpdir(), "dist-smoke-"));
  for (const plugin of ["cochange", "complexity", "locality", "structure"]) cpSync(join(root, "plugins", plugin, "dist"), join(installed, plugin, "dist"), { recursive: true });
});
afterAll(() => {
  rmSync(installed, { recursive: true, force: true });
  for (const fixture of fixtures) fixture.dispose();
});

function run(plugin: string, cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [join(installed, plugin, "dist", `${plugin}.mjs`), ...args, "--json"], { cwd, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, document: result.stdout === "" ? undefined : JSON.parse(result.stdout) };
}

const fixture = (make: () => GitFixture): GitFixture => {
  const made = make();
  fixtures.push(made);
  return made;
};

describe("every plugin's installed bundle runs its newest commands", () => {
  test("cochange: blame refresh and risk explain", () => {
    const repo = fixture(distantHelpers);
    expect(run("cochange", repo.path, ["blame", "refresh"])).toMatchObject({ status: 0, stderr: "", document: { command: "blame" } });
    expect(run("cochange", repo.path, ["risk", "explain"])).toMatchObject({ status: 0, document: { command: "risk" } });
  });

  test("locality: a move dry run, which loads ts-morph from the bundle", () => {
    const repo = fixture(distantHelpers);
    const { status, document } = run("locality", repo.path, ["move", "src/shared/utils/money.ts"]);
    expect(status).toBe(0);
    expect(document).toMatchObject({ command: "move", applied: false, mode: "dry-run" });
  });

  test("structure: the census and the package list", () => {
    expect(run("structure", fixture(cyclesRepository).path, ["census"])).toMatchObject({ status: 0, document: { command: "census" } });
    expect(run("structure", fixture(manifestsRepository).path, ["packages", "list"])).toMatchObject({ status: 0, document: { command: "packages" } });
  });

  test("complexity: analyse, which loads the grammars from the bundle's folder", () => {
    expect(run("complexity", fixture(distantHelpers).path, ["analyse"])).toMatchObject({ status: 0, stderr: "", document: { command: "analyse" } });
  });
});

describe("every plugin's installed bundle runs the commands of the outcome and risk work", () => {
  const sessions = () => mkdtempSync(join(tmpdir(), "dist-smoke-sessions-"));

  test("cochange: risk loads the on-demand parse chunk and names its evidence as from parse", () => {
    const repo = fixture(signatureHistory);
    const { status, stderr, document } = run("cochange", repo.path, ["risk", "main..signature"]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    const blast = document.results.factors.find((factor: { name: string }) => factor.name === "blast-radius");
    expect(blast.evidence).toContainEqual(expect.objectContaining({ file: api, change: "signature", from: "parse" }));
  });

  test("cochange: outcome spread and completeness, and the abandonment trend, redundancy and adoption instruments", () => {
    const repo = fixture(outcomeHistory);
    const projects = sessions();
    try {
      expect(run("cochange", repo.path, ["outcome", "spread", "--at", "2024-04-01", invoice])).toMatchObject({ status: 0, stderr: "", document: { command: "outcome" } });
      expect(run("cochange", repo.path, ["outcome", "completeness", "--since", "2024-03-01", "--until", "2024-04-01", "--projects-dir", projects])).toMatchObject({
        status: 0,
        stderr: "",
        document: { command: "outcome", inputs: { subcommand: "completeness" } },
      });
    } finally {
      rmSync(projects, { recursive: true, force: true });
    }
    const knowledge = fixture(knowledgeHistory);
    writeFileSync(join(knowledge.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true } } }));
    for (const subcommand of ["trend", "redundancy"]) {
      expect(run("cochange", knowledge.path, ["abandonment", subcommand]), subcommand).toMatchObject({ status: 0, stderr: "", document: { command: "abandonment" } });
    }
    const adoption = fixture(adoptionHistory);
    writeFileSync(join(adoption.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true } } }));
    expect(run("cochange", adoption.path, ["abandonment", "adoption", "--at", "2025-02-28", "--horizon", "1"])).toMatchObject({ status: 0, stderr: "", document: { command: "abandonment" } });
  });

  test("complexity: outcome of a simplification", () => {
    const repo = fixture(buildOutcomeRepo);
    const sha = repo.git("log", "--format=%H", "--grep=Flatten hot").trim();
    const projects = sessions();
    try {
      expect(run("complexity", repo.path, ["outcome", sha, "--projects-dir", projects])).toMatchObject({ status: 0, stderr: "", document: { command: "outcome" } });
    } finally {
      rmSync(projects, { recursive: true, force: true });
    }
  });

  test("structure: incidental coupling, and the outcome of a break", () => {
    const projects = sessions();
    try {
      expect(run("structure", fixture(incidentalRepository).path, ["coupling", "--quadrant", "incidental", "--projects-dir", projects])).toMatchObject({ status: 0, stderr: "", document: { command: "coupling" } });
      const leading = fixture(leadingRepository);
      const sha = leading.git("log", "--format=%H", "--grep=Stop the store").trim();
      expect(run("structure", leading.path, ["outcome", "--at", sha, "src/data->src/ui", "--projects-dir", projects])).toMatchObject({ status: 0, stderr: "", document: { command: "outcome" } });
    } finally {
      rmSync(projects, { recursive: true, force: true });
    }
  });

  test("locality: the premise check", () => {
    const projects = sessions();
    try {
      expect(run("locality", fixture(relocationApp).path, ["measure", "premise", "--projects-dir", projects])).toMatchObject({ status: 0, stderr: "", document: { command: "measure" } });
    } finally {
      rmSync(projects, { recursive: true, force: true });
    }
  });
});

describe("every plugin's installed bundle reads a file of each supported language", () => {
  test.each(Object.entries(adapterSamples))("%s: complexity measures its function and structure reads its census", (_id, sample) => {
    const repo = fixture(() => GitFixture.build([{ type: "commit", message: "one", date: "2024-01-01T00:00:00Z", changes: [{ op: "add", path: sample.path, content: sample.source }] }]));
    const measured = run("complexity", repo.path, ["analyse", "--layer", "structural"]);
    expect(measured).toMatchObject({ status: 0, stderr: "", document: { command: "analyse" } });
    expect(JSON.stringify(measured.document)).toContain(`${sample.path}#${sample.unit}`);
    expect(run("structure", repo.path, ["census"])).toMatchObject({ status: 0, stderr: "", document: { command: "census" } });
  });
});
