import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

export const ann: Identity = { name: "Ann Active", email: "ann@example.com" };
export const bob: Identity = { name: "Bob Builder", email: "bob@example.com" };
export const cy: Identity = { name: "Cy Gone", email: "cy@example.com" };
export const di: Identity = { name: "Di Departed", email: "di@example.com" };
export const eve: Identity = { name: "Eve Newer", email: "eve@example.com" };
export const dependabot: Identity = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };

export const engine = "src/core/engine.ts";
export const parser = "src/core/parser.ts";
export const lexer = "src/core/lexer.ts";
export const routes = "src/api/routes.ts";
export const auth = "src/api/auth.ts";
export const log = "src/util/log.ts";
export const view = "src/ui/view.ts";
export const deps = "src/gen/deps.ts";

const lines = (name: string, from: number, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `export const ${name}${from + i} = ${from + i};`);
const file = (...parts: string[][]): string => [...parts.flat(), ""].join("\n");
const rev = (n: number): string[] => [`export const revision = ${n};`];

const utc = (day: string) => `${day}T09:00:00Z`;

/**
 * Five people, one bot, and a history from January 2023 to the first of March 2025, built so that
 * every line has a known author. The people:
 *
 * - Ann and Bob commit every other month throughout and are active at HEAD;
 * - Eve joins in September 2024 and is active;
 * - Cy's last commit is in September 2023 and Di's in March 2024: both have left by HEAD;
 * - dependabot[bot] adds lines that belong to nobody.
 *
 * Lines at HEAD (who holds how many, `*` marks someone who has left):
 *
 * | file                  | lines | holders                        |
 * |-----------------------|-------|--------------------------------|
 * | src/core/engine.ts    | 10    | Cy 10*                         |
 * | src/core/parser.ts    | 10    | Cy 9*, Ann 1                   |
 * | src/core/lexer.ts     | 10    | Di 8*, Bob 2                   |
 * | src/api/routes.ts     | 10    | Ann 5, Bob 5                   |
 * | src/api/auth.ts       | 10    | Ann 10                         |
 * | src/util/log.ts       | 10    | Bob 10                         |
 * | src/ui/view.ts        | 10    | Eve 10                         |
 * | src/gen/deps.ts       | 10    | the bot 5 (nobody), Di 5*      |
 *
 * People's lines: 75. Held by people who have left: 32 (Cy 19, Di 13). With the default guideline of
 * 90 % three files are abandoned: engine, parser (exactly 90 %) and deps (all of what people wrote).
 * The lexer is at 80 %. Ann holds 16 lines, Bob 17 and Eve 10.
 *
 * Between 5 January and 1 March 2025 routes and auth change together six times, so they are coupled
 * and both hot. Ann makes the last of those changes, which is why the revision line of each is hers.
 */
export function knowledgeHistory(): GitFixture {
  const steps: Step[] = [];
  const commit = (day: string, author: Identity, message: string, changes: Change[] = []) => {
    steps.push({ type: "commit", message, date: utc(day), author, changes });
  };

  commit("2023-01-10", cy, "Start the engine", [
    { op: "add", path: engine, content: file(lines("engine", 1, 10)) },
    { op: "add", path: parser, content: file(lines("parser", 1, 9)) },
  ]);
  commit("2023-01-12", dependabot, "Bump dependencies", [{ op: "add", path: deps, content: file(lines("bot", 1, 5)) }]);
  commit("2023-02-10", di, "Add the lexer", [
    { op: "add", path: lexer, content: file(lines("lexer", 1, 8)) },
    { op: "modify", path: deps, content: file(lines("bot", 1, 5), lines("pin", 1, 5)) },
  ]);
  commit("2023-03-05", ann, "Add routes and auth", [
    { op: "modify", path: parser, content: file(lines("parser", 1, 9), lines("ann", 1, 1)) },
    { op: "add", path: routes, content: file(lines("route", 1, 4), rev(0)) },
    { op: "add", path: auth, content: file(lines("auth", 1, 9), rev(0)) },
  ]);
  commit("2023-03-20", bob, "Fill in routes, logging and the lexer", [
    { op: "modify", path: routes, content: file(lines("route", 1, 4), lines("extra", 1, 5), rev(0)) },
    { op: "add", path: log, content: file(lines("log", 1, 10)) },
    { op: "modify", path: lexer, content: file(lines("lexer", 1, 8), lines("bob", 1, 2)) },
  ]);

  // Departures: Cy and Di keep committing for a while, without touching lines, and then stop.
  commit("2023-05-02", cy, "Review");
  commit("2023-09-15", cy, "Hand over");
  commit("2023-06-01", di, "Review");
  commit("2023-11-20", di, "Review");
  commit("2024-03-01", di, "Last day");

  // Ann and Bob stay active, every other month.
  for (const [i, day] of ["2023-05-05", "2023-07-04", "2023-09-02", "2023-11-01", "2023-12-31", "2024-02-29", "2024-04-29", "2024-06-28", "2024-08-27", "2024-10-26", "2024-12-25", "2025-02-23"].entries()) {
    commit(day, ann, `Maintenance ${i}`);
  }
  for (const [i, day] of ["2023-05-20", "2023-07-19", "2023-09-17", "2023-11-16", "2024-01-15", "2024-03-15", "2024-05-14", "2024-07-13", "2024-09-11", "2024-11-10", "2025-01-09", "2025-02-20"].entries()) {
    commit(day, bob, `Housekeeping ${i}`);
  }

  commit("2024-09-10", eve, "Add the view", [{ op: "add", path: view, content: file(lines("view", 1, 10)) }]);
  for (const day of ["2024-10-10", "2024-11-09", "2024-12-09", "2025-01-08", "2025-02-07"]) commit(day, eve, "Eve is around");

  // Six changes to the pair, ten days apart. The last is Ann's, so the revision lines are hers.
  const bumps: [string, Identity][] = [
    ["2025-01-05", ann],
    ["2025-01-15", bob],
    ["2025-01-25", ann],
    ["2025-02-04", bob],
    ["2025-02-14", ann],
    ["2025-03-01", ann],
  ];
  for (const [i, [day, author]] of bumps.entries()) {
    commit(day, author, `Wire auth into routes ${i + 1}`, [
      { op: "modify", path: routes, content: file(lines("route", 1, 4), lines("extra", 1, 5), rev(i + 1)) },
      { op: "modify", path: auth, content: file(lines("auth", 1, 9), rev(i + 1)) },
    ]);
  }

  // The steps above are written by theme; history must be in date order.
  const dated = steps.map((step, order) => ({ step, order }));
  dated.sort((a, b) => {
    const da = (a.step as { date: string }).date;
    const db = (b.step as { date: string }).date;
    return da < db ? -1 : da > db ? 1 : a.order - b.order;
  });
  return GitFixture.build(dated.map((d) => d.step));
}
