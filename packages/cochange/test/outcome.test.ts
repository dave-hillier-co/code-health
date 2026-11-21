import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { AgentSessions, invoice, invoiceTest, order, orderTest, outcomeHistory, pageA, pageB, tax } from "./support/outcome-scenario.ts";
import { reportPath } from "../src/reports.ts";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 60_000 });

let repo: GitFixture;
beforeAll(() => {
  repo = outcomeHistory();
});
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  writeFileSync(join(repo.path, "code-health.json"), "{}\n");
  repo.git("checkout", "--quiet", "--", ".");
});

const outcome = (...args: string[]) => runCochange(repo.path, ["outcome", ...args]);
const json = async (...args: string[]) => {
  const { code, stdout, stderr } = await outcome(...args);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  return JSON.parse(stdout);
};

describe("outcome spread", () => {
  const args = ["spread", "--at", "2024-04-01", "--min-samples", "4", invoice];

  test("sets the acted-on file beside the untouched file of nearest rank, and reports the difference of the changes, by hand", async () => {
    const document = await json(...args);
    const { results } = document;
    expect(results.windows).toEqual({
      before: { since: "2024-01-01", until: "2024-04-01" },
      after: { since: "2024-04-01", until: "2024-07-01", complete: true },
    });
    // The invoice's test shares its changes, so the order, with the same four revisions, is the control.
    expect(results.comparison.files).toEqual([order]);
    expect(results.comparison.pairs).toEqual([{ actedOn: { path: invoice, revisions: 4 }, comparison: { path: order, revisions: 4 } }]);
    expect(results.comparison.overlapping).toBe(1);
    // Before: four changes of the invoice with its distant test, distance 2 + 2 = 4. After: with the tax module beside it, 0.
    expect(results.actedOn.before.spread).toEqual({ measured: 4, mean: 4 });
    expect(results.actedOn.after.spread).toEqual({ measured: 4, mean: 0 });
    expect(results.comparison.before.spread).toEqual({ measured: 4, mean: 4 });
    expect(results.comparison.after.spread).toEqual({ measured: 4, mean: 4 });
    expect(results.spread).toMatchObject({ role: "primary outcome", actedOn: { change: -4 }, comparison: { change: 0 }, difference: -4, smallestSample: 4, conclusion: "lower" });
  });

  test("revisions per file are the secondary outcome, and one file is too small a sample to conclude from", async () => {
    const { results } = await json(...args);
    expect(results.actedOn.before.revisions).toEqual({ changes: 4, files: 1, perFile: 4 });
    expect(results.actedOn.after.revisions).toEqual({ changes: 4, files: 1, perFile: 4 });
    expect(results.revisions).toMatchObject({ role: "secondary outcome", difference: 0, conclusion: "insufficient-sample" });
  });

  test("a sample under the minimum is not concluded from", async () => {
    const { results } = await json("spread", "--at", "2024-04-01", invoice);
    expect(results.spread).toMatchObject({ difference: -4, conclusion: "insufficient-sample" });
  });

  test("a window that runs past the analysed commit says it is incomplete", async () => {
    const { results } = await json("spread", "--at", "2024-04-01", "--months", "4", "--min-samples", "4", invoice);
    expect(results.windows.after).toEqual({ since: "2024-04-01", until: "2024-07-05", complete: false });
    expect(results.windows.before.since).toBe("2023-12-01");
  });

  test("the output matches its golden, byte for byte", async () => {
    expectGolden("outcome", "outcome.spread", (await outcome(...args)).stdout);
  });

  test("it needs files and a date, and refuses a file that is gone", async () => {
    expect((await outcome("spread", "--at", "2024-04-01")).code).toBe(ExitCode.Usage);
    expect((await outcome("spread", invoice)).stderr).toContain("--at");
    const missing = await outcome("spread", "--at", "2024-04-01", "src/none.ts");
    expect(missing.code).toBe(ExitCode.Usage);
    expect(missing.stderr).toContain("not a file");
  });

  test("it never stores a report", async () => {
    await outcome(...args);
    expect(existsSync(reportPath(repo.path, "outcome"))).toBe(false);
    expect(existsSync(reportPath(repo.path, "outcome.spread"))).toBe(false);
  });
});

