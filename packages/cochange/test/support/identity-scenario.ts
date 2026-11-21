import { GitFixture, type Identity, type Step } from "@code-health/fixtures/git-fixture";

const WEEK = 7 * 24 * 3600 * 1000;
const START = Date.UTC(2024, 0, 1, 10, 0, 0);

const at = (week: number, hour = 0): string => new Date(START + week * WEEK + hour * 3600 * 1000).toISOString().replace(".000Z", "Z");

interface Spec {
  author: Identity;
  /** Weeks, each with one commit. */
  weeks: number[];
  path: string;
  committer?: Identity;
  message?: (week: number) => string;
}

export const jo1: Identity = { name: "J Park", email: "Jo@X.com" };
export const jo2: Identity = { name: "Jo Park", email: "jo+git@x.com" };
export const john1: Identity = { name: "jsmith", email: "1234+jsmith@users.noreply.github.com" };
export const john2: Identity = { name: "John Smith", email: "jsmith@users.noreply.github.com" };
export const maria1: Identity = { name: "Maria Lopez", email: "maria@corp.com" };
export const maria2: Identity = { name: "María López", email: "mlopez@gmail.com" };
export const alexA: Identity = { name: "Alex Kim", email: "alex@a.com" };
export const alexB: Identity = { name: "Alex Kim", email: "akim@b.com" };
export const samHome: Identity = { name: "Sam Ro", email: "sam@home.net" };
export const samWork: Identity = { name: "Sam Ro", email: "sam@corp.com" };
export const chris: Identity = { name: "Chris Dee", email: "chris@corp.com" };
export const dependabot: Identity = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };
export const jenkins: Identity = { name: "Jenkins", email: "jenkins@corp.com" };
export const robot: Identity = { name: "Release Robot", email: "robot@corp.com" };

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const specs: Spec[] = [
  // Strong: the same address apart from case and +tag.
  { author: jo1, weeks: range(0, 9), path: "src/api/jo-a.ts" },
  { author: jo2, weeks: range(10, 20), path: "src/api/jo-b.ts" },
  // Strong: two noreply addresses with one username.
  { author: john1, weeks: range(0, 6), path: "src/ui/john-a.ts" },
  { author: john2, weeks: range(7, 14), path: "src/ui/john-b.ts" },
  // Medium: one name written two ways, one stopping as the other starts, on one file.
  { author: maria1, weeks: range(0, 12), path: "src/billing/ledger.ts" },
  { author: maria2, weeks: range(13, 20), path: "src/billing/ledger.ts" },
  // Medium with counter-evidence: two people named Alex Kim, working at once in unrelated places.
  { author: alexA, weeks: range(2, 10), path: "app/web/alex.ts" },
  { author: alexB, weeks: range(2, 10), path: "infra/db/akim.ts" },
  // Medium plus exclusive pairing: authored at home, always committed at work.
  { author: samHome, committer: samWork, weeks: [3, 5, 7, 9], path: "src/sam/home.ts" },
  { author: samWork, weeks: [12, 13], path: "src/sam/work.ts", committer: samWork },
  // Nobody to merge with.
  { author: chris, weeks: range(0, 20), path: "src/core/chris.ts", message: (w) => (w === 20 ? "Add a thing\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" : `core ${w}`) },
  // Bots and services.
  { author: dependabot, weeks: [4, 8, 12], path: "package.json" },
  { author: jenkins, weeks: [5, 9, 13], path: "VERSION", message: (w) => `Bump version to 1.${w}.0` },
];

/** A repository with scripted identity variations, about 140 commits over 21 weeks. Ends in week 20. */
export function identityHistory(): GitFixture {
  const commits: { week: number; step: Step }[] = [];
  for (const spec of specs) {
    spec.weeks.forEach((week, n) => {
      commits.push({
        week,
        step: {
          type: "commit",
          message: spec.message?.(week) ?? `${spec.path} ${n}`,
          date: at(week, commits.length % 7),
          author: spec.author,
          ...(spec.committer ? { committer: spec.committer } : {}),
          changes: [{ op: "add" as const, path: spec.path, content: `${spec.path} ${n}\n${"x\n".repeat(n)}` }],
        },
      });
    });
  }
  // Every commit rewrites its file: the first writes it, later ones modify it.
  const seen = new Set<string>();
  const ordered = commits.sort((a, b) => Date.parse((a.step as { date: string }).date) - Date.parse((b.step as { date: string }).date));
  const steps = ordered.map(({ step }) => {
    const s = step as Extract<Step, { type: "commit" }>;
    const path = (s.changes[0] as { path: string }).path;
    const op = seen.has(path) ? "modify" : "add";
    seen.add(path);
    return { ...s, changes: [{ ...(s.changes[0] as { path: string; content: string }), op }] } as Step;
  });
  return GitFixture.build(steps);
}
