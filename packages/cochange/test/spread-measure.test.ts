import { expect, test } from "vitest";
import {
  bucketLabel,
  bucketStart,
  changeSpread,
  hasCodeHealthTrailer,
  nextBucketStart,
  parseDate,
  percentile,
} from "../src/spread-measure.ts";

const utc = (iso: string) => Date.parse(iso) / 1000;

test("a change of no files or one file has spread 0", () => {
  expect(changeSpread([])).toBe(0);
  expect(changeSpread(["src/a.ts"])).toBe(0);
});

test("two files in one folder are at distance 0, a file and its cousin at 4", () => {
  expect(changeSpread(["src/a.ts", "src/b.ts"])).toBe(0);
  expect(changeSpread(["src/billing/a.ts", "src/reports/b.ts"])).toBe(2);
  expect(changeSpread(["src/billing/x/a.ts", "src/reports/y/b.ts"])).toBe(4);
});

test("the spread is the mean over all pairs", () => {
  // README to src is 1, README to src/x is 2, src to src/x is 1.
  expect(changeSpread(["README.md", "src/a.ts", "src/x/b.ts"])).toBeCloseTo((1 + 2 + 1) / 3, 12);
});

test("the order of files does not matter and repeated paths count once", () => {
  expect(changeSpread(["b/y.ts", "a/x.ts", "a/z.ts"])).toBe(changeSpread(["a/z.ts", "a/x.ts", "b/y.ts"]));
  expect(changeSpread(["a/x.ts", "a/x.ts", "b/y.ts"])).toBe(changeSpread(["a/x.ts", "b/y.ts"]));
});

test("percentiles interpolate linearly between closest ranks", () => {
  expect(percentile([], 0.5)).toBeNull();
  expect(percentile([7], 0.9)).toBe(7);
  expect(percentile([4, 0, 2, 1], 0.5)).toBe(1.5);
  expect(percentile([0, 1, 2, 3, 4], 0.75)).toBe(3);
  expect(percentile([0, 1, 2, 3, 4], 0.9)).toBeCloseTo(3.6, 12);
  expect(percentile([0, 10], 0)).toBe(0);
  expect(percentile([0, 10], 1)).toBe(10);
});

test("months start on the first and weeks on Monday, in UTC", () => {
  const t = utc("2024-03-14T23:59:59Z"); // a Thursday
  expect(bucketLabel(bucketStart(t, "month"), "month")).toBe("2024-03");
  expect(bucketLabel(bucketStart(t, "week"), "week")).toBe("2024-03-11");
  // Sunday belongs to the week that began the Monday before.
  expect(bucketLabel(bucketStart(utc("2024-03-17T12:00:00Z"), "week"), "week")).toBe("2024-03-11");
  expect(bucketLabel(bucketStart(utc("2024-03-18T00:00:00Z"), "week"), "week")).toBe("2024-03-18");
  // A week can start in the previous year.
  expect(bucketLabel(bucketStart(utc("2024-01-02T00:00:00Z"), "week"), "week")).toBe("2024-01-01");
  expect(bucketLabel(bucketStart(utc("2025-01-01T00:00:00Z"), "week"), "week")).toBe("2024-12-30");
});

test("the next bucket crosses month and year ends", () => {
  expect(bucketLabel(nextBucketStart(utc("2024-12-01T00:00:00Z"), "month"), "month")).toBe("2025-01");
  expect(bucketLabel(nextBucketStart(utc("2024-02-01T00:00:00Z"), "month"), "month")).toBe("2024-03");
  expect(bucketLabel(nextBucketStart(utc("2024-12-30T00:00:00Z"), "week"), "week")).toBe("2025-01-06");
});

test("a Code-Health trailer is recognised in the trailer paragraph only", () => {
  expect(hasCodeHealthTrailer("Move files\n\nWhy.\n\nCode-Health: locality/move")).toBe(true);
  expect(hasCodeHealthTrailer("Move files\n\nCode-Health: locality/move\nCo-Authored-By: X <x@y>\n")).toBe(true);
  expect(hasCodeHealthTrailer("Move files\n\ncode-health: locality/move")).toBe(true);
  expect(hasCodeHealthTrailer("Move files\r\n\r\nCode-Health: locality/move\r\n")).toBe(true);
  // Mentioned in the body, not a trailer.
  expect(hasCodeHealthTrailer("Move files\n\nThe Code-Health: trailer marks these.\n\nSigned-off-by: A <a@b>")).toBe(false);
  expect(hasCodeHealthTrailer("Move files\n\nCode-Health: locality/move\n\nTrailing prose")).toBe(false);
  // A lone paragraph is the subject, never a trailer block.
  expect(hasCodeHealthTrailer("Code-Health: locality/move")).toBe(false);
  expect(hasCodeHealthTrailer("Plain change")).toBe(false);
});

test("dates are strict ISO 8601", () => {
  expect(parseDate("2024-03-01")).toBe(utc("2024-03-01T00:00:00Z"));
  expect(parseDate("2024-03-01T10:00:00Z")).toBe(utc("2024-03-01T10:00:00Z"));
  expect(parseDate("2024-03-01T10:00:00+02:00")).toBe(utc("2024-03-01T08:00:00Z"));
  expect(parseDate("2024-02-30")).toBeNull();
  expect(parseDate("2024-13-01")).toBeNull();
  expect(parseDate("03/01/2024")).toBeNull();
  expect(parseDate("yesterday")).toBeNull();
  expect(parseDate("2024-03-01T10:00:00")).toBeNull();
});
