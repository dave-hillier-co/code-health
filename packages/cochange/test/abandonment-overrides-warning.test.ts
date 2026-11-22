import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { auth, knowledgeHistory } from "./support/knowledge-scenario.ts";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 120_000 });

let repo: GitFixture;
beforeAll(() => {
  repo = knowledgeHistory();
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true, trials: 100, turnoverRate: 10 } } }));
});
afterAll(() => repo.dispose());
beforeEach(() => {
  repo.git("rm", "--cached", "-r", "--ignore-unmatch", "-q", ".code-health");
  rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
});

const localDir = () => join(repo.path, ".code-health", "local");
function writeOverrides(): void {
  mkdirSync(localDir(), { recursive: true });
  writeFileSync(join(localDir(), "knowledge-overrides.json"), JSON.stringify({ schemaVersion: 1, active: [], inactive: [] }));
}
const filesInLocal = () => readdirSync(localDir()).sort();

/** The warning goes to the process's stderr, which the in-process runner does not capture, so it is read from a spy. */
let written: string[] = [];
beforeEach(() => {
  written = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());
const warnings = () => written.join("");

const everyCommand = [["abandonment", "current"], ["abandonment", "turnover"], ["abandonment", "simulate"], ["successors", auth]];

test("an overrides file that git does not ignore is warned about on stderr by every abandonment command, and nothing is written", async () => {
  writeOverrides();
  const before = filesInLocal();
  for (const argv of everyCommand) {
    written = [];
    const { code } = await runCochange(repo.path, argv);
    expect(code, argv.join(" ")).toBe(ExitCode.Success);
    expect(warnings(), argv.join(" ")).toContain("knowledge-overrides.json is not ignored by git");
  }
  expect(filesInLocal()).toEqual(before);
});

test("a tracked overrides file is warned about even when it is ignored", async () => {
  writeOverrides();
  writeFileSync(join(localDir(), ".gitignore"), "*\n");
  repo.git("add", "-f", ".code-health/local/knowledge-overrides.json");
  await runCochange(repo.path, ["abandonment", "current"]);
  expect(warnings()).toContain("knowledge-overrides.json is tracked by git");
});

test("an ignored, untracked overrides file and an absent one print no warning", async () => {
  writeOverrides();
  writeFileSync(join(localDir(), ".gitignore"), "*\n");
  await runCochange(repo.path, ["abandonment", "current"]);
  expect(warnings()).toBe("");
  rmSync(join(localDir(), "knowledge-overrides.json"));
  await runCochange(repo.path, ["abandonment", "current"]);
  expect(warnings()).toBe("");
});
