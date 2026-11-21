import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { source } from "./coupling-scenarios.ts";

const alice: Identity = { name: "Alice", email: "alice@example.com" };

interface File {
  exports: string[];
  /** Imports before the break, and after it. */
  before?: { from: string; names: string[] }[];
}

const files: Record<string, File> = {
  "src/p/a.ts": { exports: ["pa"], before: [{ from: "../q/b.ts", names: ["x", "y", "z"] }] },
  "src/q/b.ts": { exports: ["x", "y", "z"] },
  "src/r/a.ts": { exports: ["ra"], before: [{ from: "../s/b.ts", names: ["x", "y", "z"] }] },
  "src/s/b.ts": { exports: ["x", "y", "z"] },
  "src/v/a.ts": { exports: ["va"], before: [{ from: "../w/b.ts", names: ["x", "y", "z"] }] },
  "src/w/b.ts": { exports: ["x", "y", "z"] },
};

export const BREAK_DATE = "2024-03-01T09:00:00Z";

const text = (path: string, revision: number, broken: boolean): string =>
  source(files[path]!.exports, broken ? [] : files[path]!.before, revision);

/**
 * One commit on 2024-03-01 removes three imports: p from q, r from s and v from w. Before it p and q,
 * and r and s, changed together six times and v and w never together. After it p and q still change
 * together (the dependency went somewhere the import graph cannot see), r and s change on their own,
 * and v and w still do not change together.
 */
export function outcomeRepository(): GitFixture {
  const steps: Step[] = [];
  let day = 0;
  let spacing = 2;
  const commit = (message: string, paths: string[], revision: number, broken: boolean, date?: string) => {
    day += spacing;
    const when = date ?? new Date(Date.UTC(2024, 0, 6 + day, 9)).toISOString().replace(".000Z", "Z");
    const changes: Change[] = paths.map((path) => ({ op: "modify", path, content: text(path, revision, broken) }));
    steps.push({ type: "commit", message, date: when, author: alice, changes });
  };
  steps.push({
    type: "commit",
    message: "Add the modules",
    date: "2024-01-05T09:00:00Z",
    author: alice,
    changes: Object.keys(files).map((path): Change => ({ op: "add", path, content: text(path, 1, false) })),
  });
  for (let r = 2; r <= 7; r++) commit(`Change p and q ${r}`, ["src/p/a.ts", "src/q/b.ts"], r, false);
  for (let r = 2; r <= 7; r++) commit(`Change r and s ${r}`, ["src/r/a.ts", "src/s/b.ts"], r, false);
  for (let r = 2; r <= 4; r++) commit(`Change v ${r}`, ["src/v/a.ts"], r, false);
  for (let r = 2; r <= 4; r++) commit(`Change w ${r}`, ["src/w/b.ts"], r, false);
  steps.push({
    type: "commit",
    message: "Publish events instead of importing",
    date: BREAK_DATE,
    author: alice,
    changes: ["src/p/a.ts", "src/r/a.ts", "src/v/a.ts"].map((path): Change => ({ op: "modify", path, content: text(path, 8, true) })),
  });
  day = 56;
  // the after window must be at least as long as the history before the break, or the matching windows would cut it
  spacing = 3;
  for (let r = 9; r <= 14; r++) commit(`Change p and q ${r}`, ["src/p/a.ts", "src/q/b.ts"], r, true);
  for (let r = 9; r <= 14; r++) commit(`Change r ${r}`, ["src/r/a.ts"], r, true);
  for (let r = 9; r <= 14; r++) commit(`Change s ${r}`, ["src/s/b.ts"], r, true);
  for (let r = 5; r <= 7; r++) commit(`Change v ${r}`, ["src/v/a.ts"], r, true);
  for (let r = 5; r <= 7; r++) commit(`Change w ${r}`, ["src/w/b.ts"], r, true);
  return GitFixture.build(steps);
}
