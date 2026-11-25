import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { auth, engine, knowledgeHistory, lexer, log, routes } from "./support/knowledge-scenario.ts";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 120_000 });

let repo: GitFixture;
beforeAll(() => {
  repo = knowledgeHistory();
});
afterAll(() => repo.dispose());

function configure(knowledge: Record<string, unknown> = {}): void {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true, ...knowledge } } }));
}
beforeEach(() => {
  rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
  configure();
});

const successors = (...args: string[]) => runCochange(repo.path, ["successors", ...args]);
const json = async (...args: string[]) => {
  const { code, stdout, stderr } = await successors(...args);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  return JSON.parse(stdout);
};
type Row = { path: string; successors: { rank: number; score: number; coupledChanges: number; ownShare: number; developer?: string; evidence: unknown[] }[]; [key: string]: unknown };
const rowOf = (document: { results: Row[] }, path: string): Row => document.results.find((r) => r.path === path)!;

test("successors are ranked by the changes they made to coupled files, weighted by the coupling, plus their own lines, by hand", async () => {
  const document = await json(auth);
  const row = rowOf(document, auth);
  // Auth changes with routes in all six of its changes (degree 100, support 6). Ann made four of them and holds
  // all ten of auth's lines: 4 x 1.0 + 1.0. Bob made two and holds none: 2 x 1.0. Eve touched neither.
  expect(row.coupledFiles).toEqual([{ path: routes, degree: 100, support: 6 }]);
  expect(row.candidates).toBe(2);
  expect(row.noSuccessor).toBe(false);
  expect(row.successors).toEqual([
    { rank: 1, score: 5, coupledChanges: 4, ownShare: 1, evidence: [{ path: routes, degree: 100, changes: 4 }] },
    { rank: 2, score: 2, coupledChanges: 2, ownShare: 0, evidence: [{ path: routes, degree: 100, changes: 2 }] },
  ]);
});

test("without --names a successor is a rank and never an identity", async () => {
  const { stdout } = await successors(auth, routes);
  for (const hidden of ["example.com", "Ann", "Bob", "Cy", "Di ", "Eve", "\"developer\""]) expect(stdout).not.toContain(hidden);
  expectGolden("abandonment", "successors", stdout);
});

test("--names shows the active developers who could pick the file up, and only them", async () => {
  const document = await json(auth, routes, engine, lexer, "--names");
  expect(rowOf(document, auth).successors.map((s) => s.developer)).toEqual(["Ann Active", "Bob Builder"]);
  // Routes: Ann 4 x 1.0 + her half of the lines, Bob 2 x 1.0 + his.
  expect(rowOf(document, routes).successors.map((s) => [s.developer, s.score])).toEqual([
    ["Ann Active", 4.5],
    ["Bob Builder", 2.5],
  ]);
  // The lexer is Di's, who has left, and Bob's two lines: only Bob can be named.
  expect(rowOf(document, lexer).successors.map((s) => s.developer)).toEqual(["Bob Builder"]);
  // The engine is all Cy's: nobody active holds a line, and Cy is never listed.
  expect(rowOf(document, engine)).toMatchObject({ abandoned: true, candidates: 0, noSuccessor: true, successors: [] });
  const text = JSON.stringify(document);
  for (const leaver of ["Cy Gone", "Di Departed", "cy@example.com", "di@example.com", "Eve Newer"]) expect(text).not.toContain(leaver);
  expect(document.inputs.names).toBe(true);
});

test("a file with no coupled files still has a successor in the active developer who holds its lines", async () => {
  const row = rowOf(await json(log), log);
  expect(row).toMatchObject({ coupledFiles: [], noSuccessor: false, candidates: 1 });
  expect(row.successors).toEqual([{ rank: 1, score: 1, coupledChanges: 0, ownShare: 1, evidence: [] }]);
});

test("an override that returns someone to the active makes them a candidate, and one that removes them does not", async () => {
  const dir = join(repo.path, ".code-health", "local");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "knowledge-overrides.json"), JSON.stringify({ schemaVersion: 1, active: ["Cy Gone <cy@example.com>"], inactive: ["Bob Builder <bob@example.com>"] }));
  const document = await json(engine, auth, "--names");
  expect(rowOf(document, engine).successors.map((s) => s.developer)).toEqual(["Cy Gone"]);
  expect(rowOf(document, auth).successors.map((s) => s.developer)).toEqual(["Ann Active"]);
});

test("--top limits the successors per file, and candidates counts them all", async () => {
  const row = rowOf(await json(auth, "--top", "1"), auth);
  expect(row.successors).toHaveLength(1);
  expect(row.candidates).toBe(2);
});

test("a file that is not there, or no file at all, or no opt-in, is refused", async () => {
  expect((await successors("src/nowhere.ts")).code).toBe(ExitCode.Usage);
  expect((await successors()).code).toBe(ExitCode.Usage);
  writeFileSync(join(repo.path, "code-health.json"), "{}");
  const off = await successors(auth, "--names");
  expect(off.code).toBe(ExitCode.Usage);
  expect(off.stdout).toBe("");
  expect(off.stderr).toContain("cochange.knowledge.enabled");
});
