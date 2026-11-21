import type { Rule } from "@code-health/cli-kit/run-cli";
import { monthsBefore } from "@code-health/history/evidence";
import { analysisCommand } from "../analysis-command.ts";
import { SECONDS_PER_DAY, byOption, isGrouped, isoDate, loadUnits, readBy } from "../units.ts";

export const name = "age";

export const rules: Record<string, Rule> = {
  cold: {
    summary: "Not changed within the stale window",
    explanation: [
      "A file (or component) is cold when its last revision is older than the stale window (cochange.staleMonths, default 12),",
      "measured back from the analysed commit's date, not the wall clock.",
      "",
      "Cold code is the lowest priority for refactoring and the cheapest to move: nothing recent depends on it staying put.",
      "Age is read over all usable history, so a file untouched for years is still listed.",
    ].join("\n"),
  },
};

export const command = analysisCommand(name, {
  summary: "First-seen and last-changed per file or component, oldest change first",
  options: byOption,
  wholeHistory: true,
  partial: isGrouped,
  async analyse({ context, history }) {
    const by = readBy(context);
    const anchor = history.view.headDate;
    const staleBefore = monthsBefore(anchor, history.settings.staleMonths);
    const units = await loadUnits(context, history);

    const rows = units.map((unit) => {
      const ageDays = Math.floor((anchor - unit.lastChanged) / SECONDS_PER_DAY);
      return {
        path: unit.name,
        score: ageDays,
        ...(by === "component" ? { files: unit.files } : {}),
        ageDays,
        firstSeen: isoDate(unit.firstSeen),
        lastChanged: isoDate(unit.lastChanged),
        revisions: unit.revisions,
        recommendation: unit.lastChanged < staleBefore ? "cold" : null,
      };
    });

    return {
      inputs: { by },
      results: rows,
      columns: ["path", "score", ...(by === "component" ? ["files"] : []), "ageDays", "firstSeen", "lastChanged", "revisions", "recommendation"],
    };
  },
});
