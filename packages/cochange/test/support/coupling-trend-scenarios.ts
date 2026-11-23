import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const bob: Identity = { name: "Bob", email: "bob@example.com" };

/** Enough stable lines that git still sees a rename when one line changes. */
function source(name: string, version: number): string {
  const body = Array.from({ length: 9 }, (_, i) => `export const ${name}Step${i} = ${i};`);
  return [...body, `export const ${name} = ${version};`, ""].join("\n");
}

interface Counts {
  together: number;
  aloneX: number;
  aloneY: number;
}

interface Pair {
  x: string;
  y: string;
  /** Changes that touch both files, and changes that touch only one of them, in each window. */
  before: Counts;
  after: Counts;
}

/** The earlier window is 2024, the later one 2025, and the analysed commit is 2025-12-31. */
const pairs: Pair[] = [
  // Degree 20 then 80: stronger by 60 points.
  { x: "src/api/orders.ts", y: "src/web/orders-view.ts", before: { together: 2, aloneX: 8, aloneY: 8 }, after: { together: 8, aloneX: 2, aloneY: 2 } },
  // Degree 60 then 70: stable at exactly the 10 point tolerance.
  { x: "src/billing/ledger.ts", y: "src/billing/ledger.test.ts", before: { together: 6, aloneX: 4, aloneY: 4 }, after: { together: 7, aloneX: 3, aloneY: 3 } },
  // Degree 90 then 50: weaker by 40 points.
  { x: "src/config/flags.ts", y: "src/runtime/flags.ts", before: { together: 9, aloneX: 1, aloneY: 1 }, after: { together: 5, aloneX: 5, aloneY: 5 } },
  // Never together before: degree 0 then 100.
  { x: "src/search/index.ts", y: "src/search/ranking.ts", before: { together: 0, aloneX: 3, aloneY: 0 }, after: { together: 5, aloneX: 0, aloneY: 0 } },
];

/**
 * Two years of history, ending 2025-12-31, with four pairs whose coupling moves differently between 2024 and 2025
 * (see `pairs`). With the default 12 month window the current window is 2025 and the previous one is 2024.
 */
export function couplingTrendHistory(): GitFixture {
  const versions = new Map<string, number>();
  const exists = new Set<string>();
  const bump = (path: string): Change => {
    const version = (versions.get(path) ?? 0) + 1;
    versions.set(path, version);
    const content = source(path.replace(/\W/g, ""), version);
    if (!exists.has(path)) {
      exists.add(path);
      return { op: "add", path, content };
    }
    return { op: "modify", path, content };
  };

  const steps: Step[] = [];
  const commit = (message: string, date: Date, changes: Change[], author: Identity) =>
    steps.push({ type: "commit", message, date: date.toISOString(), author, changes });
  const day = 24 * 3600 * 1000;

  for (const [start, key] of [[Date.UTC(2024, 1, 1, 9), "before"], [Date.UTC(2025, 0, 15, 9), "after"]] as const) {
    let n = 0;
    for (const pair of pairs) {
      const counts = pair[key];
      const plan: string[][] = [
        ...Array.from({ length: counts.together }, () => [pair.x, pair.y]),
        ...Array.from({ length: counts.aloneX }, () => [pair.x]),
        ...Array.from({ length: counts.aloneY }, () => [pair.y]),
      ];
      for (const files of plan) {
        commit(`Change ${files.join(" and ")} ${n}`, new Date(start + 2 * day * n), files.map(bump), n % 2 === 0 ? alice : bob);
        n++;
      }
    }
  }
  commit("Release", new Date(Date.UTC(2025, 11, 31, 9)), [bump("docs/release.ts")], alice);
  return GitFixture.build(steps);
}
