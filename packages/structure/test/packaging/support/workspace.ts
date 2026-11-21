import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { add, alice, bob, commit, modify, module } from "./scenarios.ts";

const carol: Identity = { name: "Carol", email: "carol@example.com" };

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

interface PackageSpec {
  name: string;
  private?: boolean;
  version?: string;
  bin?: boolean;
  dependencies?: string[];
  /** Outside packages the manifest declares. */
  externals?: string[];
  devDependencies?: string[];
  /** Without it the manifest names a `main`, and the package has no `exports` map. */
  exports?: boolean;
  /** Source files by name, relative to `src/`. */
  files: Record<string, string>;
  /** Test files by name, relative to `test/`. */
  tests?: Record<string, string>;
}

const scope = (name: string): string => `@acme/${name}`;

function manifest(spec: PackageSpec): string {
  return json({
    name: scope(spec.name),
    ...(spec.version === undefined ? {} : { version: spec.version }),
    ...(spec.private === false ? {} : { private: true }),
    ...(spec.bin ? { bin: { [spec.name]: "./bin.js" } } : {}),
    ...(spec.exports === false ? { main: "src/index.ts" } : { exports: { ".": "./src/index.ts" } }),
    dependencies: Object.fromEntries([...(spec.dependencies ?? []).map((d) => [scope(d), "*"]), ...(spec.externals ?? []).map((d) => [d, "^1.0.0"])]),
    devDependencies: Object.fromEntries((spec.devDependencies ?? []).map((d) => [scope(d), "*"])),
  });
}

const fn = (name: string, imports: [string, string][] = [], revision = 1): string => module(name, imports, revision);

const reexports = (names: string[]): string => `${names.map((n) => `export { ${n} } from "./${n}.ts";`).join("\n")}\n`;

/**
 * The packages of a small workspace, each a shape the findings look for.
 *
 * - `app` is the entry point.
 * - `shared` is used in disjoint parts by `ui`, `api`, `app` and `orphan`.
 * - `lib` is published, with five exports of which its consumers use one each, and three of which need
 *   outside packages that the others do not. It declares a fourth outside package it never imports.
 * - `lib-extra` is published and versioned beside `lib`: both change version in the same three commits.
 * - `helper` has one consumer, `api`, which also reaches into its internals: helper names only a `main`.
 * - `wrap` only re-exports `ui`.
 * - `p1` and `p2` import each other.
 * - `orphan` has no consumer and uses `shared` without declaring it.
 * - `ui` declares `orphan` without using it, and `api` imports an outside package that only the workspace root declares.
 * - `lib` and `testkit` form a cycle that only exists through a development dependency, and the
 *   tests of `helper` import `api`, which imports `helper`: a cycle through test code alone.
 */
