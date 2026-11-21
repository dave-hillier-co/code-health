import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { add, alice, bob, commit, modify, module } from "./scenarios.ts";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const manifest = (name: string, dependencies: string[] = []): string =>
  json({
    name: `@mini/${name}`,
    private: true,
    exports: { ".": "./src/index.ts" },
    dependencies: Object.fromEntries(dependencies.map((d) => [`@mini/${d}`, "*"])),
  });

const fn = (name: string, imports: [string, string][] = [], revision = 1): string => module(name, imports, revision);

interface Spec {
  name: string;
  dependencies?: string[];
  files: Record<string, string>;
}

const specs: Spec[] = [
  // two small packages that change together, whose consumers use one each
  { name: "lib2", files: { "index.ts": 'export { p } from "./p.ts";\n', "p.ts": fn("p") } },
  { name: "lib3", files: { "index.ts": 'export { q } from "./q.ts";\n', "q.ts": fn("q") } },
  { name: "x", dependencies: ["lib2", "big"], files: { "index.ts": fn("useP", [["@mini/lib2", "p"], ["@mini/big", "m"]]), "work.ts": fn("xWork") } },
  { name: "y", dependencies: ["lib3", "big"], files: { "index.ts": fn("useQ", [["@mini/lib3", "q"], ["@mini/big", "n"]]), "work.ts": fn("yWork") } },
  // one package with two parts that different consumers use, and that change together
  { name: "big", files: { "index.ts": 'export { m } from "./m.ts";\nexport { n } from "./n.ts";\n', "m.ts": fn("m"), "n.ts": fn("n") } },
  // core is imported by edge. Two of its files change with edge, and moving either would go wrong
  {
    name: "core",
    files: {
      "index.ts": fn("core", [["./shared.ts", "shared"], ["./util.ts", "util"], ["./other.ts", "other"]]),
      "util.ts": fn("util"),
      "shared.ts": fn("shared"),
      "other.ts": fn("other"),
    },
  },
  {
    name: "edge",
    dependencies: ["core"],
    files: { "index.ts": fn("edgeIndex", [["../../core/src/shared.ts", "shared"]]), "work.ts": fn("edgeWork") },
  },
];

/** What each logical change touches, as `package:file`. */
function plan(): string[][] {
  const kinds: [number, string[]][] = [
    [6, ["lib2:p", "lib3:q"]],
    [6, ["big:m", "big:n"]],
    [5, ["core:util", "edge:work"]],
    [5, ["core:shared", "edge:work"]],
    [8, ["core:other", "core:index"]],
    [3, ["x:work"]],
    [3, ["y:work"]],
  ];
  const slots = kinds.flatMap(([count, touch], kind) => Array.from({ length: count }, (_, i) => ({ touch, kind, at: (i + 0.5) / count })));
  return slots.sort((a, b) => a.at - b.at || a.kind - b.kind).map(({ touch }) => touch);
}

const day = 24 * 60 * 60 * 1000;
const iso = (start: string, days: number): string => new Date(Date.parse(start) + days * day).toISOString().replace(/\.\d+Z$/, "Z");

/**
 * Packages built so that each way a candidate can defeat itself happens once:
 *
 * - `lib2` and `lib3` always change together, so they would merge, but their consumers use one each,
 *   so the merged package would be disjoint-reuse.
 * - `big` has two exports for two consumers, so it would split, but `m.ts` and `n.ts` change together,
 *   so the parts would be always-together.
 * - `edge` depends on `core`. `core/src/util.ts` changes with `edge` and only `core` imports it, so moving
 *   it into `edge` would make `core` depend on `edge` and close a cycle. `core/src/shared.ts` changes with
 *   `edge` too, and is imported on both sides.
 */
export function crossChecksRepository(): GitFixture {
  const steps: Step[] = [
    commit("Configure the suite", "2023-12-01T09:00:00Z", [
      add("package.json", json({ name: "mini", private: true, workspaces: ["packages/*"] })),
      add("code-health.json", json({ structure: { packages: { minComparable: 3, graceDays: 30 } } })),
    ]),
  ];
  specs.forEach((spec, i) => {
    steps.push(
      commit(`Add ${spec.name}`, iso("2023-12-02T09:00:00Z", i), [
        add(`packages/${spec.name}/package.json`, manifest(spec.name, spec.dependencies)),
        ...Object.entries(spec.files).map(([file, content]) => add(`packages/${spec.name}/src/${file}`, content)),
      ]),
    );
  });
  const revision = new Map<string, number>();
  plan().forEach((touch, i) => {
    const changes: Change[] = touch.map((target) => {
      const [pkg, file] = target.split(":") as [string, string];
      const path = `packages/${pkg}/src/${file}.ts`;
      const next = (revision.get(path) ?? 1) + 1;
      revision.set(path, next);
      const spec = specs.find((s) => s.name === pkg)!;
      const original = spec.files[`${file}.ts`]!;
      return modify(path, `${original}// revision ${next}\n`);
    });
    steps.push(commit(`Change ${touch.join(" and ")} (${i + 1})`, iso("2024-01-10T09:00:00Z", i * 2), changes, i % 2 === 0 ? alice : bob));
  });
  return GitFixture.build(steps);
}
