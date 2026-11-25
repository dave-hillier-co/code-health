import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { runGit } from "@code-health/history/git";
import type { LoadedHistory } from "../history-access.ts";
import { writeReport } from "../reports.ts";
import { assessBranch } from "./assess.ts";
import { findingsOf } from "./findings.ts";
import { levelResult } from "./level-result.ts";
import { describePlacement, placementFor } from "./placement-result.ts";
import { describeChange } from "./result.ts";
import { reviewersFor, REVIEWERS_PER_AREA } from "./reviewers.ts";
import { readImpact } from "./scoring.ts";
import { readStoredBacktest } from "./stored-backtest.ts";

export function evidenceFiles(context: CommandContext): string[] {
  const value = context.values.evidence;
  return value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(String);
}

async function commitsSince(root: string, from: string, to: string): Promise<number | null> {
  try {
    return Number((await runGit(root, ["rev-list", "--count", `${from}..${to}`])).trim());
  } catch {
    return null;
  }
}

/** `risk [BASE[..HEAD]]`: the branch's impact, its placement when the privacy rules allow, the level when it has been earned, and every factor. */
export async function runRisk(context: CommandContext, history: LoadedHistory, range: string | undefined): Promise<CommandOutput> {
  const worktree = context.values.worktree === true;
  const assessed = await assessBranch(context, history, { range, worktree, evidence: evidenceFiles(context) });
  const placement = await placementFor(context, assessed, context.values["no-refresh"] === true);

  const stored = readStoredBacktest(context.repo.root, context.config.hash);
  const behind = stored === null ? null : await commitsSince(context.repo.root, stored.head, assessed.change.head);
  const level = levelResult(assessed, placement, stored, behind);

  // Abandonment is knowledge about people: its factor is shown here and not kept, though the files and probabilities of its own report are.
  const impactOnly = { kind: "assessment", change: describeChange(assessed), impact: assessed.impact, factors: assessed.factors };
  const keptFactors = assessed.factors.filter((f) => f.name !== "abandoned-touched" || f.status !== "ok");
  const keptImpact = readImpact(
    assessed.impact,
    keptFactors.map((f) => ({ name: f.name, family: f.family, band: f.band ?? "unavailable", disabled: f.status === "disabled", scored: f.scored })),
    assessed.risk,
  );
  const kept = { ...impactOnly, impact: keptImpact, factors: keptFactors };
  const inputs = {
    range: range ?? null,
    worktree,
    baseline: assessed.baseline,
    evidence: assessed.evidence.stamps,
    locality: assessed.locality?.input ?? null,
    abandonment: assessed.abandonment,
    backtest: stored === null ? null : { head: stored.head, config: context.config.hash },
  };
  // The impact factors are about code, and are kept. Placement is about a person, so neither it nor
  // anything derived from it (the level, the findings that rest on it) is ever written down.
  if (range === undefined && !worktree) await writeReport(context, "risk", { inputs, results: kept }, history.view.headSha);
  return {
    inputs,
    results: {
      ...impactOnly,
      placement: describePlacement(placement),
      level,
      findings: findingsOf(assessed, placement),
    },
  };
}

/** `risk reviewers [BASE[..HEAD]] [--names]`: who to ask to look at each touched area. Names only with `--names`. */
export async function runReviewers(context: CommandContext, history: LoadedHistory, range: string | undefined): Promise<CommandOutput> {
  const worktree = context.values.worktree === true;
  const names = context.values.names === true;
  if (context.values.evidence !== undefined) throw usageError("risk reviewers does not take --evidence");
  const assessed = await assessBranch(context, history, { range, worktree });
  const { areas, basis } = await reviewersFor(context, assessed, context.values["no-refresh"] === true);
  return {
    inputs: { range: range ?? null, worktree, names },
    results: {
      kind: "reviewers",
      names,
      basis,
      perArea: REVIEWERS_PER_AREA,
      areas: areas.map((area) => ({
        area: area.area,
        files: area.files,
        coupledFiles: area.coupledFiles,
        candidates: area.candidates.length,
        suggested: names ? area.candidates.slice(0, REVIEWERS_PER_AREA).map((c) => ({ name: c.name, email: c.email, authorship: c.authorship, coupledChanges: c.coupledChanges })) : null,
      })),
      note: names
        ? "Active developers only, as people to ask: ranked by authorship, their average share of the lines of the area's touched files they last wrote (0 to 1), then by coupledChanges, their changes in the window to the area's coupledFiles (files outside the change at the missing-co-change guidelines towards a touched file). coupledChanges is 0 for everyone in an area whose coupledFiles is 0. The change's own authors are not listed."
        : "Counts of active developers who could review each area, and of the files coupled with its touched files. Pass --names to see them.",
    },
    columns: ["area", "files", "coupledFiles", "candidates"],
  };
}
