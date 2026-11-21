import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const bob: Identity = { name: "Bob", email: "bob@example.com" };

export const model = "src/model/order.ts";
export const view = "ui/order-view.ts";

/**
 * Six features, each delivered as three commits by Alice an hour and two hours apart under one issue key
 * (`SHOP-1` to `SHOP-6`): the model first, then the view, then a fix to the model. Bob makes an
 * unrelated change to a third file between the commits of each feature, so the burst is not
 * consecutive in history. Features are a week apart, ending in March 2024.
 */
export function splitFeatures(): GitFixture {
  const versions = new Map<string, number>();
  const bump = (path: string): Change => {
    const version = (versions.get(path) ?? 0) + 1;
    versions.set(path, version);
    return { op: version === 1 ? "add" : "modify", path, content: `export const version = ${version};\nexport const file = "${path}";\n` };
  };
  const steps: Step[] = [];
  for (let feature = 1; feature <= 6; feature++) {
    const day = new Date(Date.UTC(2024, 1, feature * 7, 9));
    const at = (hours: number) => new Date(day.getTime() + hours * 3600_000).toISOString();
    steps.push({ type: "commit", message: `SHOP-${feature} Add the model`, date: at(0), author: alice, changes: [bump(model)] });
    steps.push({ type: "commit", message: `Tidy notes ${feature}`, date: at(0.5), author: bob, changes: [bump("docs/notes.md")] });
    steps.push({ type: "commit", message: `SHOP-${feature} Add the view`, date: at(1), author: alice, changes: [bump(view)] });
    steps.push({ type: "commit", message: `SHOP-${feature} Fix the model`, date: at(3), author: alice, changes: [bump(model)] });
  }
  return GitFixture.build(steps);
}
