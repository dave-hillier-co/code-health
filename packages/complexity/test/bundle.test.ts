import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { withoutMeta } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";
import { buildRepo } from "./support/scenarios.ts";

// A cold node and the grammars' wasm can take long on a loaded machine, and these suites run beside every other.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const dist = fileURLToPath(new URL("../../../plugins/code-health/dist", import.meta.url));

let installed: string;
let repo: GitFixture;
beforeAll(() => {
  // An installed plugin is a copy with no node_modules beside it, so the bundle must carry everything.
  installed = mkdtempSync(join(tmpdir(), "complexity-plugin-"));
  cpSync(dist, join(installed, "dist"), { recursive: true });
  repo = buildRepo();
});
afterAll(() => {
  rmSync(installed, { recursive: true, force: true });
  repo.dispose();
});

function bundled(...args: string[]) {
  return spawnSync("node", [join(installed, "dist", "complexity.mjs"), ...args], { cwd: repo.path, encoding: "utf8" });
}

test("the installed bundle gives the same answer as the source, with its grammars beside it", async () => {
  const run = bundled("analyse", "--json", "--limit", "all");
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  const source = await runComplexity(repo.path, ["analyse", "--json", "--limit", "all"]);
  expect(withoutMeta(run.stdout)).toBe(withoutMeta(source.stdout));
});

test("the installed bundle explains a function and describes a rule", () => {
  const explain = bundled("explain", "src/pricing.ts#price", "--json");
  expect(explain.status).toBe(0);
  expect(JSON.parse(explain.stdout).unit.metrics.cognitive).toBe(8);
  const rule = bundled("explain", "cognitive", "--json");
  expect(JSON.parse(rule.stdout).results.rule).toBe("cognitive");
});

test("the installed bundle exits 1 when check finds a violation and 0 when it does not", () => {
  repo.commit({
    message: "Make price worse",
    date: "2024-02-01T00:00:00+00:00",
    changes: [
      {
        op: "modify",
        path: "src/pricing.ts",
        content: "export function price(a: boolean, b: boolean, c: boolean, d: boolean): number {\n  if (a) {\n    if (b) {\n      if (c) {\n        if (d) {\n          return 1;\n        }\n      }\n    }\n  }\n  return 0;\n}\n",
      },
    ],
  });
  const worse = bundled("check", "--base", "HEAD~1", "--json");
  expect(worse.status).toBe(0);
  const config = JSON.stringify({ complexity: { guidelines: { cognitive: { warn: 6, high: 12 }, cyclomatic: { warn: 4, high: 8 } } } });
  repo.commit({ message: "Configure guidelines", date: "2024-02-02T00:00:00+00:00", changes: [{ op: "add", path: "code-health.json", content: config }] });
  const failing = bundled("check", "--base", "HEAD~2", "--json");
  expect(failing.status).toBe(1);
  expect(JSON.parse(failing.stdout).results.length).toBeGreaterThan(0);
});