describe("outcome completeness", () => {
  let sessions: AgentSessions;
  beforeAll(() => {
    sessions = new AgentSessions(repo.path);
  });
  // The hook's session state lives in the cache, which the outer beforeEach clears.
  beforeEach(() => {
    // With the hook, which spoke about the page in the first session only.
    sessions.session("hook-1", "2026-03-02", [pageA, pageB], { spoke: [pageA] });
    sessions.session("hook-2", "2026-03-03", [pageA], { spoke: [] });
    // Without it.
    sessions.session("plain-1", "2026-03-04", [pageA, tax, pageB]);
    sessions.session("plain-2", "2026-03-05", [pageB]);
    sessions.session("plain-3", "2026-03-06", [pageA, pageA]);
    // Outside the window, and a file with no partner.
    sessions.session("plain-late", "2026-05-01", [pageA]);
    sessions.session("plain-solo", "2026-03-07", [tax]);
  });
  afterAll(() => sessions.dispose());

  const args = () => ["completeness", "--since", "2026-03-01", "--until", "2026-04-01", "--projects-dir", sessions.directory, "--min-samples", "2"];

  test("counts edits followed by a coupled file later in the session, with and without the hook, by hand", async () => {
    const { results } = await json(...args());
    // The pages changed together six times (confidence 100). A page's first edit is an opportunity when its partner is not yet edited.
    expect(results.sessions).toEqual({ measured: 6, withHook: 2, withoutHook: 4 });
    // hook-1: page A, partner B follows. B comes second and A is already edited. hook-2: A alone.
    expect(results.withHook).toMatchObject({ sessions: 2, opportunities: 2, followed: 1, rate: 0.5 });
    expect(results.withHook.briefed).toMatchObject({ opportunities: 1, followed: 1, rate: 1 });
    expect(results.withHook.notBriefed).toMatchObject({ opportunities: 1, followed: 0, rate: 0 });
    // The tax module changed with the invoice in the initial commit and four times since: five changes, so it has a partner too.
    // plain-1: A (B follows) and tax (the invoice does not). plain-2: B alone. plain-3: A twice, one opportunity. plain-solo: tax alone.
    expect(results.withoutHook).toMatchObject({ sessions: 4, opportunities: 5, followed: 1, rate: 0.2 });
    expect(results.difference).toBeCloseTo(0.3, 5);
    expect(results.smallestSample).toBe(2);
    expect(results.conclusion).toBe("higher");
    expect(results.caveat).toContain("not assigned");
  });

  test("names the sessions it read in its inputs, so a different session folder is a different input", async () => {
    const { inputs } = await json(...args());
    expect(inputs.transcriptStamp).toMatch(/^[0-9a-f]{16}$/);
    const other = new AgentSessions(repo.path);
    try {
      other.session("only", "2026-03-02", [pageA]);
      const { inputs: otherInputs } = await json(...args().map((a) => (a === sessions.directory ? other.directory : a)));
      expect(otherInputs.transcriptStamp).not.toBe(inputs.transcriptStamp);
    } finally {
      other.dispose();
    }
  });

  test("with too few opportunities in an arm nothing is concluded", async () => {
    const { results } = await json(...args().slice(0, -2));
    expect(results.conclusion).toBe("insufficient-sample");
  });

  test("the output has paths and counts, never what was said, and matches its golden", async () => {
    const { stdout } = await outcome(...args());
    expect(stdout).not.toContain("synthetic");
    expect(stdout).not.toContain(sessions.directory);
    expectGolden("outcome", "outcome.completeness", stdout);
  });

  test("a window without sessions is not measured, not zero", async () => {
    const { results } = await json("completeness", "--since", "2030-01-01", "--until", "2030-02-01", "--projects-dir", sessions.directory);
    expect(results.sessions.measured).toBe(0);
    expect(results.conclusion).toBe("not-measured");
    expect(results.withHook.rate).toBeNull();
  });

  test("it needs a window", async () => {
    expect((await outcome("completeness", "--projects-dir", sessions.directory)).code).toBe(ExitCode.Usage);
    expect((await outcome("completeness", "--since", "2026-04-01", "--until", "2026-03-01")).code).toBe(ExitCode.Usage);
  });

  test("options belong to their subcommand", async () => {
    const wrong = await outcome("completeness", "--since", "2026-03-01", "--until", "2026-04-01", "--at", "2024-04-01");
    expect(wrong.code).toBe(ExitCode.Usage);
    expect(wrong.stderr).toContain("--at belongs to outcome spread");
    expect((await outcome("nonsense")).code).toBe(ExitCode.Usage);
  });
});
