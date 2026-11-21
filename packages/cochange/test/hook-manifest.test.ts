import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DEFAULT_BUDGET_MS } from "../src/hook.ts";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "cochange");
const manifest = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8"));

test("the plugin registers exactly one hook, on PostToolUse for edits", () => {
  expect(Object.keys(manifest.hooks)).toEqual(["PostToolUse"]);
  expect(manifest.hooks.PostToolUse).toHaveLength(1);
  const [entry] = manifest.hooks.PostToolUse;
  expect(entry.matcher.split("|").sort()).toEqual(["Edit", "MultiEdit", "Write"]);
  expect(entry.hooks).toHaveLength(1);
});

test("it runs in exec form, with no shell, on the plugin's own bundle", () => {
  const [hook] = manifest.hooks.PostToolUse[0].hooks;
  expect(hook).toMatchObject({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/cochange.mjs", "hook"] });
  expect(hook.shell).toBeUndefined();
  expect(hook.async).toBeUndefined();
});

test("Claude Code's own timeout is a backstop above the hook's time budget", () => {
  const [hook] = manifest.hooks.PostToolUse[0].hooks;
  expect(hook.timeout * 1000).toBeGreaterThan(DEFAULT_BUDGET_MS);
  expect(hook.timeout).toBeLessThanOrEqual(2);
});
