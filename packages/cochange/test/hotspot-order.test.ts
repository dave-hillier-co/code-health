import { expect, test } from "vitest";
import { orderedHotspots } from "../src/hotspot-ranking.ts";

const row = (path: string, score: number) => ({ path, score });

test("the rows of a computed ranking come out highest score first, ties by path", () => {
  const rows = orderedHotspots({ results: [row("a.ts", 0.1), row("c.ts", 0.9), row("b.ts", 0.9), row("d.ts", 0.5)] });
  expect(rows.map((r) => r.path)).toEqual(["b.ts", "c.ts", "d.ts", "a.ts"]);
});

test("a presorted output keeps its own order", () => {
  const rows = orderedHotspots({ results: [row("a.ts", 0.1), row("c.ts", 0.9)], presorted: true });
  expect(rows.map((r) => r.path)).toEqual(["a.ts", "c.ts"]);
});
