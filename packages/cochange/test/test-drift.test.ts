import { afterAll, beforeAll, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { isTestPath, siblingTestOf } from "../src/sibling-test.ts";
import { rules } from "../src/commands.ts";
import { expectGolden } from "./support/golden.ts";
import { clusterHistory, drifting, driftingTest, kept } from "./support/cluster-scenarios.ts";
import { runCochange } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = clusterHistory();
});
afterAll(() => repo.dispose());

const hotspots = async () => runCochange(repo.path, ["hotspots", "--json", "--limit", "all"]);
const rowsOf = (stdout: string) => JSON.parse(stdout).results as Record<string, any>[];

test("a frequently changed file whose sibling test never changes with it is test-drift", async () => {
  const { stdout } = await hotspots();
  const row = rowsOf(stdout).find((r) => r.path === drifting)!;
  expect(row).toMatchObject({ frequency: 7, siblingTest: driftingTest });
  expect(row.findings).toEqual(["hotspot", "test-drift"]);
  expectGolden("test-drift", "hotspots", stdout);
});

test("a file whose sibling test changes with it is not test-drift", async () => {
  const row = rowsOf((await hotspots()).stdout).find((r) => r.path === kept)!;
  expect(row).toMatchObject({ siblingTest: "src/ok/svc.test.ts" });
  expect(row.findings).not.toContain("test-drift");
});

test("files with no sibling test, and the tests themselves, have no test finding", async () => {
  const rows = rowsOf((await hotspots()).stdout);
  const byPath = new Map(rows.map((r) => [r.path, r]));
  expect(byPath.get("src/app/registry.ts")).toMatchObject({ siblingTest: null, findings: [] });
  expect(byPath.get(driftingTest)).toMatchObject({ siblingTest: null, findings: [] });
});

test("the rule is registered for cochange explain", () => {
  expect(rules["test-drift"]!.explanation).toMatch(/sibling test/);
});

test("sibling tests are found beside the file or in a __tests__ folder, by common naming", () => {
  const tree = new Set([
    "a/x.ts", "a/x.test.ts", "b/y.py", "b/y_test.py", "b/test_y.py", "c/z.ts", "c/__tests__/z.spec.ts", "d/Foo.java", "d/FooTest.java", "e/w.ts",
  ]);
  expect(siblingTestOf("a/x.ts", tree)).toBe("a/x.test.ts");
  expect(siblingTestOf("b/y.py", tree)).toBe("b/y_test.py");
  expect(siblingTestOf("c/z.ts", tree)).toBe("c/__tests__/z.spec.ts");
  expect(siblingTestOf("d/Foo.java", tree)).toBe("d/FooTest.java");
  expect(siblingTestOf("e/w.ts", tree)).toBeNull();
});

test("a test file is recognised by its name or folder", () => {
  expect(["a/x.test.ts", "a/x.spec.js", "b/y_test.go", "b/test_y.py", "d/FooTest.java", "c/__tests__/z.ts"].every(isTestPath)).toBe(true);
  expect(["a/x.ts", "latest.ts", "contest.ts"].some(isTestPath)).toBe(false);
});
