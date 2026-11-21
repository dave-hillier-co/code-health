import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

const author: Identity = { name: "Alice", email: "alice@example.com" };

export const hub = "src/app/registry.ts";
export const features = ["src/billing/plugin.ts", "src/mail/plugin.ts", "src/search/plugin.ts"];
export const pair = ["src/a/x.ts", "src/b/y.ts"];
export const trio = ["src/c/p.ts", "src/c/q.ts", "src/c/r.ts"];
export const drifting = "src/drift/engine.ts";
export const driftingTest = "src/drift/engine.test.ts";
export const kept = "src/ok/svc.ts";
export const keptTest = "src/ok/svc.test.ts";

/**
 * One initial commit and 42 further commits five days apart, ending in
 * August 2024. With the defaults (support 5, degree 30 %) the shapes are:
 *
 * - a registry hub changed with each of three features in three other folders, six
 *   times each, and the features never together: a star over four folders;
 * - a pair in two folders, changed together six times;
 * - a trio in one folder, changed together six times;
 * - an engine changed six times alone, with a sibling test that never changes;
 * - a service changed six times, each time with its sibling test.
 */
export function clusterHistory(): GitFixture {
  const versions = new Map<string, number>();
  const bump = (path: string): Change => {
    const version = (versions.get(path) ?? 0) + 1;
    versions.set(path, version);
    const content = `export const version = ${version};\nexport const name = "${path}";\n`;
    return { op: version === 1 ? "add" : "modify", path, content };
  };

  const steps: Step[] = [];
  let day = 0;
  const commit = (message: string, paths: string[]) => {
    const date = new Date(Date.UTC(2024, 0, 2 + day * 5, 9)).toISOString();
    day++;
    steps.push({ type: "commit", message, date, author, changes: paths.map(bump) });
  };

  const everything = [hub, ...features, ...pair, ...trio, drifting, driftingTest, kept, keptTest];
  commit("Start", everything);
  for (let i = 0; i < 6; i++) for (const feature of features) commit(`Register ${feature} ${i}`, [hub, feature]);
  for (let i = 0; i < 6; i++) commit(`Adjust the pair ${i}`, pair);
  for (let i = 0; i < 6; i++) commit(`Adjust the trio ${i}`, trio);
  for (let i = 0; i < 6; i++) commit(`Tune the engine ${i}`, [drifting]);
  for (let i = 0; i < 6; i++) commit(`Adjust the service ${i}`, [kept, keptTest]);
  return GitFixture.build(steps);
}
