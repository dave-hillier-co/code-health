import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

const alice: Identity = { name: "Alice", email: "alice@example.com" };

function commit(message: string, date: string, changes: Change[]): Step {
  return { type: "commit", message, date, author: alice, changes };
}

/** A module exporting one function that calls each of `uses`, so every import is also referenced. */
export function module(name: string, imports: [specifier: string, imported: string][], revision = 1): string {
  const head = imports.map(([specifier, symbol]) => `import { ${symbol} } from "${specifier}";`);
  const calls = imports.map(([, symbol]) => `${symbol}()`).join(" + ") || "0";
  return [...head, `export function ${name}(): number {`, `  return ${calls} + ${revision};`, "}", ""].join("\n");
}

export const layerConfig = {
  structure: {
    layers: [
      { name: "ui", paths: ["src/ui/**"] },
      { name: "domain", paths: ["src/domain/**"] },
      { name: "data", paths: ["src/data/**"] },
    ],
  },
};

const add = (path: string, content: string): Change => ({ op: "add", path, content });
const modify = (path: string, content: string): Change => ({ op: "modify", path, content });

const view = (extra: [string, string][] = []) => module("view", [["../domain/order.ts", "order"], ...extra]);
const order = (extra: [string, string][] = []) => module("order", [["../data/store.ts", "store"], ...extra]);

/**
 * Three layers, ui over domain over data, on main. src/data/store.ts imports
 * src/domain/rules.ts, an existing violation (data depends upwards). src/util/log.ts is in no layer
 * and imports a ui file, which is allowed.
 */
export function layersRepository(options: { config?: unknown } = {}): GitFixture {
  const fixture = GitFixture.create("main");
  fixture.apply([
    commit("Add the layers", "2024-01-10T09:00:00Z", [
      add("code-health.json", JSON.stringify(options.config ?? layerConfig)),
      add("src/ui/view.ts", view()),
      add("src/domain/order.ts", order()),
      add("src/domain/rules.ts", module("rules", [])),
      add("src/data/store.ts", module("store", [["../domain/rules.ts", "rules"]])),
      add("src/util/log.ts", module("log", [["../ui/view.ts", "view"]])),
    ]),
  ]);
  return fixture;
}

/** A feature branch whose only change is a harmless new import, downwards. */
export function cleanBranch(fixture: GitFixture): void {
  fixture.apply([
    { type: "branch", name: "clean", from: "main" },
    { type: "checkout", name: "clean" },
    commit("Use the store from the view", "2024-02-01T09:00:00Z", [
      modify("src/ui/view.ts", view([["../data/store.ts", "store"]])),
    ]),
  ]);
}

/**
 * A feature branch where the domain starts importing a ui file: a new layer violation, and with the
 * existing import of the domain from the view a new file cycle.
 */
export function violatingBranch(fixture: GitFixture): void {
  fixture.apply([
    { type: "branch", name: "feature", from: "main" },
    { type: "checkout", name: "feature" },
    commit("Let the domain open the view", "2024-02-01T09:00:00Z", [
      modify("src/domain/order.ts", order([["../ui/view.ts", "view"]])),
    ]),
  ]);
}
