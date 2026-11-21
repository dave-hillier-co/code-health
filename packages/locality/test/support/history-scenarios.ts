import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";

const consumers = ["src/orders/place.ts", "src/billing/charge.ts", "src/reports/summary.ts"] as const;

const money = (revision = 0) => `export function money(): number {\n  return ${revision};\n}\n`;
const consumer = (name: string, revision: number) =>
  `import { money } from "../shared/utils/money.ts";\nexport const ${name} = () => money() + ${revision};\n`;
const nameOf = (path: string) => path.split("/")[1]!;

const commit = (message: string, date: string, changes: Change[]): Step => ({ type: "commit", message, date, changes });
const add = (path: string, content: string): Change => ({ op: "add", path, content });
const modify = (path: string, content: string): Change => ({ op: "modify", path, content });

export interface SharedHelper {
  /** How many of src/orders, src/billing and src/reports use the helper: 1, 2 or 3. */
  consumers: 1 | 2 | 3;
  /** Whether the consumers are always changed in one commit, or one at a time. */
  together: boolean;
  /** When the helper was added. The last commit is 2024-01-01. */
  helperAdded: string;
}

/**
 * A tiny helper, src/shared/utils/money.ts, far from its consumers, who change over 2023 either all in one
 * commit or one at a time, in a repository whose last commit is on 2024-01-01. The only entry point is src/main.ts.
 */
export function sharedHelper(options: SharedHelper): GitFixture {
  const used = consumers.slice(0, options.consumers);
  const imports = used.map((path) => `import { ${nameOf(path)} } from "./${path.slice(4)}";`);
  const main = `${imports.join("\n")}\nexport const run = () => [${used.map((path) => `${nameOf(path)}()`).join(", ")}];\n`;
  const steps: Step[] = [
    commit("Add the entry", "2023-01-01T09:00:00Z", [add("code-health.json", JSON.stringify({ entryPoints: ["src/main.ts"] })), add("src/main.ts", main)]),
    ...used.map((path, index) => commit(`Add ${path}`, `2023-01-0${index + 2}T09:00:00Z`, [add(path, consumer(nameOf(path), 0))])),
    commit("Add the helper", options.helperAdded, [add("src/shared/utils/money.ts", money())]),
  ];
  for (let round = 1; round <= 8; round++) {
    const date = `2023-0${(round % 8) + 2}-${10 + round}T09:00:00Z`;
    const changed = options.together ? used : [used[round % used.length]!];
    steps.push(commit(`Change round ${round}`, date, changed.map((path) => modify(path, consumer(nameOf(path), round)))));
  }
  steps.push(commit("Add notes", "2024-01-01T09:00:00Z", [add("NOTES.md", "Notes.\n")]));
  return GitFixture.build(steps);
}
