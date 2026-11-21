import { afterAll, describe, expect, test } from "vitest";
import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { packages } from "./support/run.ts";
import { add, alice, commit, modify, module } from "./support/scenarios.ts";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const disposables: GitFixture[] = [];
afterAll(() => disposables.forEach((fixture) => fixture.dispose()));

const manifest = (name: string, version: string): string => json({ name, version, main: "src/index.ts" });

/** Two published packages whose versions change in the same four commits, plus whatever policy files `policy` adds. */
function releasedPair(policy: Change[], versions: [string, string] = ["1.0.0", "1.0.0"]): GitFixture {
  const steps: Step[] = [
    commit("Add the packages", "2024-01-01T09:00:00Z", [
      add("package.json", json({ name: "acme", private: true, workspaces: ["packages/*"] })),
      add("packages/a/package.json", manifest("@acme/a", versions[0])),
      add("packages/a/src/index.ts", module("a", [])),
      add("packages/b/package.json", manifest("@acme/b", versions[1])),
      add("packages/b/src/index.ts", module("b", [])),
      ...policy,
    ]),
  ];
  const placeholder = versions[0].startsWith("0.0.0");
  for (let i = 1; i <= 4; i++) {
    steps.push(
      commit(`Release ${i}`, `2024-02-0${i}T09:00:00Z`, [
        modify("packages/a/package.json", manifest("@acme/a", placeholder ? `0.0.0-dev.${i}` : `${versions[0].split(".")[0]}.${i}.0`)),
        modify("packages/b/package.json", manifest("@acme/b", placeholder ? `0.0.0-dev.${i}` : `${versions[1].split(".")[0]}.${i}.1`)),
      ], alice),
    );
  }
  const fixture = GitFixture.build(steps);
  disposables.push(fixture);
  return fixture;
}

async function lockstepsOf(fixture: GitFixture): Promise<string[]> {
  const { document } = await packages(fixture, "cohesion");
  return (document.results as { kind: string; id: string }[]).filter((f) => f.kind === "lockstep").map((f) => f.id);
}

describe("lockstep where policy fixes versions", () => {
  const group = ["@acme/a", "@acme/b"];

  test("is raised when nothing fixes the versions", async () => {
    expect(await lockstepsOf(releasedPair([], ["1.0.0", "2.0.0"]))).toEqual(["lockstep:packages/a->packages/b"]);
  });

  test("is not raised for a fixed changesets group", async () => {
    const fixture = releasedPair([add(".changeset/config.json", json({ fixed: [group] }))], ["1.0.0", "2.0.0"]);
    expect(await lockstepsOf(fixture)).toEqual([]);
  });

  test("is not raised for a linked changesets group named by pattern", async () => {
    const fixture = releasedPair([add(".changeset/config.json", json({ linked: [["@acme/*"]] }))], ["1.0.0", "2.0.0"]);
    expect(await lockstepsOf(fixture)).toEqual([]);
  });

  test("is raised for a pair that is not in the same group", async () => {
    const fixture = releasedPair([add(".changeset/config.json", json({ fixed: [["@acme/a", "@acme/other"]] }))], ["1.0.0", "2.0.0"]);
    expect(await lockstepsOf(fixture)).toEqual(["lockstep:packages/a->packages/b"]);
  });

  test("is not raised in lerna fixed mode", async () => {
    const fixture = releasedPair([add("lerna.json", json({ version: "1.0.0", packages: ["packages/*"] }))], ["1.0.0", "2.0.0"]);
    expect(await lockstepsOf(fixture)).toEqual([]);
  });

  test("is raised in lerna independent mode", async () => {
    const fixture = releasedPair([add("lerna.json", json({ version: "independent" }))], ["1.0.0", "2.0.0"]);
    expect(await lockstepsOf(fixture)).toEqual(["lockstep:packages/a->packages/b"]);
  });

  test("is not raised for placeholder versions", async () => {
    expect(await lockstepsOf(releasedPair([], ["0.0.0-dev", "0.0.0-dev"]))).toEqual([]);
  });
});

describe("boundary findings honour the exclude globs", () => {
  test("an excluded sample file adds no undeclared dependencies", async () => {
    const fixture = GitFixture.build([
      commit("Add the app", "2024-01-01T09:00:00Z", [
        add("package.json", json({ name: "acme", private: true, workspaces: ["packages/*"] })),
        add("code-health.json", json({ exclude: ["**/samples/**"] })),
        add("packages/app/package.json", json({ name: "@acme/app", private: true, main: "src/index.ts" })),
        add("packages/app/src/index.ts", module("app", [])),
        add("packages/app/samples/sample.ts", module("sample", [["lodash", "chunk"]])),
      ]),
    ]);
    disposables.push(fixture);
    const { document } = await packages(fixture, "boundaries");
    expect((document.results as { kind: string }[]).filter((f) => f.kind === "undeclared-dependency")).toEqual([]);
  });

  test("the same import in a file that is not excluded is undeclared", async () => {
    const fixture = GitFixture.build([
      commit("Add the app", "2024-01-01T09:00:00Z", [
        add("package.json", json({ name: "acme", private: true, workspaces: ["packages/*"] })),
        add("packages/app/package.json", json({ name: "@acme/app", private: true, main: "src/index.ts" })),
        add("packages/app/src/index.ts", module("app", [["lodash", "chunk"]])),
      ]),
    ]);
    disposables.push(fixture);
    const { document } = await packages(fixture, "boundaries");
    expect((document.results as { kind: string; evidence: any }[]).filter((f) => f.kind === "undeclared-dependency").map((f) => f.evidence.dependencies)).toEqual([["lodash"]]);
  });
});
