import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { runLocality } from "./support/run.ts";

const add = (path: string, content: string): Change => ({ op: "add", path, content });

/**
 * src/far/p/q/tool.ts is used from src/near/a and src/near/b, so it moves to src/near with gain. It also imports
 * src/far/p/q/inner/core.ts, which three files under src/far/ use and so stays: core.ts is a blocker. The report lists the
 * unit once, in the table of units held back by blockers, with the gain it would have without the blocker, and not
 * as a move the planner can plan.
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
          'import { a } from "./near/a/a.ts";\nimport { b } from "./near/b/b.ts";\nimport { x } from "./far/x.ts";\nimport { y } from "./far/y.ts";\nimport { z } from "./far/z.ts";\nexport const run = () => [a(), b(), x(), y(), z()];\n',
        ),
        add("src/near/a/a.ts", 'import { tool } from "../../far/p/q/tool.ts";\nexport const a = () => tool();\n'),
        add("src/near/b/b.ts", 'import { tool } from "../../far/p/q/tool.ts";\nexport const b = () => tool();\n'),
        add("src/far/p/q/tool.ts", 'import { core } from "./inner/core.ts";\nexport const tool = () => core();\n'),
        add("src/far/p/q/inner/core.ts", "export const core = () => 1;\n"),
        add("src/far/x.ts", 'import { core } from "./p/q/inner/core.ts";\nexport const x = () => core();\n'),
        add("src/far/y.ts", 'import { core } from "./p/q/inner/core.ts";\nexport const y = () => core();\n'),
        add("src/far/z.ts", 'import { core } from "./p/q/inner/core.ts";\nexport const z = () => core();\n'),
      ],
    },
    { type: "commit", message: "Add notes", date: "2025-01-01T09:00:00Z", changes: [add("NOTES.md", "Notes.\n")] },
  ]);
});
afterAll(() => repo.dispose());

test("a unit of kind move that has blockers is in the blocked table with its unblocked gain, and not in the table of plannable moves", async () => {
  const analysis = JSON.parse((await runLocality(repo.path, ["analyse", "--json", "--limit", "all"])).stdout).results as { path: string; recommendation: string; blockers: unknown[] }[];
  const tool = analysis.find((row) => row.path === "src/far/p/q/tool.ts");
  expect(tool).toMatchObject({ recommendation: "move" });
  expect(tool!.blockers).not.toEqual([]);
  const { stdout } = await runLocality(repo.path, ["report", "locality", "--format", "md", "--no-cache"]);
  const [beforeBlocked = "", blockedTable = ""] = stdout.split("**Units held back by blockers");
  expect(beforeBlocked).not.toMatch(/\| src\/far\/p\/q\/tool\.ts \| move \| src\/near/);
  expect(blockedTable).toMatch(/\| src\/far\/p\/q\/tool\.ts \| move \| \d+ \| \d+ \| src\/far\/p\/q\/inner\/core\.ts \|/);
  expect(blockedTable).toContain("Gain if the blockers were resolved (net distance removed)");
});
