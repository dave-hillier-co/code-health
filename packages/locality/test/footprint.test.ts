import { expect, test } from "vitest";
import { bestTarget, netDistance, type BoundaryEdge } from "../src/footprint.ts";

const edge = (outer: string, weight = 1, inner = ""): BoundaryEdge => ({ outer, inner, weight });

test("net distance is the weighted sum of folder distances to every boundary endpoint", () => {
  const edges = [edge("app/a", 2), edge("lib", 1)];
  // From app/a: 0 * 2 + 3 * 1.
  expect(netDistance(edges, "app/a")).toBe(3);
  // From utils: (1 + 2) * 2 + (1 + 1) * 1.
  expect(netDistance(edges, "utils")).toBe(8);
});

test("the inner offset places a member below the unit's base folder", () => {
  const edges = [edge("app", 1, "deep/er")];
  expect(netDistance(edges, "x")).toBe(4);
  expect(netDistance(edges, "app")).toBe(2);
});

test("the target of a unit with one consumer is the consumer's folder", () => {
  const result = bestTarget([edge("app/orders")], "shared/utils", { maxDepth: 6 });
  expect(result).toEqual({ target: "app/orders", current: 4, distance: 0, gain: 4 });
});

test("the target of two consumers is their lowest common ancestor", () => {
  const result = bestTarget([edge("app/orders"), edge("app/billing")], "shared/utils", { maxDepth: 6 });
  expect(result.target).toBe("app");
  expect(result.gain).toBe(6);
});

test("an outgoing dependency pulls the target back towards what the unit depends on", () => {
  const result = bestTarget([edge("app/orders", 1), edge("lib", 3)], "lib", { maxDepth: 6 });
  expect(result.target).toBe("lib");
  expect(result.gain).toBe(0);
});

test("ties go to the shallower folder, then to path order", () => {
  expect(bestTarget([edge("a/b"), edge("a/c")], "z", { maxDepth: 6 }).target).toBe("a");
  // The root, a and b all cost 2: the root is shallowest.
  expect(bestTarget([edge("a"), edge("b")], "z/z", { maxDepth: 6 }).target).toBe("");
  // a/x and b/x cost the same from a and b alike, and from the root: the root wins on depth.
  expect(bestTarget([edge("a/x"), edge("b/x")], "z/z", { maxDepth: 6 }).target).toBe("");
});

test("the current folder wins a tie, so a unit is never moved for no gain", () => {
  // The root and a/b cost the same for edges at a and b.
  const result = bestTarget([edge("a"), edge("b")], "", { maxDepth: 6 });
  expect(result).toMatchObject({ target: "", gain: 0 });
});

test("a target deeper than the depth cap is clamped to the cap", () => {
  const result = bestTarget([edge("a/b/c/d/e")], "z", { maxDepth: 2 });
  expect(result.target).toBe("a/b");
});

test("forbidden folders are never chosen as the target", () => {
  const result = bestTarget([edge("routes/orders")], "shared", {
    maxDepth: 6,
    forbidden: (folder) => folder.startsWith("routes"),
  });
  expect(result.target).not.toMatch(/^routes/);
});

test("a unit with no boundary edges stays where it is", () => {
  expect(bestTarget([], "a/b", { maxDepth: 6 })).toEqual({ target: "a/b", current: 0, distance: 0, gain: 0 });
});
