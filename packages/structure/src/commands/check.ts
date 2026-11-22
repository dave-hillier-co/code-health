import type { Command } from "@code-health/cli-kit/run-cli";
import { runGit } from "@code-health/history/git";
import { readSettings } from "../config.ts";
import { readLevel, type Level } from "../modules.ts";
import { CHECK_LEVELS, DEFAULT_CHECK_LEVELS, newSince, resolveBase, snapshotOf } from "../regressions.ts";

export const name = "check";

export const command: Command = {
  summary: "Exit 1 on import cycles or layer violations that are new since a base revision, for CI",
  options: { base: { type: "string" }, level: { type: "string" } },
  optionHelp: { base: "the revision to compare against (default: the configured base, else the merge base with the main branch)", level: "check one level only: default, file, folder or package (default: default, folder and package)" },
  async run(context) {
    const settings = readSettings(context.config);
    const { root } = context.repo;
    const levels: readonly Level[] =
      context.values.level === undefined ? DEFAULT_CHECK_LEVELS : [readLevel("level", context.values.level, CHECK_LEVELS, "default")];
    const headSha = (await runGit(root, ["rev-parse", "--verify", `${settings.ref}^{commit}`])).trim();
    const base = await resolveBase(root, headSha, settings, context.values.base as string | undefined);

    const [before, after] = await Promise.all([snapshotOf(root, base.sha, levels, settings), snapshotOf(root, headSha, levels, settings)]);
    const fresh = newSince(before, after);

    const rows = [
      ...fresh.cycles.map((cycle) => ({ kind: "cycle" as const, ...cycle })),
      ...fresh.layerViolations.map((violation) => ({ kind: "layer-violation" as const, ...violation })),
    ];
    return {
      inputs: { base: base.rev, baseSha: base.sha, analysed: headSha, levels: [...levels], layers: settings.layers.map((l) => l.name) },
      results: rows,
      columns: ["kind", "id", "level", "nodes", "breakingSet", "fromLayer", "toLayer"],
      failed: rows.length > 0,
    };
  },
};