export const workspace: PackageSpec[] = [
  {
    name: "shared",
    files: {
      "format.ts": fn("formatDate"),
      "money.ts": fn("formatMoney"),
      "ids.ts": fn("newId"),
      "log.ts": fn("log"),
      "index.ts": [
        'export { formatDate } from "./format.ts";',
        'export { formatMoney } from "./money.ts";',
        'export { newId } from "./ids.ts";',
        'export { log } from "./log.ts";',
        "",
      ].join("\n"),
      "work.ts": fn("sharedWork"),
    },
  },
  {
    name: "lib",
    private: false,
    version: "1.0.0",
    devDependencies: ["testkit"],
    externals: ["ajv", "yaml", "jsdiff", "left-pad"],
    files: {
      "parse.ts": fn("parse"),
      "render.ts": fn("render"),
      "validate.ts": fn("validate", [["ajv", "Ajv"]]),
      "serialize.ts": fn("serialize", [["yaml", "stringify"]]),
      "diff.ts": fn("diff", [["jsdiff", "createPatch"]]),
      "index.ts": reexports(["parse", "render", "validate", "serialize", "diff"]),
      "work.ts": fn("libWork"),
    },
  },
  {
    name: "lib-extra",
    private: false,
    version: "2.0.0",
    files: { "index.ts": fn("extra"), "work.ts": fn("libExtraWork") },
  },
  {
    name: "helper",
    exports: false,
    tests: { "helper.test.ts": fn("helperTest", [["@acme/api", "handle"]]) },
    files: {
      "index.ts": fn("help"),
      "secret.ts": fn("secret"),
      "toOrphan.ts": fn("toOrphan"),
      "work.ts": fn("helperWork"),
    },
  },
  {
    name: "ui",
    dependencies: ["shared", "lib", "lib-extra", "orphan"],
    files: {
      "index.ts": fn("view", [["@acme/shared", "formatDate"], ["@acme/lib", "render"], ["@acme/lib-extra", "extra"]]),
      "work.ts": fn("uiWork"),
    },
  },
  {
    name: "api",
    dependencies: ["shared", "helper"],
    files: {
      "index.ts": fn("handle", [
        ["@acme/shared", "formatMoney"],
        ["@acme/shared", "newId"],
        ["@acme/helper", "help"],
        ["@acme/helper/src/secret.ts", "secret"],
      ]),
      "work.ts": fn("apiWork"),
      // resolved through the workspace root, which declares it, and not through api's own manifest
      "internal.ts": fn("apiInternal", [["html-escaper", "escape"]]),
    },
  },
  {
    name: "wrap",
    dependencies: ["ui"],
    files: { "index.ts": 'export { view as wrapped } from "@acme/ui";\n', "work.ts": fn("wrapWork") },
  },
  {
    name: "orphan",
    files: { "index.ts": fn("orphan", [["@acme/shared", "newId"]]), "work.ts": fn("orphanWork") },
  },
  {
    name: "p1",
    dependencies: ["p2"],
    files: { "index.ts": fn("one", [["@acme/p2", "two"]]), "work.ts": fn("p1Work") },
  },
  {
    name: "p2",
    dependencies: ["p1"],
    files: { "index.ts": fn("two", [["@acme/p1", "one"]]), "work.ts": fn("p2Work") },
  },
  {
    name: "testkit",
    dependencies: ["lib"],
    files: { "index.ts": fn("fixture", [["@acme/lib", "parse"]]), "work.ts": fn("testkitWork") },
  },
  {
    name: "app",
    bin: true,
    exports: false,
    dependencies: ["ui", "api", "shared", "lib", "wrap", "p1"],
    devDependencies: ["testkit"],
    files: {
      "index.ts": fn("main", [
        ["@acme/wrap", "wrapped"],
        ["@acme/api", "handle"],
        ["@acme/shared", "log"],
        ["@acme/lib", "parse"],
        ["@acme/p1", "one"],
      ]),
      "work.ts": fn("appWork"),
    },
  },
];

// Most packages hold three files, so the two that hold two are the small ones.
for (const spec of workspace) {
  if (Object.keys(spec.files).length < 3 && spec.name !== "wrap" && spec.name !== "lib-extra") spec.files["internal.ts"] ??= fn(`${spec.name}Internal`);
}

const young: PackageSpec = { name: "young", files: { "index.ts": fn("young"), "work.ts": fn("youngWork") } };

/** What each logical change touches, in the order the history gets them. A `package:file` target names a file other than `work.ts`. */
function plan(): string[][] {
  const kinds: [count: number, touch: string[]][] = [
    [12, ["ui", "api"]],
    [3, ["ui"]],
    [3, ["api"]],
    [14, ["app", "shared"]],
    [35, ["shared"]],
    [2, ["app"]],
    [3, ["helper"]],
    [3, ["lib"]],
    [3, ["lib@version", "lib-extra@version"]],
    [4, ["p1", "p2"]],
    [1, ["orphan"]],
    [1, ["testkit"]],
    [1, ["wrap"]],
    [5, ["app", "shared", "helper"]],
    [5, ["orphan", "helper:toOrphan"]],
  ];
  const slots = kinds.flatMap(([count, touch], kind) => Array.from({ length: count }, (_, i) => ({ touch, kind, at: (i + 0.5) / count })));
  return slots.sort((a, b) => a.at - b.at || a.kind - b.kind).map(({ touch }) => touch);
}

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (start: string, days: number): string => new Date(Date.parse(start) + days * dayMs).toISOString().replace(/\.\d+Z$/, "Z");

