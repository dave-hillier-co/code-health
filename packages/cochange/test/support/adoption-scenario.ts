import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { ann, cy, eve } from "./knowledge-scenario.ts";

export type { Identity };

export const a = "src/a.ts";
export const b = "src/b.ts";
export const c = "src/c.ts";
export const e = "src/e.ts";
export const f = "src/f.ts";

const body = (name: string, revision: number, rewritten = 0): string =>
  [
    ...Array.from({ length: 9 }, (_, i) => `export const ${i < rewritten ? "rewritten" : name}${i} = ${i};`),
    `export const revision = ${revision};`,
    "",
  ].join("\n");

/**
 * Cy writes a, b, c and e in January 2024 and works on a and c together five times (June to July 2024), then
 * leaves: his last commit is 25 July 2024. Ann changes c alone three times afterwards and stays active. After
 * 28 February 2025 she changes a, and Eve, who joins in March 2025, changes e. Nobody touches b. HEAD is 1 June 2025.
 *
 * At 28 February 2025 the abandoned files are a, b and e (each held entirely by Cy). Within the next
 * period a is picked up by Ann, a recommended successor because she changes c, which a changes with,
 * and e is picked up by Eve, a newcomer the model could not have named. b is not picked up.
 */
export function adoptionHistory(): GitFixture {
  const steps: Step[] = [];
  const commit = (day: string, author: Identity, message: string, changes: Change[] = []) => {
    steps.push({ type: "commit", message, date: `${day}T09:00:00Z`, author, changes });
  };

  commit("2024-01-10", cy, "Cy writes the files", [
    { op: "add", path: a, content: body("a", 0) },
    { op: "add", path: b, content: body("b", 0) },
    { op: "add", path: c, content: body("c", 0) },
    { op: "add", path: e, content: body("e", 0) },
  ]);
  for (const [i, day] of ["2024-06-05", "2024-06-15", "2024-06-25", "2024-07-05", "2024-07-25"].entries()) {
    commit(day, cy, `Cy changes a and c ${i + 1}`, [
      { op: "modify", path: a, content: body("a", i + 1) },
      { op: "modify", path: c, content: body("c", i + 1) },
    ]);
  }
  for (const [i, day] of ["2024-09-05", "2024-10-05", "2024-11-05"].entries()) {
    commit(day, ann, `Ann changes c ${i + 1}`, [{ op: "modify", path: c, content: body("c", 10 + i, 3) }]);
  }
  for (const [i, day] of ["2024-02-01", "2024-04-01", "2024-08-01", "2024-12-20", "2025-01-20", "2025-02-20", "2025-04-20", "2025-06-01"].entries()) {
    commit(day, ann, `Maintenance ${i}`);
  }
  commit("2025-03-10", eve, "Eve adds f", [{ op: "add", path: f, content: body("f", 0) }]);
  commit("2025-04-01", ann, "Ann picks up a", [{ op: "modify", path: a, content: body("a", 20) }]);
  commit("2025-04-10", eve, "Eve picks up e", [{ op: "modify", path: e, content: body("e", 20) }]);

  const dated = steps.map((step, order) => ({ step, order }));
  dated.sort((x, y) => {
    const dx = (x.step as { date: string }).date;
    const dy = (y.step as { date: string }).date;
    return dx < dy ? -1 : dx > dy ? 1 : x.order - y.order;
  });
  return GitFixture.build(dated.map((d) => d.step));
}
