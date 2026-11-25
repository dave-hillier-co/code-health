import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";

const add = (path: string, content: string): Change => ({ op: "add", path, content });

/** A function of `count` lines, so size guidelines are met without a wall of source. */
function longFunction(name: string, count: number): string {
  const body = Array.from({ length: count }, (_, index) => `  total += ${index + 1};`).join("\n");
  return `export function ${name}(): number {\n  let total = 0;\n${body}\n  return total;\n}\n`;
}

const featureCount = 8;

/**
 * Guards: a published package entry point, a function used as a value, and generated code that the suite
 * config excludes. The only entry point is src/app/main.ts.
 */
export function guardedUnits(): GitFixture {
  return GitFixture.build([
    {
      type: "commit",
      message: "Add the app and its library",
      date: "2024-01-01T09:00:00Z",
      changes: [
        add("code-health.json", JSON.stringify({ entryPoints: ["src/app/main.ts"], exclude: ["src/external"] })),
        add("package.json", JSON.stringify({ name: "lib", main: "src/shared/api.ts" })),
        add(
          "src/app/main.ts",
          [
            'import { api } from "../shared/api.ts";',
            'import { helper } from "../shared/helper.ts";',
            'import { generated } from "../generated/client.ts";',
            "export const run = () => [api(), [1].map(helper), generated()];",
            "",
          ].join("\n"),
        ),
        add("src/shared/api.ts", "export function api(): number {\n  return 1;\n}\n"),
        add("src/shared/helper.ts", "export function helper(value: number): number {\n  return value + 1;\n}\n"),
        add("src/external/client.ts", "export const generated = () => 1;\n"),
      ],
    },
    // The code is old by the time of the last commit, so the grace period does not hold anything back.
    { type: "commit", message: "Add notes", date: "2025-01-01T09:00:00Z", changes: [add("NOTES.md", "Notes.\n")] },
  ]);
}

/**
 * An app whose shared code lives far from the code that uses it: a two-consumer helper, a tiny and a large
 * one-consumer helper, a pass-through, a mixed helpers file, a barrel, a cycle, a heavily used formatter,
 * a dependency that blocks a move, and dead code. The only entry point is src/main.ts.
 */
