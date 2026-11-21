import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

const ada: Identity = { name: "Ada", email: "ada@example.com" };
const grace: Identity = { name: "Grace", email: "grace@example.com" };

const add = (path: string, content: string): Change => ({ op: "add", path, content });
const modify = (path: string, content: string): Change => ({ op: "modify", path, content });

export interface RatesRepo {
  /** How many commits follow the first two. */
  rounds: number;
  /** Every this many rounds, the rates and the files that depend on them change in one commit. */
  every: number;
  /** When `lib/config/rates.yaml` was added, and so the earliest it can change with the billing files. The first commit is 2023-01-02. */
  ratesAdded?: string;
}

const revision = (path: string, round: number) => `${path} revision ${round}\n`;

/**
 * A repository in a language with no structural adapter: a rates file in `lib/config`, far from the two
 * billing files that always change with it, plus a notes file nobody depends on, changed by another author
 * in the rounds between. History is all there is. The last commit is on 2023-10-30, so it spans ten months.
 */
export function ratesRepo(options: RatesRepo): GitFixture {
  const steps: Step[] = [
    {
      type: "commit",
      message: "Add billing",
      date: "2023-01-02T09:00:00Z",
      author: ada,
      changes: [
        add("billing/invoice.txt", revision("invoice", 0)),
        add("billing/tax.txt", revision("tax", 0)),
        add("notes/notes.txt", revision("notes", 0)),
      ],
    },
  ];
  const ratesAdded = options.ratesAdded ?? "2023-01-03T09:00:00Z";
  let ratesExist = false;
  const day = (n: number) => new Date(Date.UTC(2023, 0, 10) + n * 86_400_000).toISOString().replace(".000Z", "Z");
  for (let round = 1; round <= options.rounds; round++) {
    const date = day(Math.floor((round * 290) / options.rounds));
    if (!ratesExist && date >= ratesAdded) {
      ratesExist = true;
      steps.push({ type: "commit", message: "Add rates", date: ratesAdded, author: ada, changes: [add("lib/config/rates.yaml", revision("rates", 0))] });
    }
    if (round % options.every === 0) {
      const paths = ["billing/invoice.txt", "billing/tax.txt", ...(ratesExist ? ["lib/config/rates.yaml"] : [])];
      steps.push({ type: "commit", message: `Change billing ${round}`, date, author: ada, changes: paths.map((path) => modify(path, revision(path, round))) });
    } else {
      steps.push({ type: "commit", message: `Notes ${round}`, date, author: grace, changes: [modify("notes/notes.txt", revision("notes", round))] });
    }
  }
  steps.push({ type: "commit", message: "Wrap up", date: "2023-10-30T09:00:00Z", author: grace, changes: [add("README.md", "Readme.\n")] });
  return GitFixture.build(steps);
}

/**
 * A TypeScript app whose import graph is tidy: `src/main.ts` imports `src/feature/report.ts` and `src/other/export.ts`,
 * each one folder away. The two never import each other, yet they change in the same commit every third round,
 * so the history says they belong together. The only entry point is src/main.ts, and the minimum distance is 3,
 * so one folder's hop is already near enough for the graph.
 */
export function hiddenCouplingApp(): GitFixture {
  const file = (name: string, round: number) => `export const ${name} = () => ${round};\n`;
  const main = 'import { report } from "./feature/report.ts";\nimport { exporter } from "./other/export.ts";\nexport const run = () => [report(), exporter()];\n';
  const steps: Step[] = [
    {
      type: "commit",
      message: "Add the app",
      date: "2023-01-02T09:00:00Z",
      author: ada,
      changes: [
        add("code-health.json", JSON.stringify({ entryPoints: ["src/main.ts"], locality: { minDistance: 3 } })),
        add("src/main.ts", main),
        add("src/feature/report.ts", file("report", 0)),
        add("src/other/export.ts", file("exporter", 0)),
        add("notes/notes.txt", "notes 0\n"),
      ],
    },
  ];
  for (let round = 1; round <= 60; round++) {
    const date = new Date(Date.UTC(2023, 0, 10) + Math.floor((round * 290) / 60) * 86_400_000).toISOString().replace(".000Z", "Z");
    if (round % 3 === 0) {
      steps.push({ type: "commit", message: `Change both ${round}`, date, author: ada, changes: [modify("src/feature/report.ts", file("report", round)), modify("src/other/export.ts", file("exporter", round))] });
    } else {
      steps.push({ type: "commit", message: `Notes ${round}`, date, author: grace, changes: [modify("notes/notes.txt", `notes ${round}\n`)] });
    }
  }
  steps.push({ type: "commit", message: "Wrap up", date: "2023-10-30T09:00:00Z", author: grace, changes: [add("README.md", "Readme.\n")] });
  return GitFixture.build(steps);
}
