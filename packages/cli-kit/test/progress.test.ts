import { expect, test } from "vitest";
import { progressReporter } from "../src/progress.ts";

function stream(isTTY: boolean) {
  const writes: string[] = [];
  return { writes, isTTY, write: (text: string) => writes.push(text) };
}

const describe = (done: number, total: number) => `blame: ${done} of ${total} files`;

test("on a terminal the line is redrawn in place, at most once per interval, and the last count always", () => {
  let now = 0;
  const err = stream(true);
  const progress = progressReporter(describe, { stream: err, now: () => now, redrawEveryMs: 100 });
  progress.update(1, 4);
  now = 50;
  progress.update(2, 4);
  now = 150;
  progress.update(3, 4);
  now = 160;
  progress.update(4, 4);
  progress.end();
  expect(err.writes).toEqual(["\rblame: 1 of 4 files", "\rblame: 3 of 4 files", "\rblame: 4 of 4 files", "\n"]);
});

test("when stderr is not a terminal nothing is printed until the work has lasted a while, then a line now and then", () => {
  let now = 0;
  const err = stream(false);
  const progress = progressReporter(describe, { stream: err, now: () => now, quietMs: 1_000, lineEveryMs: 500 });
  for (const [at, done] of [[100, 1], [999, 2], [1_000, 3], [1_200, 4], [1_500, 5], [1_600, 6]] as const) {
    now = at;
    progress.update(done, 10);
  }
  progress.end();
  expect(err.writes).toEqual(["blame: 3 of 10 files\n", "blame: 5 of 10 files\n"]);
});

test("a short run prints nothing at all when stderr is not a terminal", () => {
  const err = stream(false);
  const progress = progressReporter(describe, { stream: err, now: () => 0 });
  progress.update(1, 1);
  progress.end();
  expect(err.writes).toEqual([]);
});
