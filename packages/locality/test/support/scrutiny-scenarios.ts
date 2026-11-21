import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";

const add = (path: string, content: string): Change => ({ op: "add", path, content });

/** The consumers of the shared text helpers, one file each, in three folders. */
const callers: Record<string, string> = {
  "src/orders/label.ts": [
    'import { clean } from "../shared/text.ts";',
    'export const label = (name: string) => clean(name, true, false).toUpperCase();',
    "",
  ].join("\n"),
  "src/orders/title.ts": [
    'import { clean } from "../shared/text.ts";',
    'export const title = (name: string | undefined) => clean(name ?? "", true, false) ?? "untitled";',
    "",
  ].join("\n"),
  "src/billing/memo.ts": [
    'import { clean, pad } from "../shared/text.ts";',
    'export const memo = (text: string) => pad(clean(text, true, false), 20);',
    "",
  ].join("\n"),
  "src/billing/code.ts": [
    'import { clean, pad } from "../shared/text.ts";',
    'export const code = (text: string) => pad(clean(text, true, false), 8, "0");',
    "",
  ].join("\n"),
  "src/reports/head.ts": [
    'import { clean, pad } from "../shared/text.ts";',
    "export const shout = (text: string) => clean(text, false, true);",
    "export const column = (text: string) => pad(text, 12);",
    "",
  ].join("\n"),
  "src/reports/stamp.ts": [
    'import { ordered, stamp } from "../shared/text.ts";',
    "export const report = (names: string[], when: Date) => [ordered(names), stamp(when)];",
    "",
  ].join("\n"),
};

/**
 * A text helper module that six files in three folders use: a function that switches behaviour on two flags
 * (one of which is passed false only once), an option almost nobody passes, a result several callers change,
 * a wrapper that fixes arguments, a locale-dependent function and one that sorts its argument in place.
 * The fan-in threshold is lowered to 6, so the module is scrutinised. The only entry point is src/main.ts.
 */
export function widelyUsed(): GitFixture {
  const changes: Change[] = [
    add("code-health.json", JSON.stringify({ entryPoints: ["src/main.ts"], locality: { highFanIn: 6 } })),
    add(
      "src/main.ts",
      [
        'import { label } from "./orders/label.ts";',
        'import { title } from "./orders/title.ts";',
        'import { memo } from "./billing/memo.ts";',
        'import { code } from "./billing/code.ts";',
        'import { column, shout } from "./reports/head.ts";',
        'import { report } from "./reports/stamp.ts";',
        "export const run = () => [label, title, memo, code, shout, column, report];",
        "",
      ].join("\n"),
    ),
    add(
      "src/shared/text.ts",
      [
        "export function clean(value: string, trim: boolean, upper: boolean): string {",
        "  let result = trim ? value.trim() : value;",
        "  if (upper) result = result.toUpperCase();",
        "  return result;",
        "}",
        "",
        "export function pad(value: string, width: number, fill?: string): string {",
        '  return value.padEnd(width, fill ?? " ");',
        "}",
        "",
        "export function ordered(values: string[]): string[] {",
        "  values.sort();",
        "  return values;",
        "}",
        "",
        "export function stamp(when: Date): string {",
        "  return when.toLocaleDateString() + when.getHours();",
        "}",
        "",
        "export const roll = (sides: number) =>",
        "  Math.random() * sides;",
        "",
      ].join("\n"),
    ),
    ...Object.entries(callers).map(([path, content]) => add(path, content)),
  ];
  // A file at a time, so history does not read the arrival as one bulk import, and old by the last commit.
  const arrival = changes.map(
    (change, index): Step => ({ type: "commit", message: `Add file ${index + 1}`, date: `2024-01-01T09:${String(index).padStart(2, "0")}:00Z`, changes: [change] }),
  );
  return GitFixture.build([
    ...arrival,
    { type: "commit", message: "Add notes", date: "2025-01-01T09:00:00Z", changes: [add("NOTES.md", "Notes.\n")] },
  ]);
}
