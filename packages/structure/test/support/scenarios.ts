import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const bob: Identity = { name: "Bob", email: "bob@example.com" };

function commit(message: string, date: string, changes: Change[], author = alice): Step {
  return { type: "commit", message, date, author, changes };
}

/** A module exporting one function that calls each of `uses`, so every import is also referenced. */
function module(name: string, imports: [specifier: string, imported: string][], revision = 1): string {
  const head = imports.map(([specifier, symbol]) => `import { ${symbol} } from "${specifier}";`);
  const calls = imports.map(([, symbol]) => `${symbol}()`).join(" + ") || "0";
  return [...head, `export function ${name}(): number {`, `  return ${calls} + ${revision};`, "}", ""].join("\n");
}

const files = {
  "src/a.ts": (r = 1) => module("alpha", [["./b.ts", "beta"]], r),
  "src/b.ts": (r = 1) => module("beta", [["./a.ts", "alpha"]], r),
  "src/c.ts": (r = 1) => module("gamma", [["./d.ts", "delta"]], r),
  "src/d.ts": (r = 1) => module("delta", [["./e.ts", "epsilon"]], r),
  "src/e.ts": (r = 1) => module("epsilon", [["./c.ts", "gamma"]], r),
  "src/ui/view.ts": (r = 1) => module("view", [["../core/model.ts", "model"]], r),
  "src/ui/format.ts": (r = 1) => module("format", [], r),
  "src/core/model.ts": (r = 1) => module("model", [["../ui/format.ts", "format"]], r),
  "packages/p1/src/x.ts": (r = 1) => module("px", [["../../p2/src/y.ts", "py"]], r),
  "packages/p1/src/z.ts": (r = 1) => module("pz", [], r),
  "packages/p2/src/y.ts": (r = 1) => module("py", [["../../p1/src/z.ts", "pz"]], r),
  "src/leaf.ts": (r = 1) => module("leaf", [["./a.ts", "alpha"]], r),
} as const;

type Path = keyof typeof files;

const add = (path: Path, revision = 1): Change => ({ op: "add", path, content: files[path](revision) });
const modify = (path: Path, revision: number): Change => ({ op: "modify", path, content: files[path](revision) });

/**
 * Five import cycles over six months ending 2024-06-01, one per shape:
 * a file pair (src/a.ts, src/b.ts), a file triangle (src/c.ts, d.ts, e.ts) whose
 * edges co-change unequally, a folder pair (src/ui, src/core) with no file cycle,
 * and a package pair (packages/p1, packages/p2) with no file cycle (its two
 * src folders form a folder cycle too). src/leaf.ts depends on a cycle member without being in it.
 */
export function cyclesRepository(): GitFixture {
  return GitFixture.build([
    commit("Add the modules", "2024-01-10T09:00:00Z", [
      ...(Object.keys(files) as Path[]).map((path) => add(path)),
      { op: "add", path: "packages/p1/package.json", content: '{ "name": "p1" }\n' },
      { op: "add", path: "packages/p2/package.json", content: '{ "name": "p2" }\n' },
    ]),
    commit("Change gamma and delta", "2024-02-01T09:00:00Z", [modify("src/c.ts", 2), modify("src/d.ts", 2)]),
    commit("Change gamma and delta again", "2024-02-20T09:00:00Z", [modify("src/c.ts", 3), modify("src/d.ts", 3)], bob),
    commit("Change gamma and delta once more", "2024-03-10T09:00:00Z", [modify("src/c.ts", 4), modify("src/d.ts", 4)]),
    commit("Change delta and epsilon", "2024-03-25T09:00:00Z", [modify("src/d.ts", 5), modify("src/e.ts", 2)], bob),
    commit("Change delta and epsilon again", "2024-04-10T09:00:00Z", [modify("src/d.ts", 6), modify("src/e.ts", 3)]),
    commit("Change the view", "2024-05-01T09:00:00Z", [modify("src/ui/view.ts", 2)], bob),
    commit("Change the model", "2024-05-20T09:00:00Z", [modify("src/core/model.ts", 2), modify("src/ui/format.ts", 2)]),
  ]);
}

/**
 * Two folder cycles with no file cycle behind either. src/app and its child src/app/feature import each
 * other, so that cycle is nested, and src/core and src/ui import each other, which is not. The nested one
 * sorts first by id, so only its being nested puts it last.
 */
