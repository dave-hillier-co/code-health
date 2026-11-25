import { usageError } from "@code-health/cli-kit/errors";
import type { Command } from "@code-health/cli-kit/run-cli";
import { listTree } from "@code-health/history/tree";
import { displayNameOf } from "../active-developers.ts";
import { goneLinesOf, reachesGuideline } from "../abandonment/knowledge-model.ts";
import { commonExtra, commonInputs, prepare } from "../abandonment/prepare.ts";
import { buildSuccessorIndex, hasNoSuccessor, successorsOf } from "../abandonment/successors.ts";
import { round4 } from "../abandonment/current.ts";
import { integerOption } from "../coupled-pairs.ts";
import { focusPath } from "../focus-path.ts";

export const name = "successors";

/**
 * Who could pick up a file's knowledge: active developers ranked by their changes to the files that
 * change with it, plus their own lines in it. Behind the privacy gate. Without `--names` a successor is
 * a rank and a score. With it the developer's name is shown, without the address, and only ever an active developer's:
 * the command never lists the people who have left, or the people whose departure would lose the most.
 */
export const command: Command = {
  summary: "Ranked successors for files at risk, from the files that change with them",
  options: { names: { type: "boolean" }, top: { type: "string" }, "no-refresh": { type: "boolean" } },
  async run(context) {
    if (context.positionals.length === 0) throw usageError("usage: successors PATH... [--names]");
    const names = context.values.names === true;
    const top = integerOption(context, "top", 5, 1, 1000);
    const p = await prepare(context);
    const { model } = p.knowledge;
    const present = new Set(await listTree(context.repo.root, p.history.view.headSha));
    const index = buildSuccessorIndex(p.history);

    const rows = [];
    for (const requested of context.positionals) {
      const path = await focusPath(context, p.history, requested);
      if (!present.has(path)) throw usageError(`${requested} is not a file at the analysed commit`);
      const successors = successorsOf(path, index, model);
      const file = model.files.find((f) => f.path === path);
      rows.push({
        path,
        abandoned: file !== undefined && reachesGuideline(goneLinesOf(file, model.developers), file.people, p.settings.abandonmentGuideline),
        coupledFiles: [...(index.partners.get(path) ?? [])]
          .map((c) => ({ path: c.path, degree: round4(c.degree), support: c.support }))
          .sort((a, b) => b.degree - a.degree || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
        candidates: successors.length,
        noSuccessor: hasNoSuccessor(successors),
        successors: successors.slice(0, top).map((s, i) => ({
          rank: i + 1,
          ...(names ? { developer: displayNameOf(s.developer) } : {}),
          score: s.score,
          coupledChanges: s.coupledChanges,
          ownShare: s.ownShare,
          evidence: s.evidence,
        })),
      });
    }
    return {
      inputs: commonInputs(p, "successors", {
        paths: rows.map((r) => r.path),
        names,
        top,
        minSupport: p.history.settings.minSupport,
      }),
      extra: commonExtra(p),
      results: rows,
      columns: ["path", "abandoned", "noSuccessor", "candidates", "coupledFiles", "successors"],
    };
  },
};
