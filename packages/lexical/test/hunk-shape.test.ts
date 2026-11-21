import { describe, expect, test } from "vitest";
import { appendShape, collectionOpener, parseUnifiedHunks, type Hunk } from "../src/hunk-shape.ts";

const hunk = (...lines: string[]): Hunk => ({
  lines: lines.map((line) => ({ kind: line[0] as "+" | "-" | " ", text: line.slice(1) })),
});

describe("parseUnifiedHunks", () => {
  test("reads each hunk of a unified diff with its context, ignoring the file header and markers", () => {
    const diff = [
      "diff --git a/routes.ts b/routes.ts",
      "index 1111111..2222222 100644",
      "--- a/routes.ts",
      "+++ b/routes.ts",
      "@@ -3,2 +3,3 @@ export const routes = [",
      '   { path: "/a", component: A },',
      '+  { path: "/b", component: B },',
      " ];",
      "@@ -20 +21 @@ function f() {",
      "-  return 1;",
      "\\ No newline at end of file",
      "+  return 2;",
    ].join("\n");
    const hunks = parseUnifiedHunks(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.lines).toEqual([
      { kind: " ", text: '  { path: "/a", component: A },' },
      { kind: "+", text: '  { path: "/b", component: B },' },
      { kind: " ", text: "];" },
    ]);
    expect(hunks[1]!.lines.map((l) => l.kind)).toEqual(["-", "+"]);
  });

  test("a diff with no hunks has none", () => {
    expect(parseUnifiedHunks("")).toEqual([]);
  });
});

describe("appendShape", () => {
  test("an entry added to a collection beside similar entries is an addition", () => {
    expect(
      appendShape(
        hunk(
          ' const routes = [',
          '   { path: "/orders", component: Orders },',
          '+  { path: "/invoices", component: Invoices },',
          " ];",
        ),
      ),
    ).toBe("addition");
  });

  test("an entry removed from the collection is a removal", () => {
    expect(
      appendShape(
        hunk(
          '   { path: "/orders", component: Orders },',
          '-  { path: "/legacy", component: Legacy },',
          '   { path: "/invoices", component: Invoices },',
        ),
      ),
    ).toBe("removal");
  });

  test("works in any language: Python list entries and C# registrations", () => {
    expect(appendShape(hunk('     "orders",', '+    "invoices",', " ]"))).toBe("addition");
    expect(
      appendShape(
        hunk(
          "     services.AddScoped<IOrders, Orders>();",
          "+    services.AddScoped<IInvoices, Invoices>();",
          "     services.AddScoped<IUsers, Users>();",
        ),
      ),
    ).toBe("addition");
  });

  test("a few lines at one indentation count, and a block of new code does not", () => {
    const entries = Array.from({ length: 8 }, (_, i) => `+  { path: "/p${i}", component: P${i} },`);
    expect(appendShape(hunk('   { path: "/a", component: A },', ...entries, " ];"))).toBeNull();
    expect(appendShape(hunk('   { path: "/a", component: A },', ...entries.slice(0, 3), " ];"))).toBe("addition");
  });

  test("statements unlike their neighbours are not entries of a collection", () => {
    expect(appendShape(hunk("   const total = sum(items);", "+  if (total > limit) throw new Error(message);", "   return total;"))).toBeNull();
  });

  test("a change that both adds and removes is a modification, not an append", () => {
    expect(appendShape(hunk('   { path: "/a", component: A },', '-  { path: "/b", component: B },', '+  { path: "/b", component: Bee },', " ];"))).toBeNull();
  });

  test("added lines at different indentations are not one entry list", () => {
    expect(appendShape(hunk('   { path: "/a", component: A },', '+  { path: "/b", component: B },', '+    { path: "/c", component: C },', " ];"))).toBeNull();
  });

  test("a change beside a deeper block is not in the same block", () => {
    expect(
      appendShape(hunk("     return {", "       a: 1,", "     };", '+  { path: "/b", component: B },', "       nested: {")),
    ).toBeNull();
  });

  test("a lone entry between the brackets of a new literal needs a trailing comma to count", () => {
    expect(appendShape(hunk(" const routes = [", '+  { path: "/a", component: A },', " ];"))).toBe("addition");
    expect(appendShape(hunk(" function f() {", "+  return compute(a, b)", " }"))).toBeNull();
  });

  test("a hunk with only added lines and no context cannot be placed in a block", () => {
    expect(appendShape(hunk('+  { path: "/a", component: A },'))).toBeNull();
  });

  test("blank lines among the changes do not break the indentation or count as lines", () => {
    expect(appendShape(hunk('   { path: "/a", component: A },', '+  { path: "/b", component: B },', "+", " ];"))).toBe("addition");
  });
});

describe("collectionOpener", () => {
  const text = [
    "import { A } from './a';",
    "",
    "export const routes = [",
    '  { path: "/a", component: A },',
    '  { path: "/b", component: B },',
    "];",
  ];

  test("finds the line that opens the block the entry sits in", () => {
    expect(collectionOpener(text, '  { path: "/b", component: B },')).toEqual({ line: 3, text: "export const routes = [" });
  });

  test("is undefined for an entry that is not in the text or has no enclosing block", () => {
    expect(collectionOpener(text, "  nothing like it")).toBeUndefined();
    expect(collectionOpener(text, "export const routes = [")).toBeUndefined();
  });
});
