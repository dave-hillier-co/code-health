import { usageError } from "@code-health/cli-kit/errors";
import { analysePackages } from "../analysis.ts";
import { buildCandidates, type CandidateKind } from "../candidates.ts";
import type { Subcommand } from "../subcommand.ts";

const kinds: readonly CandidateKind[] = ["merge", "split", "move-unit", "narrow-interface", "fix-manifest", "break-dependency"];

export const candidates: Subcommand = {
  summary: "Ranked merge, split, move, narrow, fix and break candidates, each with its findings and the evidence against",
  options: { kind: { type: "string" } },
  async analyse({ context, model }) {
    const kind = context.values.kind;
    if (kind !== undefined && !(kinds as readonly unknown[]).includes(kind)) throw usageError(`--kind must be one of ${kinds.join(", ")}, not "${String(kind)}"`);
    const { candidates: found, withheld } = buildCandidates(model, await analysePackages(model, context.repo.root));
    return {
      inputs: { subcommand: "candidates", kind: (kind as string | undefined) ?? null },
      results: kind === undefined ? found : found.filter((c) => c.kind === kind),
      columns: ["id", "status", "changeCost", "step", "against", "findings"],
      extra: { withheld: kind === undefined ? withheld : withheld.filter((w) => w.kind === kind) },
    };
  },
};
