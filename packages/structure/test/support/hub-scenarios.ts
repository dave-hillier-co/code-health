import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

const authors: Identity[] = [
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
  { name: "Carol", email: "carol@example.com" },
];

export interface HubOptions {
  /** How the route table is edited: entries appended, or an existing line rewritten. */
  edits?: "append" | "rewrite";
  /** Distinct people who edit the route table, taking turns. */
  authors?: number;
  /** Features that each add three routes. */
  features?: string[];
}

const defaultFeatures = ["orders", "invoices", "users", "reports"];
const actions = ["", "New", "Export"];

/** A feature's page: a base function, then one more function for each stage reached. */
const page = (feature: string, stage: number): string => {
  const names = [`${feature}Base`, ...actions.slice(0, stage).map((action) => `${feature}${action}`)];
  return names.map((name) => `export function ${name}(): number {\n  return ${stage};\n}`).join("\n") + "\n";
};

const util = (revision: number): string => `export function util(): number {\n  return ${revision};\n}\n`;

/**
 * The route table of an app. The hub is src/routes.ts, which imports each feature's page and
 * lists a route for each. Every feature adds three routes in three commits, each commit also
 * changing the feature's page, so the hub changes with every feature while the features do not
 * change together. Forty-five unrelated commits to src/lib come first, so that sharing a change with
 * the hub is far from what chance predicts.
 */
export function hubRepository(options: HubOptions = {}): GitFixture {
  const features = options.features ?? defaultFeatures;
  const people = authors.slice(0, options.authors ?? 3);
  const edits = options.edits ?? "append";

  const imports: string[] = ['import { util } from "./lib/util.ts";'];
  const entries: string[] = [];
  let revision = 0;
  const routes = (): string => {
    const stamp = edits === "rewrite" ? [`export const revision = ${revision};`] : [];
    return [...imports, "", ...stamp, "export const routes = [", '  { path: "/", component: util },', ...entries, "];", ""].join("\n");
  };

  const steps: Step[] = [
    {
      type: "commit",
      message: "Add the app",
      date: "2024-01-05T09:00:00Z",
      author: authors[0],
      changes: [
        { op: "add", path: "src/routes.ts", content: routes() },
        { op: "add", path: "src/lib/util.ts", content: util(1) },
        ...features.map((feature): Change => ({ op: "add", path: `src/features/${feature}/page.ts`, content: page(feature, 0) })),
      ],
    },
  ];
  const at = (day: number): string => new Date(Date.UTC(2024, 0, 6 + day, 9)).toISOString().replace(".000Z", "Z");
  for (let i = 0; i < 45; i++) {
    steps.push({ type: "commit", message: `Tidy the library ${i}`, date: at(i), author: authors[i % 2], changes: [{ op: "modify", path: "src/lib/util.ts", content: util(i + 2) }] });
  }
  let turn = 0;
  let day = 50;
  for (const stage of [1, 2, 3]) {
    for (const feature of features) {
      const name = `${feature}${actions[stage - 1]}`;
      const path = `/${feature}${stage === 1 ? "" : `/${actions[stage - 1]!.toLowerCase()}`}`;
      revision += 1;
      imports.push(`import { ${name} } from "./features/${feature}/page.ts";`);
      if (edits === "append") entries.push(`  { path: "${path}", component: ${name} },`);
      else entries.splice(0, 1, `  { path: "${path}", component: ${name} },`);
      steps.push({
        type: "commit",
        message: `Add the ${path} route`,
        date: at((day += 3)),
        author: people[turn++ % people.length],
        changes: [
          { op: "modify", path: "src/routes.ts", content: routes() },
          { op: "modify", path: `src/features/${feature}/page.ts`, content: page(feature, stage) },
        ],
      });
    }
  }
  return GitFixture.build(steps);
}
