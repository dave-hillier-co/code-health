import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { runLocality } from "./support/run.ts";

const add = (path: string, content: string): Change => ({ op: "add", path, content });

/**
 * Four tiny units in src/shared, each used once from src/feature, so each would be inlined or moved. One is
 * a plain helper, one declares an interface, one holds a class whose method overrides, one calls itself.
 */
let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Add the app",
      date: "2024-01-01T09:00:00Z",
      changes: [
        add("code-health.json", JSON.stringify({ entryPoints: ["src/main.ts"], locality: { useHistory: false } })),
        add(
          "src/main.ts",
          'import { run } from "./feature/deep/run.ts";\nexport const main = () => run();\n',
        ),
        add(
          "src/feature/deep/run.ts",
          [
            'import { plain } from "../../shared/plain.ts";',
            'import type { Shape } from "../../shared/shape.ts";',
            'import { Circle } from "../../shared/circle.ts";',
            'import { countdown } from "../../shared/countdown.ts";',
            "export function run(): number {",
            "  const shape: Shape = new Circle();",
            "  return plain() + shape.area() + countdown(3);",
            "}",
            "",
          ].join("\n"),
        ),
        add("src/shared/plain.ts", "export function plain(): number {\n  return 1;\n}\n"),
        add("src/shared/shape.ts", "export interface Shape {\n  area(): number;\n}\n"),
        add(
          "src/shared/circle.ts",
          'export class Circle {\n  area(): number {\n    return 3;\n  }\n}\nexport class Base {\n  area(): number {\n    return 0;\n  }\n}\nexport class Oval extends Base {\n  override area(): number {\n    return 2;\n  }\n}\n',
        ),
        add("src/shared/countdown.ts", "export function countdown(n: number): number {\n  return n <= 0 ? 0 : countdown(n - 1);\n}\n"),
      ],
    },
  ]);
});
afterAll(() => repo.dispose());

async function rows() {
  const run = await runLocality(repo.path, ["analyse", "--json", "--limit", "all"]);
  const found = JSON.parse(run.stdout).results as { path: string; recommendation: string; rule: string }[];
  return (path: string) => found.find((row) => row.path === path);
}

test("a plain helper with one consumer is still inlined", async () => {
  expect((await rows())("src/shared/plain.ts")).toMatchObject({ recommendation: "inline" });
});

test("a unit that declares an interface is reviewed, not inlined", async () => {
  expect((await rows())("src/shared/shape.ts")).toMatchObject({ recommendation: "review", rule: "interface-unit" });
});

test("a unit whose method overrides an inherited one is reviewed", async () => {
  expect((await rows())("src/shared/circle.ts")).toMatchObject({ recommendation: "review", rule: "overrides-inherited-method" });
});

test("a unit with a recursive function is reviewed", async () => {
  expect((await rows())("src/shared/countdown.ts")).toMatchObject({ recommendation: "review", rule: "recursive-unit" });
});
