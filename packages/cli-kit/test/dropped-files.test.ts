import { beforeEach, expect, test } from "vitest";
import { droppedCounts, recordDropped, resetDropped, restoreDropped } from "../src/dropped-files.ts";

beforeEach(() => resetDropped());

test("a path recorded twice is counted once", () => {
  recordDropped("generated", "a.cs");
  recordDropped("generated", "a.cs");
  expect(droppedCounts()).toEqual({ generated: 1 });
});

test("files recorded by a fresh run over the files a stored result already counted are counted once", () => {
  restoreDropped({ generated: 3, vendored: 2 });
  for (const path of ["a.cs", "b.cs", "c.cs"]) recordDropped("generated", path);
  expect(droppedCounts()).toEqual({ generated: 3, vendored: 2 });
});