export function nestedCyclesRepository(): GitFixture {
  return GitFixture.build([
    commit("Add the modules", "2024-01-10T09:00:00Z", [
      { op: "add", path: "src/app/main.ts", content: module("main", [["./feature/page.ts", "page"]]) },
      { op: "add", path: "src/app/shared.ts", content: module("shared", []) },
      { op: "add", path: "src/app/feature/page.ts", content: module("page", [["../shared.ts", "shared"]]) },
      { op: "add", path: "src/core/model.ts", content: module("model", [["../ui/format.ts", "format"]]) },
      { op: "add", path: "src/core/base.ts", content: module("base", []) },
      { op: "add", path: "src/ui/format.ts", content: module("format", []) },
      { op: "add", path: "src/ui/view.ts", content: module("view", [["../core/base.ts", "base"]]) },
    ]),
  ]);
}

/** One module importing another, no cycle anywhere. */
export function acyclicRepository(): GitFixture {
  return GitFixture.build([
    commit("Add the modules", "2024-01-10T09:00:00Z", [
      { op: "add", path: "src/a.ts", content: module("alpha", [["./b.ts", "beta"]]) },
      { op: "add", path: "src/b.ts", content: module("beta", []) },
    ]),
  ]);
}

const stabilityFiles: Record<string, (revision: number) => string> = {
  "src/stable/base.ts": (r) => module("base", [["../volatile/rules.ts", "rules"]], r),
  "src/stable/types.ts": (r) => module("types", [], r),
  "src/volatile/rules.ts": (r) => module("rules", [], r),
  "src/volatile/extra.ts": (r) => module("extra", [], r),
  "src/app/main.ts": (r) =>
    module("main", [["../stable/base.ts", "base"], ["../volatile/rules.ts", "rules"], ["../lib/api.ts", "api"]], r),
  "src/lib/api.ts": (r) => module("api", [["../glue/wire.ts", "wire"]], r),
  "src/glue/wire.ts": (r) =>
    module("wire", [["../stable/types.ts", "types"], ["../volatile/extra.ts", "extra"]], r),
  "src/ext/a.ts": (r) => module("extA", [["../lib/api.ts", "api"]], r),
  "src/ext/b.ts": (r) => module("extB", [["../lib/api.ts", "api"]], r),
};

/**
 * Folders that differ in how often they change. src/volatile changes in every
 * commit after the first; src/stable, src/glue, src/lib and src/ext only on the
 * day they were added. src/stable depends on src/volatile (against change
 * stability), src/glue also depends on it, and src/lib depends on src/glue,
 * which is more unstable structurally but has no change history to say so.
 */
export function stabilityRepository(): GitFixture {
  const steps: Step[] = [
    commit(
      "Add the modules",
      "2024-01-10T09:00:00Z",
      Object.entries(stabilityFiles).map(([path, content]): Change => ({ op: "add", path, content: content(1) })),
    ),
  ];
  const dates = ["2024-02-01", "2024-02-20", "2024-03-15", "2024-04-10", "2024-05-05"];
  dates.forEach((date, i) => {
    const revision = i + 2;
    const changes: Change[] = [{ op: "modify", path: "src/volatile/rules.ts", content: stabilityFiles["src/volatile/rules.ts"]!(revision) }];
    if (i === 3) changes.push({ op: "modify", path: "src/app/main.ts", content: stabilityFiles["src/app/main.ts"]!(2) });
    steps.push(commit(`Tune the rules ${i + 1}`, `${date}T09:00:00Z`, changes, i % 2 === 0 ? alice : bob));
  });
  return GitFixture.build(steps);
}

/**
 * One helper in src/y with three consumers: one in src/x and two in src/y itself,
 * so most of its consumers sit with it and not on the side that depends on it.
 */
export function misplacementRepository(): GitFixture {
  return GitFixture.build([
    commit("Add the modules", "2024-01-10T09:00:00Z", [
      { op: "add", path: "src/y/helper.ts", content: module("helper", []) },
      { op: "add", path: "src/y/one.ts", content: module("one", [["./helper.ts", "helper"]]) },
      { op: "add", path: "src/y/two.ts", content: module("two", [["./helper.ts", "helper"]]) },
      { op: "add", path: "src/x/a.ts", content: module("a", [["../y/helper.ts", "helper"]]) },
    ]),
  ]);
}
