import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandOutput } from "@code-health/cli-kit/run-cli";
import { treeFromRef } from "@code-health/parse/source-tree";
import { readSettings } from "../config.ts";
import { pathArguments } from "../path-arguments.ts";
import { applyMove, isClean, moveMessage, textMentions } from "../move-apply.ts";
import { goPackagesOf } from "../project.ts";
import { planMove, type Refusal } from "../move-plan.ts";
import { isSourceFile } from "../movers/language.ts";
import { analyseRevision } from "../unit-analysis.ts";

export const name = "move";

export const command: Command = {
  summary: "Plan, or with --apply make, the move of one unit: file moves and import rewrites, as one move-only commit",
  usage: "<unit path>",
  optionHelp: {
    to: "the folder to move to (default: the analyser's target)",
    apply: "make the move as one commit instead of only planning it",
    reason: "why this differs from the recommendation, recorded in the commit message",
    "no-commit": "with --apply, leave the move in the working tree",
  },
  options: {
    to: { type: "string" },
    apply: { type: "boolean" },
    reason: { type: "string" },
    "no-commit": { type: "boolean" },
  },
  async run(context): Promise<CommandOutput> {
    const settings = readSettings(context.config);
    if (context.positionals.length !== 1) throw usageError("usage: move <unit path> [--to <folder>] [--reason <text>] [--apply [--no-commit]]");
    const unitPath = pathArguments(context.repo.root, [context.positionals[0] as string])[0] as string;
    const to = context.values.to;
    const reason = context.values.reason;
    for (const [option, value] of [["to", to], ["reason", reason]] as const) {
      if (value !== undefined && typeof value !== "string") throw usageError(`--${option} needs a value`);
    }
    const apply = context.values.apply === true;
    const commit = context.values["no-commit"] !== true;
    if (!apply && context.values["no-commit"] === true) throw usageError("--no-commit only applies with --apply");

    const { analysis, project } = await analyseRevision(context, settings, "HEAD");
    const candidate = [...analysis.candidates, ...analysis.placed, ...analysis.unproposed].find((entry) => entry.path === unitPath);
    if (candidate === undefined) {
      throw usageError(`"${unitPath}" is not a unit the analyser reports: run \`locality analyse\` and name one of its paths`);
    }

    const tree = await treeFromRef(context.repo.root, "HEAD");
    const plan = planMove(candidate, settings, new Set(tree.files.keys()), { to: to as string | undefined, reason: reason as string | undefined }, goPackagesOf(project));
    const refusals: Refusal[] = [...plan.refusals];
    if (apply && !(await isClean(context.repo.root))) {
      refusals.push({ code: "dirty-working-tree", detail: "commit or stash first: a move commit must hold only the move" });
    }

    // ts-morph is loaded only when a move is planned: it is most of the bundle, and `analyse` has no use for it.
    const { performMove } = await import("../move-engine.ts");
    const moved = plan.refusals.length === 0 ? await performMove(tree, plan.operations) : undefined;
    const mentions = moved === undefined ? [] : await textMentions(context.repo.root, plan, isSourceFile);

    for (const broken of moved?.breaks ?? []) refusals.push({ code: "does-not-compile", detail: broken });

    let sha: string | null = null;
    let applied = false;
    if (apply && moved !== undefined && refusals.length === 0) {
      sha = await applyMove(context.repo.root, plan, moved, moveMessage(candidate, plan, reason as string | undefined), commit);
      applied = true;
    }

    return {
      inputs: { unit: unitPath, to: to ?? null, apply, commit: apply ? commit : null, reason: reason ?? null },
      extra: {
        unit: { path: plan.unit, recommendation: plan.recommendation, rule: plan.rule, destination: plan.destination, fanIn: candidate.fanIn },
        mode: apply ? "apply" : "dry-run",
        applied,
        commit: sha,
        refusals,
        rewrites: moved?.rewrites ?? [],
        mentions,
        warnings: moved?.warnings ?? [],
        confirmations: moved?.confirmations ?? [],
      },
      results: plan.operations,
      columns: ["from", "to", "role"],
      failed: refusals.length > 0,
    };
  },
};
