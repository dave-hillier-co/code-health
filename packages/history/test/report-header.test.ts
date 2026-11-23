import { describe, expect, it } from "vitest";
import type { FiltersApplied } from "../src/noise.ts";
import { excludedCounts, historyWindowText, isoDate } from "../src/report-header.ts";

const filters = {
  maxChangesetSize: 50,
  oversizedChanges: 4,
  dropped: { outsideWindow: 1, shallowBoundaryCommits: 0, importedCommits: 0, blameIgnoredCommits: 0, botCommits: 2, suiteCommits: 0, emptyAfterFiltering: 0, pureRenames: 3, excludedByGlob: 0, lockfiles: 0, generated: 0, vendored: 0 },
} as unknown as FiltersApplied;

describe("excludedCounts", () => {
  it("lists history drops, the changeset limit, files left out and built-in excludes", () => {
    const counts = excludedCounts(filters, { generated: 5, nonCode: 2 }, { "node_modules": 9 });
    expect(counts.find((c) => c.what === "commits by bots and service accounts")?.count).toBe(2);
    expect(counts.find((c) => c.what === "changes over the changeset limit of 50 files")?.count).toBe(4);
    expect(counts.find((c) => c.what === "generated files left out of the results")?.count).toBe(5);
    expect(counts.find((c) => c.what === "files under the built-in exclude node_modules")?.count).toBe(9);
  });

  it("takes the wording of the report", () => {
    const counts = excludedCounts(filters, { tests: 1 }, {}, { leftOutOf: "the rankings", oversizedNote: "counted on neither side of any ratio" });
    expect(counts.map((c) => c.what)).toContain("test files left out of the rankings");
    expect(counts.map((c) => c.what)).toContain("changes over the changeset limit of 50 files, counted on neither side of any ratio");
  });
});

describe("history window text", () => {
  it("reads dates from seconds and from ISO strings", () => {
    expect(isoDate(1735689600)).toBe("2025-01-01");
    expect(isoDate("2025-03-04T10:00:00.000Z")).toBe("2025-03-04");
    const evidence = { usableHistoryMonths: 9, window: { months: 6, since: 0, until: 0 } };
    expect(historyWindowText(evidence, { since: 1735689600, until: "2025-07-01T00:00:00.000Z" }, "; extra")).toBe(
      "9 months of usable history; the analysis window is 6 months, 2025-01-01 to 2025-07-01; extra",
    );
  });
});
