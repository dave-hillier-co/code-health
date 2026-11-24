import { describe, expect, it } from "vitest";
import type { Block } from "../src/block.ts";
import { renderBlock } from "../src/block.ts";
import type { StabilityPoint } from "../src/components/stability-chart.ts";
import { dropEmptySlots, emptySection } from "../src/empty-block.ts";
import { htmlPage } from "../src/html-page.ts";
import { markdownPage } from "../src/markdown-page.ts";
import type { Slot } from "../src/protocol.ts";
import type { Report, ReportBuild } from "../src/report-model.ts";
import { capRows } from "../src/table-cap.ts";
import { codeSpan } from "../src/text.ts";
import { makeStamp } from "../src/stamp.ts";

const context = { slots: [] as Slot[], notes: undefined };
const slot = (id: string): Slot => ({ id, title: id, about: { kind: "report", ref: "r", label: "r" }, task: "write", verdicts: [], maxChars: 100 });
const table = (rows: number, extra: object = {}): Block => ({
  type: "ranked-table",
  caption: "Hubs",
  columns: [{ key: "name", label: "Name" }],
  rows: Array.from({ length: rows }, (_, i) => ({ name: `n${i}` })),
  ...extra,
});
const point = (i: number): StabilityPoint => ({ name: `p${i}`, instability: 0.1 * i, abstractness: 0.2, distance: 0.3, ca: 1, ce: 1, exportedTypes: 3, weak: false });
const chart = (points: number): Block => ({ type: "stability-chart", title: "Stability", zoneDistance: 0.3, points: Array.from({ length: points }, (_, i) => point(i)), total: 5 });

describe("empty blocks", () => {
  it("prints one notice line for a table with no rows, with the reason when given", () => {
    expect(renderBlock(table(0), "md", context)).toBe("> **Notice:** Hubs: no rows.");
    expect(renderBlock(table(0, { emptyText: "No hubs: no package has 10 dependents." }), "html", context)).toBe(
      '<aside class="notice notice" role="note"><strong>Notice:</strong> No hubs: no package has 10 dependents.</aside>',
    );
  });

  it("prints a notice instead of a stability chart with fewer than 3 points, and draws it with 3", () => {
    expect(renderBlock(chart(2), "md", context)).toContain("2 of 5 packages have both instability and abstractness; a chart needs at least 3.");
    expect(renderBlock(chart(2), "html", context)).not.toContain("<svg");
    expect(renderBlock(chart(3), "html", context)).toContain("<svg");
  });
});

describe("a section of empty blocks", () => {
  const section = { id: "hubs", heading: "Hubs", blocks: [table(0), chart(0)] };

  it("is one line", () => {
    expect(emptySection(section)).toBe("no rows. Stability: 0 of 5 packages have both instability and abstractness; a chart needs at least 3.");
    expect(emptySection({ ...section, blocks: [table(0), table(2)] })).toBeUndefined();
    expect(emptySection({ ...section, blocks: [table(0), { type: "judgement", slot: "j" }] })).toBeUndefined();
    expect(emptySection({ id: "x", heading: "X", blocks: [{ type: "notice", level: "notice", text: "t" }] })).toBeUndefined();
    expect(emptySection({ ...section, blocks: [table(0), { type: "notice", level: "limit", text: "Omitted 2 files." }] })).toBe("no rows. Omitted 2 files.");
    expect(emptySection({ ...section, blocks: [table(0, { emptyText: "No file is a hub." })] })).toBe("No file is a hub.");
  });

  it("renders as one line in both formats and keeps the anchor", () => {
    const build: ReportBuild = {
      title: "T",
      inputs: {},
      header: { evidenceGrade: "weak", historyWindow: "w", excluded: [] },
      sections: [section, { id: "full", heading: "Full", blocks: [table(2)] }],
      limits: [],
      slots: [],
    };
    const report: Report = { ...build, kind: "k", header: { repo: "r", commit: "c".repeat(40), date: "2025-01-01", configHash: "h", ...build.header }, stamp: makeStamp("k", "c", "h", {}) };
    const md = markdownPage(report, {});
    expect(md).toContain("**Hubs:** no rows.");
    expect(md).not.toContain("## Hubs");
    expect(md).toContain("## Full");
    const html = htmlPage(report, {});
    expect(html).toContain('<section id="hubs" aria-labelledby="hubs-heading">\n<p class="empty"><strong id="hubs-heading">Hubs:</strong>');
    expect(html).not.toContain("<h2 id=\"hubs-heading\">");
  });
});

