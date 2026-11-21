import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import type { LoadedHistory } from "../history-access.ts";
import { writeReport } from "../reports.ts";
import { assessBranch } from "./assess.ts";
import { describePlacement, placementFor } from "./placement-result.ts";
import { describeChange } from "./result.ts";

/** `risk [BASE[..HEAD]]`: the branch's impact, its placement when the privacy rules allow, and every factor. */
export async function runRisk(context: CommandContext, history: LoadedHistory, range: string | undefined): Promise<CommandOutput> {
  const worktree = context.values.worktree === true;
  const assessed = await assessBranch(context, history, { range, worktree });
  const placement = await placementFor(context, assessed, context.values["no-refresh"] === true);
  const impactOnly = { kind: "assessment", change: describeChange(assessed), impact: assessed.impact, factors: assessed.factors };
  const inputs = { range: range ?? null, worktree, baseline: assessed.baseline };
  // The impact factors are about code, and are kept. Placement is about a person, so neither it nor
  // anything derived from it (the level, the findings that rest on it) is ever written down.
  if (range === undefined && !worktree) await writeReport(context, "risk", { inputs, results: impactOnly }, history.view.headSha);
  return { inputs, results: { ...impactOnly, placement: describePlacement(placement) } };
}
