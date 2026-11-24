import { expect, test } from "vitest";
import { UNASSIGNED, componentOf, readComponents } from "../src/components.ts";

test("a path belongs to the component whose glob matches it", () => {
  const components = readComponents({ billing: ["src/billing/**"], web: "src/web" });
  expect(componentOf(components, "src/billing/invoice.ts")).toBe("billing");
  expect(componentOf(components, "src/web/page.ts")).toBe("web");
  expect(componentOf(components, "README.md")).toBe(UNASSIGNED);
});

test("when several components match, the first by name wins, whatever the key order", () => {
  const components = readComponents({ zeta: ["src/**"], alpha: ["src/billing/**"] });
  expect(componentOf(components, "src/billing/invoice.ts")).toBe("alpha");
});

test.each([
  [{ billing: 3 }, "billing must be a glob, an array of globs, or an object with \"paths\""],
  [{ billing: [1] }, "billing must be a glob, an array of globs, or an object with \"paths\""],
  [{ billing: [] }, "billing must list at least one glob"],
  [{ "(unassigned)": ["x"] }, "reserved"],
])("invalid components %j are config errors", (value, message) => {
  expect(() => readComponents(value)).toThrowError(message);
});

test("no components configured reads as an empty list", () => {
  expect(readComponents({})).toEqual([]);
});
