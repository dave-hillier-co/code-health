import { workerEntry, type HookDefinition } from "@code-health/history/hook-process";
import { DEFAULT_BUDGET_MS } from "./hook-budget.ts";

/**
 * The post-edit feedback hook as the shared hook process runs it. The hook's work is loaded when it runs,
 * so the process that only waits for the worker never parses the lexer profiles, config and git code it
 * does not use, and neither process parses the CLI's commands.
 */
export const complexityHook: HookDefinition = {
  kind: "complexity-hook",
  run: async ({ stdin, cwd, budgetMs }) => (await import("./hook.ts")).runHook({ stdin, cwd, budgetMs }),
  defaultBudgetMs: DEFAULT_BUDGET_MS,
  entry: workerEntry(import.meta.url, "hook-definition.ts"),
};
