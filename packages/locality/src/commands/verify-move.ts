import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandOutput } from "@code-health/cli-kit/run-cli";
import { runGit } from "@code-health/history/git";
import { treeFromRef } from "@code-health/parse/source-tree";
import { readSettings } from "../config.ts";
import { pathArguments } from "../path-arguments.ts";
import { goPackagesOf, rustModulesOf } from "../project.ts";
import { planMove } from "../move-plan.ts";
import { analyseRevision } from "../unit-analysis.ts";

export const name = "verify-move";

export const command: Command = {
  summary: "Check that a commit made by hand reproduces the planned move of one unit, and changes nothing else",
  usage: "<unit path>",
  options: { commit: { type: "string" }, to: { type: "string" } },
  optionHelp: { commit: "the commit to check (default HEAD)", to: "the folder the unit was moved to (default: the analyser's target)" },
  async run(context): Promise<CommandOutput> {
    const settings = readSettings(context.config);
    if (context.positionals.length !== 1) throw usageError("usage: verify-move <unit path> [--commit <ref>] [--to <folder>]");
    const unitPath = pathArguments(context.repo.root, [context.positionals[0] as string])[0] as string;
    const ref = context.values.commit ?? "HEAD";
    const to = context.values.to;
    if (typeof ref !== "string" || (to !== undefined && typeof to !== "string")) throw usageError("--commit and --to need a value");

    const root = context.repo.root;
    let parent: string;
    try {
      const parents = (await runGit(root, ["rev-list", "--parents", "-n", "1", ref])).trim().split(" ");
      if (parents.length !== 2) throw new Error(parents.length < 2 ? "is a root commit" : "is a merge");
      parent = parents[1] as string;
    } catch (error) {
      throw usageError(`${ref} cannot be verified as a move: ${error instanceof Error ? error.message : String(error)}`);
    }

    // The plan is made from the code as it stood before the commit, so it cannot depend on what the commit did.
    const { analysis, project } = await analyseRevision(context, settings, parent);
    const candidate = [...analysis.candidates, ...analysis.placed, ...analysis.unproposed].find((entry) => entry.path === unitPath);
    if (candidate === undefined) throw usageError(`"${unitPath}" is not a unit the analyser reports for ${parent.slice(0, 10)}, the parent of ${ref}`);

    const parentTree = await treeFromRef(root, parent);
    const commitTree = await treeFromRef(root, ref);
    // Whether the analyser recommends the move is not what is being verified, so a reason always stands in for it.
    const plan = planMove(candidate, settings, new Set(parentTree.files.keys()), { to: to as string | undefined, reason: "verification" }, goPackagesOf(project), rustModulesOf(project));
    const message = await runGit(root, ["log", "-1", "--format=%B", ref]);
    const { verifyMove } = await import("../move-verify.ts");
    const verification = await verifyMove(parentTree, commitTree, plan.operations, message);
    const refusals = plan.refusals;
    const verified = verification.verified && refusals.length === 0;

    return {
      inputs: { unit: unitPath, commit: ref, parent, to: to ?? null },
      extra: {
        unit: { path: plan.unit, destination: plan.destination },
        verified,
        checks: verification.checks,
        refusals,
        operations: verification.operations,
        content: verification.content,
      },
      results: verification.operations.planned,
      columns: ["from", "to", "role"],
      failed: !verified,
    };
  },
};
