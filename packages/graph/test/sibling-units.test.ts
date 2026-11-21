import { describe, expect, it } from "vitest";
import { dominatorUnits } from "../src/dominator-units.ts";
import { siblingSetUnits } from "../src/sibling-units.ts";

const folderOf = (id: string) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "");
const g = (edges: Record<string, string[]>) => new Map(Object.entries(edges));

describe("siblingSetUnits", () => {
  const graph = g({
    root: ["main"],
    main: ["lib/x", "lib/y"],
    "lib/x": ["lib/shared"],
    "lib/y": ["lib/shared"],
  });

  it("finds two files of one folder that share internals and are both imported from outside", () => {
    expect(dominatorUnits(graph, "root").units.get("lib/x")).toEqual(["lib/x"]);
    expect(siblingSetUnits(graph, "root", folderOf)).toEqual([
      { folder: "lib", entries: ["lib/x", "lib/y"], files: ["lib/shared", "lib/x", "lib/y"] },
    ]);
  });

  it("is not a unit when something outside the set reaches the shared internals", () => {
    const leaky = g({ ...Object.fromEntries(graph), main: ["lib/x", "lib/y", "other"], other: ["lib/shared"] });
    const units = siblingSetUnits(leaky, "root", folderOf);
    expect(units.map((u) => u.entries)).toEqual([["lib/shared", "lib/x", "lib/y"]]);
  });

  it("leaves single-entry folders to the dominator units", () => {
    const single = g({ root: ["main"], main: ["lib/x"], "lib/x": ["lib/y"] });
    expect(siblingSetUnits(single, "root", folderOf)).toEqual([]);
  });

  it("ignores unreachable files and is independent of input order", () => {
    const withDead = g({ ...Object.fromEntries(graph), dead: ["lib/shared", "lib/z"] });
    const reordered = new Map([...withDead].reverse());
    expect(siblingSetUnits(reordered, "root", folderOf)).toEqual(siblingSetUnits(withDead, "root", folderOf));
    expect(siblingSetUnits(withDead, "root", folderOf)[0]!.files).toEqual(["lib/shared", "lib/x", "lib/y"]);
  });
});
