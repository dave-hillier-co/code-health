import { expect, test } from "vitest";
import { estimateTurnover, tenuresOf, type Activity } from "../src/abandonment/activity.ts";
import { SECONDS_PER_MONTH, activeAt } from "../src/active-developers.ts";

const month = SECONDS_PER_MONTH;
const WINDOW = 6 * month;
const PERIOD = 3 * month;

/** Commit times in months after zero. */
const at = (...months: number[]): number[] => months.map((m) => m * month);
const activity = (people: Record<string, number[]>): Activity => ({ commits: new Map(Object.entries(people).map(([k, v]) => [k, at(...v)])) });

test("a developer is active when a commit falls within the window ending at the date", () => {
  const times = at(0, 4);
  expect(activeAt(times, 9 * month, WINDOW)).toBe(true);
  expect(activeAt(times, 4 * month + WINDOW - 1, WINDOW)).toBe(true);
  // A commit exactly a window ago is no longer inside it.
  expect(activeAt(times, 4 * month + WINDOW, WINDOW)).toBe(false);
  // Commits after the date are not known yet.
  expect(activeAt(at(10), 9 * month, WINDOW)).toBe(false);
});

test("a quiet period shorter than the window does not end a tenure, and a longer one does", () => {
  expect(tenuresOf(at(0, 5, 10), 12 * month, WINDOW)).toEqual([{ start: 0, end: 10 * month, ongoing: true }]);
  expect(tenuresOf(at(0, 2, 10), 12 * month, WINDOW)).toEqual([
    { start: 0, end: 2 * month, ongoing: false },
    { start: 10 * month, end: 10 * month, ongoing: true },
  ]);
  // The last commit is only a departure once a whole window has passed without another.
  expect(tenuresOf(at(0, 2), 7 * month, WINDOW)).toEqual([{ start: 0, end: 2 * month, ongoing: true }]);
  expect(tenuresOf(at(0, 2), 8 * month, WINDOW)).toEqual([{ start: 0, end: 2 * month, ongoing: false }]);
});

test("turnover per period is departures over the developers still on the team at its start, by hand", () => {
  // Observed at month 24. Quarters end at 24, 21, 18, ... and a departure is known once a window (6 months) has passed.
  // Usable periods end at or before month 18: [15,18), [12,15), [9,12), [6,9), [3,6), [0,3).
  const turnover = estimateTurnover(
    activity({
      // Stays throughout.
      ann: [0, 4, 8, 12, 16, 20, 23],
      // Joins in the first period, last commit at month 7: leaves in [6,9).
      bob: [1, 3, 5, 7],
      // Joins at month 4, last commit at month 13: leaves in [12,15).
      cy: [4, 9, 13],
      // Joins at month 8, last commit 10.5: leaves in [9,12).
      di: [8, 10.5],
      // Joins late and is still active.
      eve: [19, 22],
    }),
    24 * month,
    { windowSeconds: WINDOW, periodSeconds: PERIOD },
  );
  const rows = turnover.periods.map((p) => [p.start / month, p.end / month, p.atRisk, p.departed]);
  // Period starts are measured back from the observation date, month 24.
  expect(rows).toEqual([
    [0, 3, 1, 0],
    [3, 6, 2, 0],
    [6, 9, 3, 1],
    [9, 12, 3, 1],
    [12, 15, 2, 1],
    [15, 18, 1, 0],
  ]);
  expect(turnover.departed).toBe(3);
  expect(turnover.atRisk).toBe(12);
  expect(turnover.rate).toBe(0.25);
});

test("periods whose departures cannot be known yet are left out of the estimate", () => {
  // One developer whose last commit is at month 10, observed at month 12: not yet a departure.
  const turnover = estimateTurnover(activity({ ann: [0, 5, 10, 12], bob: [0, 5, 10] }), 12 * month, { windowSeconds: WINDOW, periodSeconds: PERIOD });
  expect(turnover.departed).toBe(0);
  expect(turnover.periods.every((p) => p.end <= 6 * month)).toBe(true);
});

test("with no usable period there is no rate", () => {
  const turnover = estimateTurnover(activity({ ann: [0, 1] }), 2 * month, { windowSeconds: WINDOW, periodSeconds: PERIOD });
  expect(turnover.periods).toEqual([]);
  expect(turnover.rate).toBeNull();
});

test("commits after the observation date are ignored", () => {
  const early = estimateTurnover(activity({ ann: [0, 20], bob: [0, 3] }), 12 * month, { windowSeconds: WINDOW, periodSeconds: PERIOD });
  const alone = estimateTurnover(activity({ ann: [0], bob: [0, 3] }), 12 * month, { windowSeconds: WINDOW, periodSeconds: PERIOD });
  expect(early).toEqual(alone);
});
