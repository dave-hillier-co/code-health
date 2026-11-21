import { usageError } from "@code-health/cli-kit/errors";
import type { Rule } from "@code-health/cli-kit/run-cli";
import { analysisCommand } from "../analysis-command.ts";
import { readRiskSettings } from "../risk/settings.ts";
import { resolveRange } from "../risk/change.ts";
import { explainFactor, explainRules } from "../risk/explain.ts";
import { runBacktest } from "../risk/run-backtest.ts";
import { runReviewers, runRisk } from "../risk/run-risk.ts";
import { findingRules } from "../risk/findings.ts";
import { assessBranch } from "../risk/assess.ts";

export const name = "risk";

export const rules: Record<string, Rule> = findingRules;

const SUBCOMMANDS = ["explain", "reviewers", "backtest"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

interface Parsed {
  sub: Subcommand | null;
  rest: string[];
}

function parse(positionals: readonly string[]): Parsed {
  const [first, ...rest] = positionals;
  return (SUBCOMMANDS as readonly (string | undefined)[]).includes(first)
    ? { sub: first as Subcommand, rest }
    : { sub: null, rest: [...positionals] };
}

function rangeOf(rest: readonly string[]): string | undefined {
  if (rest.length > 1) throw usageError("usage: risk [BASE[..HEAD]] [--worktree]");
  return rest[0];
}

export const command = analysisCommand(name, {
  summary: "How much a branch puts at risk before it is merged, and how to review it: risk [BASE[..HEAD]] | explain | reviewers | backtest",
  options: { worktree: { type: "boolean" }, evidence: { type: "string", multiple: true }, names: { type: "boolean" }, since: { type: "string" } },
  wholeHistory: true,
  // A branch is not the repository's own answer, so nothing here is stored as a whole-repository report.
  partial: () => true,
  async ref(context) {
    const { sub, rest } = parse(context.positionals);
    if (sub === "backtest" || (sub === "explain" && rest.length === 0)) return undefined;
    const risk = readRiskSettings(context.config);
    const range = await resolveRange(context.repo.root, {
      range: sub === "explain" ? undefined : rangeOf(rest),
      mainBranch: risk.mainBranch,
      worktree: context.values.worktree === true,
    });
    return range.head;
  },
  async analyse({ context, history }) {
    const { sub, rest } = parse(context.positionals);
    if (sub === "explain") {
      if (rest.length > 1) throw usageError("usage: risk explain [FACTOR]");
      const risk = readRiskSettings(context.config);
      if (rest[0] === undefined) return { inputs: { topic: "level" }, results: explainRules(risk) };
      return {
        inputs: { topic: rest[0], worktree: context.values.worktree === true },
        results: await explainFactor(rest[0], () => assessBranch(context, history, { range: undefined, worktree: context.values.worktree === true })),
      };
    }
    if (sub === "backtest") return runBacktest(context, history);
    if (sub === "reviewers") return runReviewers(context, history, rangeOf(rest));
    if (sub !== null) throw usageError(`risk ${sub} is not available yet`);
    return runRisk(context, history, rangeOf(rest));
  },
});
