import { expect, test } from "vitest";
import { tieNotice } from "../src/reports/coupling.ts";

const pair = (path: string, degree: number, support: number) => ({ path, with: `${path}.other`, degree, support }) as never;

test("a judged cut inside a tie says which pairs tie and that their order is by path", () => {
  const rows = [pair("a", 100, 9), pair("b", 100, 8), ...["c", "d", "e", "f", "g", "h", "i"].map((p) => pair(p, 100, 7)), pair("j", 90, 7)];
  const notice = tieNotice(rows, 5);
  expect(notice).toMatchObject({ type: "notice" });
  expect((notice as { text: string }).text).toContain("Pairs 3 to 9 tie on degree and shared changes");
  expect((notice as { text: string }).text).toContain("the order among them is by path");
});

test("no notice when the pair after the last judged one differs, or when every pair is judged", () => {
  expect(tieNotice([pair("a", 100, 9), pair("b", 100, 8), pair("c", 100, 7)], 2)).toBeNull();
  expect(tieNotice([pair("a", 100, 9), pair("b", 100, 9)], 5)).toBeNull();
  expect(tieNotice([pair("a", 100, 9), pair("b", 90, 9)], 1)).toBeNull();
});
