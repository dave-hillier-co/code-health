import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { runLocality } from "./support/run.ts";

const add = (path: string, content: string): Change => ({ op: "add", path, content });

/**
 * The helper src/shared/u.ts is used from src/a once and from src/b four times, so its best place is src/b. But
 * src/b already imports src/a, so a helper there that src/a imports would make the two folders import each other.
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
        add("src/main.ts", 'import { p } from "./a/p.ts";\nimport { q } from "./b/q.ts";\nimport { w } from "./b/w.ts";\nexport const run = () => [p(), q(), w()];\n'),
        add("src/a/p.ts", 'import { u } from "../shared/u.ts";\nexport const p = () => u();\n'),
        add("src/a/dep.ts", "export const dep = () => 1;\n"),
        add("src/b/q.ts", 'import { u } from "../shared/u.ts";\nexport const q = () => u() + u() + u() + u();\n'),
        add("src/b/w.ts", 'import { dep } from "../a/dep.ts";\nexport const w = () => dep();\n'),
        add("src/shared/u.ts", "export function u(): number {\n  return 1;\n}\n"),
      ],
    },
  ]);
});
afterAll(() => repo.dispose());

test("a move whose target would make two folders import each other is reviewed, not moved", async () => {
  const run = await runLocality(repo.path, ["analyse", "--json", "--limit", "all"]);
  const rows = JSON.parse(run.stdout).results as { path: string; recommendation: string; rule: string; target: string }[];
  expect(rows.find((row) => row.path === "src/shared/u.ts")).toMatchObject({ target: "src/b", recommendation: "review", rule: "creates-cycle" });
});