describe("dropEmptySlots", () => {
  const build = (blocks: Block[], slots: string[]): ReportBuild => ({
    title: "T",
    inputs: {},
    header: { evidenceGrade: "weak", historyWindow: "w", excluded: [] },
    sections: [{ id: "s", heading: "S", blocks }],
    limits: [],
    slots: slots.map(slot),
  });

  it("removes the slot and block of a judgement that follows only empty content", () => {
    const out = dropEmptySlots(build([table(0), { type: "judgement", slot: "a" }, table(1), { type: "judgement", slot: "b" }], ["a", "b"]));
    expect(out.slots.map((s) => s.id)).toEqual(["b"]);
    expect(out.sections[0]!.blocks.map((b) => b.type)).toEqual(["ranked-table", "ranked-table", "judgement"]);
  });

  it("keeps a judgement with no block before it, or after a notice only, or after mixed content", () => {
    const notice: Block = { type: "notice", level: "notice", text: "t" };
    expect(dropEmptySlots(build([{ type: "judgement", slot: "a" }], ["a"])).slots).toHaveLength(1);
    expect(dropEmptySlots(build([notice, { type: "judgement", slot: "a" }], ["a"])).slots).toHaveLength(1);
    expect(dropEmptySlots(build([table(0), table(3), { type: "judgement", slot: "a" }], ["a"])).slots).toHaveLength(1);
    expect(dropEmptySlots(build([chart(1), notice, { type: "judgement", slot: "a" }], ["a"])).slots).toHaveLength(0);
  });
});

describe("capRows", () => {
  it("cuts the rows and says what was left out", () => {
    const capped = capRows(table(30) as never, 10, "structure hubs");
    const block: Block = { ...(table(30) as object), ...(capped as object) } as Block;
    expect((capped.rows)).toHaveLength(10);
    expect(capped.total).toBe(30);
    expect(renderBlock(block, "md", context)).toContain("_10 of 30 shown; the rest are in `structure hubs` output._");
    expect(renderBlock(block, "html", context)).toContain("10 of 30 shown; the rest are in <code>structure hubs</code> output.");
  });

  it("leaves a short table alone and keeps an earlier total", () => {
    const short = table(5) as never;
    expect(capRows(short, 10, "c")).toBe(short);
    const cut = capRows({ ...(table(20) as never as object), total: 50 } as never, 10, "c");
    expect(cut.total).toBe(50);
  });
});

describe("compact header", () => {
  it("makes the repository a code span whatever it contains", () => {
    expect(codeSpan("a`b")).toBe("``a`b``");
    expect(codeSpan("`x`")).toBe("`` `x` ``");
    const report: Report = {
      title: "T",
      inputs: {},
      sections: [],
      limits: [],
      slots: [],
      kind: "k",
      header: { repo: "we`ird", commit: "c".repeat(40), date: "2025-01-01", configHash: "h", evidenceGrade: "weak", historyWindow: "w", excluded: [{ what: "a", count: 2 }, { what: "b", count: 3 }] },
      stamp: makeStamp("k", "c", "h", {}),
    };
    const md = markdownPage(report, {}, { compact: true });
    expect(md).toContain("Repository ``we`ird`` at");
    expect(md).toContain("- Excluded: 5 in total across 2 kinds; the full report lists each");
  });
});

describe("band legends", () => {
  it("uses one band per distinct value when there are fewer distinct values than bands", async () => {
    const { matrixMd } = await import("../src/components/matrix.ts");
    const same = matrixMd({ title: "M", valueLabel: "shared changes", rows: ["a", "b"], columns: ["a", "b"], cells: [[null, 5], [5, null]] });
    expect(same).toContain("band 1: 5)");
    expect(same).not.toContain("5 to 5");
    const three = matrixMd({ title: "M", valueLabel: "shared changes", rows: ["a", "b"], columns: ["a", "b"], cells: [[1, 5], [9, 5]] });
    expect(three).toContain("band 1: 1, band 2: 5, band 3: 9");
  });
});
