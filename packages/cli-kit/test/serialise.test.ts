import { expect, test } from "vitest";
import { serialise } from "../src/serialise.ts";

test("object keys are sorted recursively", () => {
  const text = serialise({ b: 1, a: { d: 1, c: 2 } });
  expect(text).toBe('{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n');
});

test("array order is preserved", () => {
  expect(JSON.parse(serialise({ list: [3, 1, 2] }))).toEqual({ list: [3, 1, 2] });
});

test("floats are rounded to six decimal places", () => {
  expect(JSON.parse(serialise({ x: 1 / 3, y: 0.1 + 0.2, z: 2 }))).toEqual({ x: 0.333333, y: 0.3, z: 2 });
});

test("undefined properties are dropped and null is kept", () => {
  expect(JSON.parse(serialise({ a: undefined, b: null }))).toEqual({ b: null });
});

test("identical values serialise identically regardless of insertion order", () => {
  expect(serialise({ a: 1, b: [{ y: 1, x: 2 }] })).toBe(serialise({ b: [{ x: 2, y: 1 }], a: 1 }));
});

test("non-finite numbers are rejected", () => {
  expect(() => serialise({ a: Number.NaN })).toThrow(/finite/);
});
