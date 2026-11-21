import { baseRevision, violationsAt } from "../check.ts";
import type { Subcommand } from "../subcommand.ts";

export const check: Subcommand = {
  summary: "Exit 1 on package cycles, deep imports or undeclared dependencies added since a base revision, for CI",
  options: { base: { type: "string" } },
  async analyse({ context, history, model }) {
    const { root } = context.repo;
    const requested = typeof context.values.base === "string" ? context.values.base : undefined;
    const base = await baseRevision(root, requested, history.settings);
    const before = new Set((await violationsAt(root, base, history.settings)).map((v) => v.key));
    const now = await violationsAt(root, model.headSha, history.settings, model);
    const added = now.filter((v) => !before.has(v.key));
    return {
      inputs: { subcommand: "check", base },
      results: added,
      columns: ["kind", "packages", "detail"],
      extra: { summary: { head: model.headSha, base, added: added.length, existing: now.length - added.length } },
      failed: added.length > 0,
    };
  },
};
