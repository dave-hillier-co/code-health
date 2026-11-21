import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { source } from "./coupling-scenarios.ts";

const alice: Identity = { name: "Alice", email: "alice@example.com" };

export const LEADING_BREAK_DATE = "2024-03-01T09:00:00Z";

export const leadingConfig = {
  structure: {
    layers: [
      { name: "ui", paths: ["src/ui/**"] },
      { name: "data", paths: ["src/data/**"] },
    ],
  },
};

const view = (revision: number): string => source(["a", "b", "c"], [{ from: "../data/store.ts", names: ["s"] }], revision);
const store = (revision: number, broken: boolean): string =>
  source(["s"], broken ? [] : [{ from: "../ui/view.ts", names: ["a", "b", "c"] }], revision);

/**
 * ui and data import each other, and data over ui breaks the layer rule: a folder cycle and one layer violation.
 * One commit on 2024-03-01 removes the import of ui from data, which ends both.
 */
export function leadingRepository(): GitFixture {
  const steps: Step[] = [];
  const commit = (message: string, date: string, changes: Change[]) => steps.push({ type: "commit", message, date, author: alice, changes });
  commit("Add the modules", "2024-01-05T09:00:00Z", [
    { op: "add", path: "code-health.json", content: JSON.stringify(leadingConfig) },
    { op: "add", path: "src/ui/view.ts", content: view(1) },
    { op: "add", path: "src/data/store.ts", content: store(1, false) },
    // A pair left alone: statically coupled, never changed, never broken. The comparison group for agent effort.
    { op: "add", path: "src/misc/x.ts", content: source(["x"], [{ from: "../util/y.ts", names: ["y"] }]) },
    { op: "add", path: "src/util/y.ts", content: source(["y"]) },
  ]);
  let day = 0;
  const edit = (revision: number, broken: boolean, spacing: number, offset: number) => {
    day += spacing;
    const date = new Date(Date.UTC(2024, 0, 6 + offset + day, 9)).toISOString().replace(".000Z", "Z");
    commit(`Change the view ${revision}`, date, [{ op: "modify", path: "src/ui/view.ts", content: view(revision) }]);
    day += spacing;
    const later = new Date(Date.UTC(2024, 0, 6 + offset + day, 9)).toISOString().replace(".000Z", "Z");
    commit(`Change the store ${revision}`, later, [{ op: "modify", path: "src/data/store.ts", content: store(revision, broken) }]);
  };
  for (let r = 2; r <= 5; r++) edit(r, false, 2, 30);
  commit("Stop the store importing the view", LEADING_BREAK_DATE, [{ op: "modify", path: "src/data/store.ts", content: store(6, true) }]);
  day = 0;
  for (let r = 7; r <= 10; r++) edit(r, true, 3, 56);
  return GitFixture.build(steps);
}
