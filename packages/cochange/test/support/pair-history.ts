import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const bob: Identity = { name: "Bob", email: "bob@example.com" };

/** A pair of files and the number of changes that touch both and nothing else. */
export type TogetherPair = [x: string, y: string, together: number];

function source(name: string, version: number): string {
  const body = Array.from({ length: 9 }, (_, i) => `export const ${name}Step${i} = ${i};`);
  return [...body, `export const ${name} = ${version};`, ""].join("\n");
}

/** A 2025 history in which each pair changes together the stated number of times, and the files never change apart. */
export function pairHistory(pairs: readonly TogetherPair[], authors = 2): GitFixture {
  const versions = new Map<string, number>();
  const steps: Step[] = [];
  const bump = (path: string): Change => {
    const version = (versions.get(path) ?? 0) + 1;
    const content = source(path.replace(/\W/g, ""), version);
    versions.set(path, version);
    return version === 1 ? { op: "add", path, content } : { op: "modify", path, content };
  };
  const day = 24 * 3600 * 1000;
  let n = 0;
  for (const [x, y, together] of pairs) {
    for (let i = 0; i < together; i++) {
      steps.push({ type: "commit", message: `Change ${x} and ${y} ${n}`, date: new Date(Date.UTC(2025, 0, 2, 9) + day * n).toISOString(), author: authors === 1 || n % 2 === 0 ? alice : bob, changes: [bump(x), bump(y)] });
      n++;
    }
  }
  steps.push({ type: "commit", message: "Release", date: new Date(Date.UTC(2025, 11, 31, 9)).toISOString(), author: alice, changes: [bump("docs/release.ts")] });
  return GitFixture.build(steps);
}
