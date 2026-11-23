import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import type { ReportBuild } from "@code-health/report/report-model";
import { cachedBuild } from "../src/report-build-cache.ts";
import { readRepoState } from "../src/repo-state.ts";
import type { CommandContext } from "../src/run-cli.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixture(): GitFixture {
  const repo = GitFixture.build([{ type: "commit", message: "first", date: "2024-01-01T10:00:00+00:00", changes: [{ op: "add", path: "src/a.ts", content: "a\n" }] }]);
  cleanups.push(() => repo.dispose());
  return repo;
}

function contextOf(repo: GitFixture, over: { positionals?: string[]; values?: Record<string, unknown>; config?: string } = {}): CommandContext {
  return {
    cwd: repo.path,
    repo: readRepoState(repo.path),
    config: { hash: over.config ?? "config-1" },
    positionals: over.positionals ?? [],
    values: over.values ?? {},
  } as unknown as CommandContext;
}

/** A build whose title counts how many times it was computed. */
function counter() {
  let computed = 0;
  return {
    get computed() {
      return computed;
    },
    compute: async (): Promise<ReportBuild> => {
      computed++;
      return { title: `build ${computed}`, inputs: {}, header: { evidenceGrade: "weak", historyWindow: "w", excluded: [] }, sections: [], limits: [], slots: [] };
    },
  };
}

const run = (context: CommandContext, c: ReturnType<typeof counter>, dependsOn?: () => unknown) => cachedBuild(context, "demo", dependsOn, c.compute);

test("the second run reads the stored build instead of computing it again", async () => {
  const repo = fixture();
  const c = counter();
  const first = await run(contextOf(repo), c);
  const second = await run(contextOf(repo, { values: { notes: "n.json", format: "html", out: "r.html" } }), c);
  expect(c.computed).toBe(1);
  expect(second).toEqual(first);
});

test("--no-cache computes again and stores the new build", async () => {
  const repo = fixture();
  const c = counter();
  await run(contextOf(repo), c);
  expect((await run(contextOf(repo, { values: { "no-cache": true } }), c)).title).toBe("build 2");
  expect((await run(contextOf(repo), c)).title).toBe("build 2");
  expect(c.computed).toBe(2);
});

test("another argument, option value or config hash is another build", async () => {
  const repo = fixture();
  const c = counter();
  await run(contextOf(repo), c);
  await run(contextOf(repo, { positionals: ["x"] }), c);
  await run(contextOf(repo, { values: { top: "5" } }), c);
  expect(c.computed).toBe(3);
  await run(contextOf(repo, { config: "config-2" }), c);
  expect(c.computed).toBe(4);
  await run(contextOf(repo, { config: "config-2" }), c);
  expect(c.computed).toBe(4);
});

test("a new commit computes again", async () => {
  const repo = fixture();
  const c = counter();
  await run(contextOf(repo), c);
  writeFileSync(join(repo.path, "src", "b.ts"), "b\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "second");
  await run(contextOf(repo), c);
  expect(c.computed).toBe(2);
});

test("a changed stored result, identity file or shallow file computes again", async () => {
  const repo = fixture();
  const c = counter();
  const stored = join(repo.path, ".cache", "code-health", "reports");
  mkdirSync(stored, { recursive: true });
  writeFileSync(join(repo.path, ".cache", "code-health", ".gitignore"), "*\n");
  await run(contextOf(repo), c);
  writeFileSync(join(stored, "complexity.analyse.json"), "{}");
  await run(contextOf(repo), c);
  expect(c.computed).toBe(2);
  await run(contextOf(repo), c);
  expect(c.computed).toBe(2);
  writeFileSync(join(repo.path, ".mailmap"), "A <a@x> <b@x>\n");
  repo.git("add", ".mailmap");
  repo.git("commit", "-q", "-m", "mailmap");
  await run(contextOf(repo), c);
  expect(c.computed).toBe(3);
});

test("a stored result that is rewritten after the build changes the next run", async () => {
  const repo = fixture();
  const c = counter();
  await run(contextOf(repo), c);
  const stored = join(repo.path, ".cache", "code-health", "reports");
  mkdirSync(stored, { recursive: true });
  writeFileSync(join(stored, "structure.cycles.json"), "[]");
  await run(contextOf(repo), c);
  expect(c.computed).toBe(2);
});

test("uncommitted work neither reads nor stores a build", async () => {
  const repo = fixture();
  const c = counter();
  await run(contextOf(repo), c);
  writeFileSync(join(repo.path, "src", "a.ts"), "edited\n");
  await run(contextOf(repo), c);
  await run(contextOf(repo), c);
  expect(c.computed).toBe(3);
  repo.git("checkout", "--", "src/a.ts");
  writeFileSync(join(repo.path, "src", "new.ts"), "new\n");
  await run(contextOf(repo), c);
  expect(c.computed).toBe(4);
});

test("the notes and the output file the agent writes do not count as uncommitted work", async () => {
  const repo = fixture();
  const c = counter();
  await run(contextOf(repo), c);
  writeFileSync(join(repo.path, "notes.json"), "{}");
  writeFileSync(join(repo.path, "report.html"), "x");
  await run(contextOf(repo, { values: { notes: "notes.json", format: "html", out: "report.html" } }), c);
  expect(c.computed).toBe(1);
  writeFileSync(join(repo.path, "other.json"), "{}");
  await run(contextOf(repo, { values: { notes: "notes.json" } }), c);
  expect(c.computed).toBe(2);
});

test("what the kind says it depends on is part of the key", async () => {
  const repo = fixture();
  const c = counter();
  await run(contextOf(repo), c, () => ({ base: "a" }));
  await run(contextOf(repo), c, () => ({ base: "a" }));
  expect(c.computed).toBe(1);
  await run(contextOf(repo), c, () => ({ base: "b" }));
  expect(c.computed).toBe(2);
});
