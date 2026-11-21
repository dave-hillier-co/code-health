import { workerEntry, type HookDefinition } from "@code-health/history/hook-process";
import { DEFAULT_BUDGET_MS, runHook } from "./hook.ts";

/** The change-set completeness hook as the shared hook process runs it. */
export const cochangeHook: HookDefinition = {
  kind: "cochange-hook",
  run: ({ stdin, cwd, budgetMs }) => runHook({ stdin, cwd, budgetMs }),
  defaultBudgetMs: DEFAULT_BUDGET_MS,
  entry: workerEntry(import.meta.url, "hook-definition.ts"),
};
