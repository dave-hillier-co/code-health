import { expect, test } from "vitest";
import { recommend, type RecommendInput } from "../src/recommend.ts";

const thresholds = { minDistance: 2, tinyLines: 15, largeLines: 150, inlineHostLines: 300, highFanIn: 8, graceDays: 90, lowCoChange: 10, highCoChange: 40 };

function input(overrides: Partial<RecommendInput>): RecommendInput {
  return {
    ...thresholds,
    fanIn: 1,
    gain: 4,
    unblockedGain: 4,
    lines: 40,
    files: 1,
    consumerLines: 100,
    otherRefs: 0,
    packageEntry: false,
    scattered: false,
    fixedPoint: false,
    passThrough: false,
    barrelWithOneConsumer: false,
    splitCandidate: false,
    age: null,
    consumerCoChange: null,
    createsCycle: false,
    notHelper: null,
    ...overrides,
  };
}

test("one consumer: tiny units are inlined, medium units are inlined while the consumer stays readable", () => {
  expect(recommend(input({ lines: 10 }))).toEqual({ recommendation: "inline", rule: "single-consumer-tiny" });
  expect(recommend(input({ lines: 40 }))).toEqual({ recommendation: "inline", rule: "single-consumer-medium" });
  expect(recommend(input({ lines: 40, consumerLines: 280 }))).toEqual({ recommendation: "move", rule: "single-consumer-medium" });
});

test("one consumer: large units move next to the consumer as their own module", () => {
  expect(recommend(input({ lines: 400 }))).toEqual({ recommendation: "move", rule: "single-consumer-large" });
});

test("a unit of several files cannot be inlined, so it moves", () => {
  expect(recommend(input({ lines: 10, files: 3 }))).toEqual({ recommendation: "move", rule: "single-consumer-tiny" });
});

test("two consumers move to the target, three or more are for judgement", () => {
  expect(recommend(input({ fanIn: 2 }))).toEqual({ recommendation: "move", rule: "two-consumers" });
  expect(recommend(input({ fanIn: 3 }))).toEqual({ recommendation: "review", rule: "three-or-more-consumers" });
});

test("a unit that is not far from its consumers is kept, or blocked when only its dependencies hold it back", () => {
  expect(recommend(input({ gain: 1, unblockedGain: 1 }))).toEqual({ recommendation: "keep", rule: "near-consumers" });
  expect(recommend(input({ gain: 0, unblockedGain: 6 }))).toEqual({ recommendation: "blocked", rule: "blocked-by-dependency" });
});

test("high fan-in is scrutinised wherever the unit lives", () => {
  expect(recommend(input({ fanIn: 8, gain: 0, unblockedGain: 0 }))).toEqual({ recommendation: "scrutinise", rule: "high-fan-in" });
});

test("a pass-through with one consumer is inlined whatever its distance", () => {
  expect(recommend(input({ passThrough: true, gain: 0, unblockedGain: 0 }))).toEqual({
    recommendation: "inline",
    rule: "pass-through",
  });
  expect(recommend(input({ passThrough: true, fanIn: 2 }))).toEqual({ recommendation: "move", rule: "two-consumers" });
});

test("a barrel with one consumer is inlined, and a mixed file is split", () => {
  expect(recommend(input({ barrelWithOneConsumer: true, gain: 0, unblockedGain: 0 }))).toEqual({
    recommendation: "inline",
    rule: "single-consumer-barrel",
  });
  expect(recommend(input({ splitCandidate: true, fanIn: 5 }))).toEqual({ recommendation: "split", rule: "mixed-exports" });
});

test("guards turn inline and move into review", () => {
  expect(recommend(input({ otherRefs: 1 }))).toEqual({ recommendation: "review", rule: "other-references" });
  expect(recommend(input({ packageEntry: true, fanIn: 2 }))).toEqual({ recommendation: "review", rule: "package-entry" });
  expect(recommend(input({ otherRefs: 2, passThrough: true }))).toEqual({ recommendation: "review", rule: "other-references" });
  expect(recommend(input({ scattered: true, files: 4 }))).toEqual({ recommendation: "review", rule: "scattered-unit" });
});

test("a fixed point is kept where it is", () => {
  expect(recommend(input({ fixedPoint: true }))).toEqual({ recommendation: "keep", rule: "fixed-point" });
});

test("a unit nothing in production uses is left for review", () => {
  expect(recommend(input({ fanIn: 0, gain: 0, unblockedGain: 0 }))).toEqual({
    recommendation: "review",
    rule: "no-production-consumers",
  });
});

test("a unit younger than the grace period is reviewed, not inlined or moved; with no history there is no age to guard on", () => {
  expect(recommend(input({ lines: 10, age: 89 }))).toEqual({ recommendation: "review", rule: "within-grace-period" });
  expect(recommend(input({ fanIn: 2, age: 10 }))).toEqual({ recommendation: "review", rule: "within-grace-period" });
  expect(recommend(input({ lines: 10, age: 90 }))).toEqual({ recommendation: "inline", rule: "single-consumer-tiny" });
  expect(recommend(input({ lines: 10, age: null }))).toEqual({ recommendation: "inline", rule: "single-consumer-tiny" });
});

test("two consumers that rarely change together look independent and are reviewed, not moved", () => {
  expect(recommend(input({ fanIn: 2, consumerCoChange: 10 }))).toEqual({ recommendation: "review", rule: "independent-consumers" });
  expect(recommend(input({ fanIn: 2, consumerCoChange: 10.1 }))).toEqual({ recommendation: "move", rule: "two-consumers" });
  expect(recommend(input({ fanIn: 2, consumerCoChange: null }))).toEqual({ recommendation: "move", rule: "two-consumers" });
});

test("three or more consumers that change together earn the distance: keep", () => {
  expect(recommend(input({ fanIn: 3, consumerCoChange: 40 }))).toEqual({ recommendation: "keep", rule: "consumers-co-change" });
  expect(recommend(input({ fanIn: 3, consumerCoChange: 39.9 }))).toEqual({ recommendation: "review", rule: "three-or-more-consumers" });
  expect(recommend(input({ fanIn: 4, consumerCoChange: null }))).toEqual({ recommendation: "review", rule: "three-or-more-consumers" });
});

test("a move that would create a folder cycle is reviewed, but an inline is not", () => {
  expect(recommend(input({ fanIn: 2, createsCycle: true }))).toEqual({ recommendation: "review", rule: "creates-cycle" });
  expect(recommend(input({ lines: 10, createsCycle: true }))).toEqual({ recommendation: "inline", rule: "single-consumer-tiny" });
});

test("interfaces, overrides and recursive units are not free-standing helpers, so inline and move become review", () => {
  expect(recommend(input({ lines: 10, notHelper: "interface" }))).toEqual({ recommendation: "review", rule: "interface-unit" });
  expect(recommend(input({ fanIn: 2, notHelper: "override" }))).toEqual({ recommendation: "review", rule: "overrides-inherited-method" });
  expect(recommend(input({ lines: 400, notHelper: "recursion" }))).toEqual({ recommendation: "review", rule: "recursive-unit" });
  expect(recommend(input({ passThrough: true, notHelper: "override" }))).toEqual({ recommendation: "review", rule: "overrides-inherited-method" });
});

test("the not-a-helper guard leaves recommendations that are not an inline or a move alone", () => {
  expect(recommend(input({ gain: 1, unblockedGain: 1, notHelper: "interface" }))).toEqual({ recommendation: "keep", rule: "near-consumers" });
  expect(recommend(input({ fanIn: 3, notHelper: "recursion" }))).toEqual({ recommendation: "review", rule: "three-or-more-consumers" });
});
