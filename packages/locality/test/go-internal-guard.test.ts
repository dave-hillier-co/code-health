import { expect, it } from "vitest";
import type { Candidate } from "../src/candidates.ts";
import type { LocalitySettings } from "../src/config.ts";
import { planMove } from "../src/move-plan.ts";

const settings = { fixedPoints: [] } as unknown as LocalitySettings;

function candidate(file: string, target: string): Candidate {
  const location = file.slice(0, file.lastIndexOf("/"));
  return { path: file, unit: { kind: "file", files: [file], tests: [] }, location, recommendation: "move", rule: "distant", target, visibility: "internal" } as unknown as Candidate;
}

const tree = (files: string[]) => new Set(["go.mod", ...files]);

it("refuses a Go move out of an internal/ directory, which would let outside code import it", () => {
  const plan = planMove(candidate("svc/internal/store/store.go", "pkg/store"), settings, tree(["svc/internal/store/store.go"]));
  expect(plan.refusals.map((refusal) => refusal.code)).toEqual(["fixed-point"]);
  expect(plan.refusals[0]!.detail).toContain("internal/");
});

it("refuses a Go move into an internal/ directory, which would shut out code that imports it now", () => {
  const plan = planMove(candidate("svc/store/store.go", "svc/internal/store"), settings, tree(["svc/store/store.go"]));
  expect(plan.refusals.map((refusal) => refusal.code)).toEqual(["fixed-point"]);
});

it("allows a Go move within one internal/ tree", () => {
  const plan = planMove(candidate("svc/internal/a/a.go", "svc/internal/b"), settings, tree(["svc/internal/a/a.go"]));
  expect(plan.refusals).toEqual([]);
});

it("does not apply the rule to other languages", () => {
  const plan = planMove(candidate("svc/internal/a/a.ts", "pkg/a"), settings, tree(["svc/internal/a/a.ts"]));
  expect(plan.refusals).toEqual([]);
});
