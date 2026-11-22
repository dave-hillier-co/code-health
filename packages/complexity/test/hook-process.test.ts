import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { loadConfig } from "@code-health/cli-kit/config";
import { WATCHED_TOOLS } from "@code-health/history/hook-event";
import { complexityConfig, readSettings } from "../src/config.ts";
import { DEFAULT_BUDGET_MS } from "../src/hook.ts";

// A cold node can take long on a loaded machine, and these suites run beside every other.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const plugin = join(root, "plugins", "complexity");
const manifest = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8"));

describe("the plugin's hook manifest", () => {
  test("registers exactly one hook, on PostToolUse for edits", () => {
    expect(Object.keys(manifest.hooks)).toEqual(["PostToolUse"]);
    expect(manifest.hooks.PostToolUse).toHaveLength(1);
    const [entry] = manifest.hooks.PostToolUse;
    expect(entry.matcher.split("|").sort()).toEqual([...WATCHED_TOOLS].sort());
    expect(entry.hooks).toHaveLength(1);
  });

  test("runs in exec form, with no shell, on the plugin's own bundle", () => {
    const [hook] = manifest.hooks.PostToolUse[0].hooks;
    expect(hook).toMatchObject({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/complexity.mjs", "hook"] });
    expect(hook.shell).toBeUndefined();
    expect(hook.async).toBeUndefined();
  });

  test("has Claude Code's own timeout as a backstop above the spec's budget of about 150 milliseconds", () => {
    const [hook] = manifest.hooks.PostToolUse[0].hooks;
    expect(DEFAULT_BUDGET_MS).toBe(150);
    expect(hook.timeout * 1000).toBeGreaterThan(DEFAULT_BUDGET_MS);
    expect(hook.timeout).toBeLessThanOrEqual(1);
  });

  test("is off in the shipped plugin: no repository config enables it and the plugin sets no default", () => {
    const pluginJson = JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
    expect(JSON.stringify(pluginJson)).not.toMatch(/"enabled"\s*:\s*true/);
    expect(readSettings(loadConfig(mkdtempSync(join(tmpdir(), "no-config-")), complexityConfig)).hook.enabled).toBe(false);
  });
});

const deep = `export function knot(a: number): number {
  if (a > 1) {
    if (a > 2) {
      if (a > 3) {
        return a;
      }
    }
  }
  return 0;
}
`;

let repo: GitFixture;
let installed: string;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Base",
      date: "2024-01-01T00:00:00+00:00",
      changes: [
        { op: "add", path: "code-health.json", content: JSON.stringify({ complexity: { thresholds: { nesting: 2 }, hook: { enabled: true } } }) },
        { op: "add", path: "src/knot.ts", content: "export const knot = 1;\n" },
      ],
    },
  ]);
  // An installed plugin is a copy with no node_modules beside it.
  installed = mkdtempSync(join(tmpdir(), "complexity-hook-"));
  cpSync(join(plugin, "dist"), join(installed, "dist"), { recursive: true });
});
afterAll(() => {
  rmSync(installed, { recursive: true, force: true });
  repo?.dispose();
});

/** The two real entry points: the TypeScript source under Node's own type stripping, and the committed bundle. */
const entries: [string, () => string][] = [
  ["the source entry point", () => join(root, "packages", "complexity", "src", "main.ts")],
  ["the committed bundle", () => join(installed, "dist", "complexity.mjs")],
];

for (const [label, entry] of entries) {
  describe(label, () => {
    const hook = (stdin: string) =>
      spawnSync(process.execPath, [entry(), "hook"], {
        cwd: repo.path,
        input: stdin,
        encoding: "utf8",
        // Claude Code never sets the override: it keeps a loaded test machine from making the hook go silent.
        env: { ...process.env, CODE_HEALTH_HOOK_BUDGET_MS: "60000" },
      });
    const event = (session: string) =>
      JSON.stringify({ session_id: session, cwd: repo.path, tool_name: "Edit", tool_input: { file_path: join(repo.path, "src", "knot.ts") } });

    test("answers a worsening edit on stdout in the hook output format, and exits 0", () => {
      writeFileSync(join(repo.path, "src", "knot.ts"), deep);
      const result = hook(event(label));
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).hookSpecificOutput).toEqual({
        hookEventName: "PostToolUse",
        additionalContext: expect.stringContaining("`knot` nesting depth is 3 in a new or renamed unit (guideline 2, ratio 1.5)") as string,
      });
    });

    test.runIf(label === "the committed bundle")("speaks within the shipped default budget, process start included, with no override", () => {
      writeFileSync(join(repo.path, "src", "knot.ts"), deep);
      // The bundle must be fast enough to finish inside the shipped budget. A loaded machine can make a cold
      // start slow, so the median of five fresh sessions is what counts: at least three must speak.
      const runs = [1, 2, 3, 4, 5].map((n) =>
        spawnSync(process.execPath, [entry(), "hook"], { cwd: repo.path, input: event(`${label}-default-${n}`), encoding: "utf8" }),
      );
      expect(runs.every((run) => run.status === 0 && run.stderr === "")).toBe(true);
      expect(runs.filter((run) => run.stdout.includes("`knot` nesting depth is 3")).length).toBeGreaterThanOrEqual(3);
    });

    test("is silent and writes no session state when the repository has not opted in", () => {
      const config = join(repo.path, "code-health.json");
      const enabled = readFileSync(config, "utf8");
      writeFileSync(config, JSON.stringify({ complexity: { thresholds: { nesting: 2 }, hook: { enabled: false } } }));
      writeFileSync(join(repo.path, "src", "knot.ts"), deep);
      try {
        const result = hook(event(`${label}-off`));
        expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
        expect(existsSync(join(repo.path, ".cache", "code-health", "sessions", `${label}-off.complexity.json`))).toBe(false);
      } finally {
        writeFileSync(config, enabled);
      }
    });

    test("exits 0 with nothing on stdout for the same file again, for stdin that is not JSON and for no stdin", () => {
      expect(hook(event(label))).toMatchObject({ status: 0, stdout: "" });
      expect(hook("not json")).toMatchObject({ status: 0, stdout: "" });
      expect(hook("")).toMatchObject({ status: 0, stdout: "" });
    });
  });
}