const appIndex = (extra: [string, string][] = []): string =>
  fn("main", [["@acme/wrap", "wrapped"], ["@acme/api", "handle"], ["@acme/shared", "log"], ["@acme/lib", "parse"], ["@acme/p1", "one"], ...extra]);

/**
 * The workspace over a year. Every package is added one day apart from 2023-06-01, then a hundred and four
 * changes follow every three days, then `young` is added in May 2024. Every package except `young` is
 * older than the grace period at the end. The config relaxes two thresholds, so a hundred changes are enough.
 */
export function workspaceRepository(): GitFixture {
  const revision = new Map<string, number>();
  const steps: Step[] = [
    commit("Configure the suite", "2023-05-31T09:00:00Z", [
      add("package.json", json({ name: "acme", private: true, workspaces: ["packages/*"], devDependencies: { "html-escaper": "^3.0.0" } })),
      add("code-health.json", json({ structure: { packages: { followerReverseConfidence: 0.4, minLift: 1.4, wideChangeShare: 0.05 } } })),
    ]),
  ];
  workspace.forEach((spec, i) => {
    steps.push(
      commit(`Add ${spec.name}`, isoDay("2023-06-01T09:00:00Z", i), [
        add(`packages/${spec.name}/package.json`, manifest(spec)),
        ...Object.entries(spec.files).map(([file, content]) => add(`packages/${spec.name}/src/${file}`, content)),
        ...Object.entries(spec.tests ?? {}).map(([file, content]) => add(`packages/${spec.name}/test/${file}`, content)),
      ]),
    );
  });
  steps.push(commit("Test the app", "2023-06-14T09:00:00Z", [add("packages/app/test/app.test.ts", fn("appTest", [["@acme/testkit", "fixture"]]))]));
  const authors = [alice, bob, carol];
  const bumps = new Map<string, number>();
  plan().forEach((touch, i) => {
    const changes: Change[] = [];
    for (const target of touch) {
      if (target.endsWith("@version")) {
        const pkg = target.slice(0, -"@version".length);
        const spec = workspace.find((p) => p.name === pkg)!;
        const next = (bumps.get(pkg) ?? 0) + 1;
        bumps.set(pkg, next);
        changes.push(modify(`packages/${pkg}/package.json`, manifest({ ...spec, version: `${spec.version!.split(".")[0]}.0.${next}` })));
        continue;
      }
      const [pkg, file] = target.split(":") as [string, string | undefined];
      const path = `packages/${pkg}/src/${file ?? "work"}.ts`;
      const next = (revision.get(path) ?? 1) + 1;
      revision.set(path, next);
      changes.push(modify(path, fn(`${pkg}${file ?? "Work"}`, [], next)));
    }
    steps.push(commit(`Change ${touch.join(" and ")} (${i + 1})`, isoDay("2023-07-01T09:00:00Z", i * 3), changes, authors[i % authors.length]));
  });
  const app = workspace.find((p) => p.name === "app")!;
  steps.push(
    commit("Add young", "2024-05-20T09:00:00Z", [
      add("packages/young/package.json", manifest(young)),
      ...Object.entries(young.files).map(([file, content]) => add(`packages/young/src/${file}`, content)),
      modify("packages/app/package.json", manifest({ ...app, dependencies: [...(app.dependencies ?? []), "young"] })),
      modify("packages/app/src/index.ts", appIndex([["@acme/young", "young"]])),
    ]),
    commit("Tidy the app", "2024-06-20T09:00:00Z", [modify("packages/app/src/work.ts", fn("appWork", [], 99))]),
  );
  return GitFixture.build(steps);
}
