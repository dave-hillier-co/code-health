import { expect, test } from "vitest";
import { flagParameters, isPassThrough, vagueSegment } from "../src/signals.ts";

test("a function that forwards its parameters to another call is a pass-through", () => {
  expect(isPassThrough("export function save(a: string, b: number) {\n  return store.save(a, b);\n}")).toBe(true);
  expect(isPassThrough("export const save = (a, b) => store.save(a, b);")).toBe(true);
  expect(isPassThrough("export const save = async (a) => { return await store.save(a); };")).toBe(true);
  expect(isPassThrough("export const wrap = x => inner(x);")).toBe(true);
  expect(isPassThrough("getName() {\n  return this.person.getName();\n}")).toBe(true);
});

test("a function that does anything else is not a pass-through", () => {
  expect(isPassThrough("export function save(a, b) {\n  return store.save(b, a);\n}")).toBe(false);
  expect(isPassThrough("export function save(a) {\n  log(a);\n  return store.save(a);\n}")).toBe(false);
  expect(isPassThrough("export const save = (a) => store.save(a, 1);")).toBe(false);
  expect(isPassThrough("export const save = (a) => store.save(a.id);")).toBe(false);
  expect(isPassThrough("export const answer = 42;")).toBe(false);
});

test("boolean parameters of a function are flag parameters", () => {
  expect(flagParameters("export function render(node: Node, compact: boolean, wide = false) {\n}")).toEqual(["compact", "wide"]);
  expect(flagParameters("export const render = (node: Node, dense?: boolean) => node;")).toEqual(["dense"]);
  expect(flagParameters("export function render(node: Node, depth: number) {\n}")).toEqual([]);
});

test("a path with a vague folder or file name reports that name", () => {
  const vague = ["utils", "helpers", "common", "misc"];
  expect(vagueSegment("src/shared/utils/money.ts", vague)).toBe("utils");
  expect(vagueSegment("src/orders/helpers.ts", vague)).toBe("helpers");
  expect(vagueSegment("src/orders/misc.test.ts", vague)).toBe("misc");
  expect(vagueSegment("src/orders/place.ts", vague)).toBeUndefined();
  expect(vagueSegment("src/utilities/place.ts", vague)).toBeUndefined();
});