export function distantHelpers(): GitFixture {
  const features = Array.from({ length: featureCount }, (_, index) => index + 1);
  const steps: Step[] = [
    {
      type: "commit",
      message: "Add the app",
      date: "2024-01-01T09:00:00Z",
      changes: [
        add("code-health.json", JSON.stringify({ entryPoints: ["src/main.ts"] })),
        add(
          "src/main.ts",
          [
            'import { place } from "./orders/place.ts";',
            'import { charge } from "./billing/index.ts";',
            'import { runFeatures } from "./features/all.ts";',
            'import { panel } from "./app/ui/panel.ts";',
            'import { core } from "./lib/kernel/core.ts";',
            'import { summary } from "./reports/summary.ts";',
            'import { describe } from "./reports/detail.ts";',
            "export const run = () => [place(), charge(), runFeatures(), panel(), core(), summary(), describe()];",
            "",
          ].join("\n"),
        ),
        add(
          "src/orders/place.ts",
          [
            'import { formatMoney } from "../shared/utils/money.ts";',
            'import { slugify } from "../shared/utils/slug.ts";',
            'import { audit } from "./audit.ts";',
            'import { orderLabel } from "../shared/helpers/mixed.ts";',
            'import { cycleStart } from "../shared/cycle/a.ts";',
            "export function place(): string {",
            '  return audit(slugify("order") + formatMoney(1) + orderLabel(1) + cycleStart());',
            "}",
            "",
          ].join("\n"),
        ),
        add(
          "src/orders/audit.ts",
          ['import { log } from "../shared/log.ts";', "export function audit(message: string): string {", "  return log(message);", "}", ""].join("\n"),
        ),
        add("src/billing/index.ts", 'export { charge } from "./charge.ts";\n'),
        add(
          "src/billing/charge.ts",
          [
            'import { formatMoney } from "../shared/utils/money.ts";',
            'import { invoiceTotal } from "../shared/utils/invoice.ts";',
            'import { invoiceLabel } from "../shared/helpers/mixed.ts";',
            'import { log } from "../shared/log.ts";',
            "export function charge(): string {",
            "  return log(formatMoney(invoiceTotal()) + invoiceLabel(2));",
            "}",
            "",
          ].join("\n"),
        ),
        add(
          "src/shared/utils/money.ts",
          [
            "export function formatMoney(amount: number): string {",
            '  return "$" + amount.toFixed(2);',
            "}",
            "export function unusedExport(): number {",
            "  return 0;",
            "}",
            "",
          ].join("\n"),
        ),
        add("src/shared/utils/slug.ts", 'export function slugify(text: string): string {\n  return text.toLowerCase().replace(/ /g, "-");\n}\n'),
        add(
          "src/shared/utils/slug.test.ts",
          'import { slugify } from "./slug.ts";\nexport const check = slugify("A B") === "a-b";\n',
        ),
        add("src/shared/utils/invoice.ts", longFunction("invoiceTotal", 160)),
        add("src/shared/log.ts", "export function log(message: string): string {\n  return message;\n}\n"),
        add(
          "src/shared/helpers/mixed.ts",
          [
            "export function orderLabel(id: number): string {",
            "  return `order-${id}`;",
            "}",
            "export function invoiceLabel(id: number): string {",
            "  return `invoice-${id}`;",
            "}",
            "",
          ].join("\n"),
        ),
        add("src/shared/cycle/a.ts", 'import { cycleEnd } from "./b.ts";\nexport function cycleStart(): string {\n  return cycleEnd();\n}\n'),
        add("src/shared/cycle/b.ts", 'import { cycleStart } from "./a.ts";\nexport function cycleEnd(): string {\n  return cycleStart.name;\n}\n'),
        add(
          "src/features/all.ts",
          [
            ...features.map((n) => `import { feature${n} } from "./feature${n}.ts";`),
            `export const runFeatures = () => [${features.map((n) => `feature${n}()`).join(", ")}];`,
            "",
          ].join("\n"),
        ),
        add(
          "src/shared/format.ts",
          "export function fmt(value: number, compact: boolean): string {\n  return compact ? String(value) : value.toFixed(2);\n}\n",
        ),
        ...features.map((n) =>
          add(
            `src/features/feature${n}.ts`,
            `import { fmt } from "../shared/format.ts";\nexport function feature${n}(): string {\n  return fmt(${n}, true);\n}\n`,
          ),
        ),
        add("src/app/ui/panel.ts", 'import { tool } from "../../lib/kernel/tool.ts";\nexport const panel = () => tool();\n'),
        add(
          "src/lib/kernel/tool.ts",
          [
            'import { core } from "./core.ts";',
            "export function tool(): number {",
            "  return core() + core() + core() + core() + core();",
            "}",
            "",
          ].join("\n"),
        ),
        add("src/lib/kernel/core.ts", "export function core(): number {\n  return 1;\n}\n"),
        add("src/reports/summary.ts", 'import { summarise } from "../shared/pair/a.ts";\nexport const summary = () => summarise();\n'),
        add("src/reports/detail.ts", 'import { detail } from "../shared/pair/b.ts";\nexport const describe = () => detail();\n'),
        add("src/shared/pair/a.ts", 'import { shared } from "./core.ts";\nexport function summarise(): string {\n  return shared() + "a";\n}\n'),
        add("src/shared/pair/b.ts", 'import { shared } from "./core.ts";\nexport function detail(): string {\n  return shared() + "b";\n}\n'),
        add("src/shared/pair/core.ts", 'export function shared(): string {\n  return "core";\n}\n'),
        add("src/legacy/dead.ts", 'import { formatMoney } from "../shared/utils/money.ts";\nexport const dead = () => formatMoney(0);\n'),
      ],
    },
  ];
  // One bulk commit would be taken for an import of history from elsewhere, and history would start after it.
  // The app arrives a file at a time, so no two files co-change, and is old by the time of the last commit.
  const [bulk, ...rest] = steps as [Extract<Step, { type: "commit" }>, ...Step[]];
  const arrival = bulk.changes.map((change, index): Step => ({
    ...bulk,
    message: `Add file ${index + 1}`,
    date: `2024-01-01T09:${String(index).padStart(2, "0")}:00Z`,
    changes: [change],
  }));
  return GitFixture.build([
    ...arrival,
    ...rest,
    { type: "commit", message: "Add notes", date: "2025-01-01T09:00:00Z", changes: [add("NOTES.md", "Notes.\n")] },
  ]);
}
