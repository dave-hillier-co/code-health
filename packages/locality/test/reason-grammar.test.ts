import { expect, test } from "vitest";
import { reasonFor } from "../src/reason.ts";
import type { RecommendInput } from "../src/recommend.ts";

const input = (fanIn: number, otherRefs: number) =>
  ({ fanIn, otherRefs, consumerCoChange: null, highCoChange: 60, lowCoChange: 20 }) as unknown as RecommendInput;

test("the reason names one consumer file with a singular verb and several with a plural one", () => {
  expect(reasonFor(input(1, 1), { recommendation: "review", rule: "other-references" })).toMatch(/^1 consumer file uses it as a value/);
  expect(reasonFor(input(2, 2), { recommendation: "review", rule: "other-references" })).toMatch(/^2 consumer files use it as a value/);
  expect(reasonFor(input(1, 0), { recommendation: "review", rule: "three-or-more-consumers" })).toMatch(/^1 consumer file uses it,/);
  expect(reasonFor(input(3, 0), { recommendation: "review", rule: "three-or-more-consumers" })).toMatch(/^3 consumer files use it,/);
});
