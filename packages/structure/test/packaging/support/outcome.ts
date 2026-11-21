import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { add, alice, bob, commit, modify, module } from "./scenarios.ts";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const manifest = (name: string, dependencies: string[] = []): string =>
  json({
    name: `@out/${name}`,
    private: true,
    exports: { ".": "./src/index.ts" },
    ...(name === "app" ? { bin: { app: "./bin.js" } } : {}),
    dependencies: Object.fromEntries(dependencies.map((d) => [`@out/${d}`, "*"])),
  });

const fn = (name: string, imports: [string, string][] = [], revision = 1): string => module(name, imports, revision);

const day = 24 * 60 * 60 * 1000;
const iso = (start: string, days: number): string => new Date(Date.parse(start) + days * day).toISOString().replace(/\.\d+Z$/, "Z");

export interface OutcomeRepository {
  fixture: GitFixture;
  /** The first commit of the merge: it moves the files and rewrites the imports. */
  first: string;
  /** The second: it removes the emptied package's manifest. */
  last: string;
}

/**
 * `left` and `right` change together and are used by `app`; `solo` changes on its own. In April 2023
 * `right` is merged into `left` in two commits, as the packaging skill does it: one moves the file and
 * rewrites the imports, one removes the manifest. Afterwards the merged `left` mostly changes alone, and
 * `app` changes with it a quarter as often as it did with the pair.
 */
export function outcomeRepository(): OutcomeRepository {
  const steps: Step[] = [
    commit("Add the packages", "2023-01-02T09:00:00Z", [
      add("package.json", json({ name: "out", private: true, workspaces: ["packages/*"] })),
      add("packages/left/package.json", manifest("left")),
      add("packages/left/src/index.ts", fn("l")),
      add("packages/left/src/work.ts", fn("leftWork")),
      add("packages/right/package.json", manifest("right")),
      add("packages/right/src/index.ts", fn("r")),
      add("packages/right/src/work.ts", fn("rightWork")),
      add("packages/solo/package.json", manifest("solo")),
      add("packages/solo/src/index.ts", fn("s")),
      add("packages/solo/src/work.ts", fn("soloWork")),
      add("packages/app/package.json", manifest("app", ["left", "right"])),
      add("packages/app/src/index.ts", fn("main", [["@out/left", "l"], ["@out/right", "r"]])),
      add("packages/app/src/work.ts", fn("appWork")),
    ]),
  ];
  const revision = new Map<string, number>();
  const touch = (targets: string[]): Change[] =>
    targets.map((target) => {
      const path = `packages/${target}/src/work.ts`;
      const next = (revision.get(path) ?? 1) + 1;
      revision.set(path, next);
      return modify(path, fn(`${target}Work`, [], next));
    });
  const interleave = (kinds: [number, string[]][]): string[][] => {
    const slots = kinds.flatMap(([count, targets], kind) => Array.from({ length: count }, (_, i) => ({ targets, kind, at: (i + 0.5) / count })));
    return slots.sort((a, b) => a.at - b.at || a.kind - b.kind).map(({ targets }) => targets);
  };
  interleave([[8, ["left", "right"]], [6, ["solo"]], [2, ["app"]]]).forEach((targets, i) => {
    steps.push(commit(`Change ${targets.join(" and ")} (${i + 1})`, iso("2023-02-01T09:00:00Z", i * 2), touch(targets), i % 2 === 0 ? alice : bob));
  });
  steps.push(
    commit("Merge right into left: move the file and the imports", "2023-04-01T09:00:00Z", [
      { op: "rename", from: "packages/right/src/index.ts", path: "packages/left/src/right.ts" },
      modify("packages/left/src/index.ts", `${fn("l")}export { r } from "./right.ts";\n`),
      modify("packages/app/src/index.ts", fn("main", [["@out/left", "l"], ["@out/left", "r"]])),
      modify("packages/app/package.json", manifest("app", ["left"])),
    ]),
    commit("Merge right into left: remove the emptied package", "2023-04-02T09:00:00Z", [
      { op: "delete", path: "packages/right/package.json" },
      { op: "delete", path: "packages/right/src/work.ts" },
    ]),
  );
  const first = "HEAD~1";
  const fixture = GitFixture.build(steps);
  const firstSha = fixture.git("rev-parse", first);
  const last = fixture.git("rev-parse", "HEAD");
  interleave([[8, ["left"]], [6, ["solo"]], [2, ["app"]], [2, ["app", "left"]]]).forEach((targets, i) => {
    fixture.apply([commit(`Change ${targets.join(" and ")} (after ${i + 1})`, iso("2023-04-10T09:00:00Z", i * 2), touch(targets), i % 2 === 0 ? alice : bob)]);
  });
  return { fixture, first: firstSha, last };
}
