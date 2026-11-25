import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandContext, Rule } from "@code-health/cli-kit/run-cli";
import { analysisCommand } from "../analysis-command.ts";
import { readRiskSettings } from "../risk/settings.ts";
import { resolveRange } from "../risk/change.ts";
import { explainFactor, explainRules, staticFactor } from "../risk/explain.ts";
import { FACTOR_DOCS, factorDoc } from "../risk/factor-docs.ts";
import { runBacktest } from "../risk/run-backtest.ts";
import { evidenceFiles, runReviewers, runRisk } from "../risk/run-risk.ts";
import { findingRules } from "../risk/findings.ts";
import { assessBranch } from "../risk/assess.ts";

export const name = "risk";

export const rules: Record<string, Rule> = findingRules;

const SUBCOMMANDS = ["explain", "reviewers", "backtest"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/** What a run was asked for, with every argument checked. */
interface Request {
  sub: Subcommand | null;
  range: string | undefined;
  /** `risk explain FACTOR`: the factor named. */
  factor?: string;
  /** Answered from the definitions alone: `risk explain`, and `risk explain FACTOR` without a change to assess. */
  isStatic: boolean;
}

/**
 * Checks the positionals and options of a run. Called before any history or cache is read, so a mistyped
 * argument never starts a long run.
 */
function requestOf(context: CommandContext): Request {
  const [first, ...rest] = context.positionals;
  const sub = (SUBCOMMANDS as readonly (string | undefined)[]).includes(first) ? (first as Subcommand) : null;
  const words = sub === null ? [...context.positionals] : rest;
  const worktree = context.values.worktree === true;
  if (sub === "backtest") {
    if (words.length > 0) throw usageError("risk backtest takes no arguments");
    return { sub, range: undefined, isStatic: false };
  }
  if (sub === "explain") {
    if (words.length > 2) throw usageError("usage: risk explain [FACTOR [BASE[..HEAD]]]");
    const [factor, range] = words;
    if (factor === undefined) return { sub, range: undefined, isStatic: true };
    const doc = factorDoc(factor);
    if (!doc) throw usageError(`unknown factor "${factor}"; factors: ${FACTOR_DOCS.map((d) => d.name).join(", ")}`);
    // Placement factors are computed by `risk` itself, under the privacy rules, so explain only defines them.
    const isStatic = doc.family === "placement" || (range === undefined && !worktree);
    return { sub, range, factor, isStatic };
  }
  if (words.length > 1) throw usageError(sub === "reviewers" ? "usage: risk reviewers [BASE[..HEAD]] [--names]" : "usage: risk [BASE[..HEAD]] [--worktree]");
  if (sub === "reviewers" && context.values.evidence !== undefined) throw usageError("risk reviewers does not take --evidence");
  return { sub, range: words[0], isStatic: false };
}

const analysed = analysisCommand(name, {
  summary: "How much a branch puts at risk before it is merged, and how to review it: risk [BASE[..HEAD]] | explain [FACTOR [BASE[..HEAD]]] | reviewers",
  options: { worktree: { type: "boolean" }, evidence: { type: "string", multiple: true }, names: { type: "boolean" }, since: { type: "string" }, adopted: { type: "string" } },
  subcommands: {
    backtest: {
      summary: "Every merged change on the main line, scored as of itself, against whether it was later reverted or fixed within the follow-up window",
      options: ["since", "adopted", "no-refresh"],
      hidden: true,
    },
  },
  hiddenOptions: ["since", "adopted"],
  wholeHistory: true,
  // A branch is not the repository's own answer, so nothing here is stored as a whole-repository report.
  partial: () => true,
  async ref(context) {
    const request = requestOf(context);
    if (request.sub === "backtest") return undefined;
    const risk = readRiskSettings(context.config);
    const range = await resolveRange(context.repo.root, {
      range: request.range,
      mainBranch: risk.mainBranch,
      worktree: context.values.worktree === true,
    });
    return range.head;
  },
  async analyse({ context, history }) {
    const request = requestOf(context);
    const worktree = context.values.worktree === true;
    if (request.sub === "explain") {
      const factor = request.factor!;
      return {
        inputs: { topic: factor, range: request.range ?? null, worktree },
        results: await explainFactor(factor, () => assessBranch(context, history, { range: request.range, worktree, evidence: evidenceFiles(context) })),
      };
    }
    if (request.sub === "backtest") return runBacktest(context, history);
    if (request.sub === "reviewers") return runReviewers(context, history, request.range);
    return runRisk(context, history, request.range);
  },
});

export const command: Command = {
  ...analysed,
  async run(context) {
    const request = requestOf(context);
    if (!request.isStatic) return analysed.run(context);
    // The definitions need no history, so a static explain reads none and refreshes no cache.
    const risk = readRiskSettings(context.config);
    if (request.factor === undefined) return { inputs: { topic: "level" }, results: explainRules(risk) };
    return { inputs: { topic: request.factor, range: request.range ?? null }, results: staticFactor(request.factor) };
  },
};
