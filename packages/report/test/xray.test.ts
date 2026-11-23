import { describe, expect, it } from "vitest";
import type { Block } from "../src/block.ts";
import { displayName, xrayBlocks, xraySlots, XRAY_ROWS, type XrayData, type XrayFunction } from "../src/xray.ts";

const fn = (name: string, cognitive: number | null, extra: Partial<XrayFunction> = {}): XrayFunction => ({
  id: `src/a.ts#${name}`,
  name,
  startLine: 1,
  endLine: 10,
  length: 10,
  cognitive,
  nesting: 1,
  cyclomatic: 2,
  labels: [],
  revisions: 3,
  fixes: 0,
  ...extra,
});

const tableOf = (blocks: Block[]) => {
  const table = blocks[0];
  if (table?.type !== "ranked-table") throw new Error("the first block is not a table");
  return table;
};

describe("X-Ray table", () => {
  it("sorts by cognitive complexity, then cyclomatic, then source order, whatever order the functions arrive in", () => {
    const data: XrayData = { file: "src/a.ts", functions: [fn("low", 2), fn("none", null), fn("high", 40), fn("mid", 9, { startLine: 50 }), fn("mid2", 9, { startLine: 20 })] };
    expect(tableOf(xrayBlocks(data)).rows.map((row) => row.function)).toEqual(["high", "mid2", "mid", "low", "none"]);
  });

  it("lists the first 25 functions, says how many it omits and which command lists them all", () => {
    const functions = Array.from({ length: 40 }, (_, i) => fn(`f${i}`, i));
    const table = tableOf(xrayBlocks({ file: "src/a.ts", functions, allCommand: "complexity analyse src/a.ts --with-fixes --limit all" }));
    expect(XRAY_ROWS).toBe(25);
    expect(table.rows).toHaveLength(25);
    expect(table.rows[0]?.function).toBe("f39");
    expect(table.total).toBe(40);
    expect(table.fullIn).toBe("complexity analyse src/a.ts --with-fixes --limit all");
  });

  it("judges the most complex functions, not the first ones listed", () => {
    const data: XrayData = { file: "src/a.ts", functions: [fn("a", 1), fn("b", 99), fn("c", 5)] };
    expect(xraySlots(data)[0]?.id).toBe("function:src/a.ts#b");
  });

  it("omits the revisions column when no function has a revisions figure", () => {
    const withoutRevisions = tableOf(xrayBlocks({ file: "src/a.ts", functions: [fn("a", 1, { revisions: null })] }));
    expect(withoutRevisions.columns.map((c) => c.key)).not.toContain("revisions");
    const withRevisions = tableOf(xrayBlocks({ file: "src/a.ts", functions: [fn("a", 1)] }));
    expect(withRevisions.columns.map((c) => c.key)).toContain("revisions");
  });
});

describe("display name", () => {
  it("prints the parser's repeat suffix as a variant number and leaves other names alone", () => {
    expect(displayName("ActivationData.ReadFromQueue~2")).toBe("ActivationData.ReadFromQueue (variant 2)");
    expect(displayName("Outer~3.method")).toBe("Outer (variant 3).method");
    expect(displayName("ActivationData.RunMessageLoop")).toBe("ActivationData.RunMessageLoop");
  });

  it("shows the display name in the table and the judgement slot, and keeps the id with the suffix", () => {
    const data: XrayData = { file: "src/a.ts", functions: [fn("Q.read~2", 9)] };
    expect(tableOf(xrayBlocks(data)).rows[0]?.function).toBe("Q.read (variant 2)");
    const slot = xraySlots(data)[0]!;
    expect(slot.id).toBe("function:src/a.ts#Q.read~2");
    expect(slot.title).toContain("Q.read (variant 2)");
  });
});
