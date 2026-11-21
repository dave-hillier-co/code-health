import { expect, test } from "vitest";
import { inWindow, parseWindow } from "../src/time-window.ts";

test("a window runs from an explicit date inclusive to an explicit date exclusive, in UTC", () => {
  const window = parseWindow("2026-03-01", "2026-04-01");
  expect(inWindow(window, "2026-03-01T00:00:00.000Z")).toBe(true);
  expect(inWindow(window, "2026-03-31T23:59:59.999Z")).toBe(true);
  expect(inWindow(window, "2026-04-01T00:00:00.000Z")).toBe(false);
  expect(inWindow(window, "2026-02-28T23:59:59.999Z")).toBe(false);
});

test("timestamps with offsets are compared as instants", () => {
  const window = parseWindow("2026-03-01", "2026-03-02");
  expect(inWindow(window, "2026-03-01T01:00:00.000+02:00")).toBe(false);
  expect(inWindow(window, "2026-03-02T01:00:00.000+02:00")).toBe(true);
});

test("an unparseable timestamp is outside every window", () => {
  expect(inWindow(parseWindow("2026-03-01", "2026-03-02"), "not a date")).toBe(false);
});

test("dates must be real calendar dates in YYYY-MM-DD form", () => {
  expect(() => parseWindow("2026-3-1", "2026-04-01")).toThrow(/YYYY-MM-DD/);
  expect(() => parseWindow("2026-02-30", "2026-04-01")).toThrow(/YYYY-MM-DD/);
  expect(() => parseWindow("2026-03-01", "tomorrow")).toThrow(/YYYY-MM-DD/);
});

test("the end must be after the start", () => {
  expect(() => parseWindow("2026-03-01", "2026-03-01")).toThrow(/after/);
  expect(() => parseWindow("2026-03-02", "2026-03-01")).toThrow(/after/);
});
