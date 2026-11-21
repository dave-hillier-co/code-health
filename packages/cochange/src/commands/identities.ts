import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { analyseIdentities } from "../identities/analysis.ts";
import { chooseLocation, readDecisionsInput, planApply, writePlan } from "../identities/apply.ts";
import { checkMapping } from "../identities/check.ts";
import { measureMapping } from "../identities/measure.ts";
import { classifyRows, listRows, proposeRows } from "../identities/views.ts";

export const name = "identities";

const SUBCOMMANDS = ["list", "propose", "classify", "apply", "check"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * Identity resolution. This is the suite's stated exception to keeping data
 * about people off: it shows the names and emails `git log` shows, plus dates
 * and areas as evidence. It never goes through `analysisCommand`, so its output
 * is never stored as a report for another plugin to read.
 */
export const command: Command = {
  summary: "Resolve who is who: list, propose, classify, apply and check the identity mapping",
  options: {
    "no-refresh": { type: "boolean" },
    unmapped: { type: "boolean" },
    from: { type: "string" },
    apply: { type: "boolean" },
    location: { type: "string" },
  },
  async run(context) {
    const [sub, ...rest] = context.positionals;
    if (!SUBCOMMANDS.includes(sub as Subcommand) || rest.length > 0) {
      throw usageError(`usage: identities <${SUBCOMMANDS.join("|")}>`);
    }
    const subcommand = sub as Subcommand;
    rejectOptionsOutsideTheirCommand(subcommand, context);
    const analysis = await analyseIdentities(context, { noRefresh: context.values["no-refresh"] === true });
    const stamps = Object.keys(analysis.history.identities.stamps).length > 0 ? { identityInputs: analysis.history.identities.stamps } : {};
    const inputs = (more: Record<string, unknown> = {}) => ({ subcommand, ...more, ...stamps });

    switch (subcommand) {
      case "list": {
        const unmapped = context.values.unmapped === true;
        return { inputs: inputs({ unmapped }), results: listRows(analysis, unmapped), columns: ["identity", "commits", "firstSeen", "lastSeen", "topAreas", "mappedTo", "kind", "unmapped"] };
      }
      case "propose":
        return { inputs: inputs(), results: proposeRows(analysis), columns: ["id", "kind", "strength", "counterEvidence", "suggestedCanonical", "members", "links"] };
      case "classify":
        return { inputs: inputs(), results: classifyRows(analysis), columns: ["kind", "identity", "commits", "source", "pattern", "decided"] };
      case "check": {
        const detail = await measureMapping(context, analysis);
        const { findings, failed } = checkMapping(analysis, detail);
        return {
          inputs: inputs(),
          extra: { measurement: detail.measurement },
          results: findings,
          columns: ["kind", "identities", "detail", "commits", "lines", "linesShare"],
          failed,
        } satisfies CommandOutput;
      }
      case "apply": {
        const from = context.values.from;
        if (typeof from !== "string") throw usageError("apply needs --from FILE, the decisions JSON prepared and approved");
        const location = chooseLocation(context.repo.root, context.values.location, analysis.history.settings.identities.location);
        const { input, hash } = readDecisionsInput(from, context.repo.root);
        const plan = planApply(context.repo.root, location, input, analysis);
        const write = context.values.apply === true;
        if (write) writePlan(context.repo.root, plan);
        return {
          inputs: inputs({ fromHash: hash, location, apply: write }),
          extra: { dryRun: !write, written: write && plan.dirty },
          results: plan.changes,
          columns: ["target", "change", "entry"],
        };
      }
    }
  },
};

function rejectOptionsOutsideTheirCommand(sub: Subcommand, context: CommandContext): void {
  const only: Record<string, Subcommand> = { unmapped: "list", from: "apply", apply: "apply", location: "apply" };
  for (const [option, owner] of Object.entries(only)) {
    if (context.values[option] !== undefined && sub !== owner) throw usageError(`--${option} belongs to identities ${owner}`);
  }
}
