import type { Block } from "@code-health/report/block";
import type { MatrixData } from "@code-health/report/components/matrix";
import type { Assessed } from "../risk/assess.ts";
import { pairCoupled } from "../risk/measure.ts";

/** The most changed files drawn as rows, and the most missing partners drawn as columns after the changed files. */
export const FOOTPRINT_ROWS = 12;
export const FOOTPRINT_MISSING_COLUMNS = 10;
const LABEL = 20;

const label = (file: string) => (file.length <= LABEL ? file : `...${file.slice(file.length - LABEL + 3)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The change footprint: the changed files as rows, and as columns the same changed files followed by the missing
 * co-change partners the "Missing co-change partners" section lists. A cell holds the shared changes of the
 * row file and the column file in the analysis window: an integer, the unit of that section's support, and the
 * same from either side (the degree of coupling is a ratio of two counts and differs by side).
 *
 * A cell is marked "in the change" when the column is a changed file and the pair meets the support and
 * confidence guidelines from the row file's revisions (the rule that makes a partner), and "missing" at exactly
 * the (towards, file) pair of each row of the factor's evidence, so the marks match that section one for one,
 * with its thresholds and its manifest skips. A missing partner whose `towards` file is not drawn is counted as
 * left out, not drawn elsewhere.
 */
export function footprintBlocks(assessed: Assessed): Block[] {
  const { state, facts, context } = assessed;
  const factor = assessed.factors.find((f) => f.name === "missing-co-change");
  if (factor === undefined || factor.status !== "ok") return [];
  const missing = factor.evidence.flatMap((e) => (typeof e.file === "string" && typeof e.towards === "string" ? [{ file: e.file, towards: e.towards }] : []));
  const changed = facts.files.filter((f) => f.status !== "D").map((f) => f.fileId);
  const changedSet = new Set(changed);
  const coupled = (a: string, b: string) => {
    const support = state.partners(a).get(b) ?? 0;
    return support > 0 && state.present(b) && pairCoupled(support, state.eligibleRevisionsInWindow(a), context);
  };
  const ranked = changed
    .map((file) => ({
      file,
      missing: missing.filter((m) => m.towards === file).length,
      inChange: changed.filter((other) => other !== file && coupled(file, other)).length,
    }))
    .filter((s) => s.missing + s.inChange > 0)
    .sort((a, b) => b.missing - a.missing || b.inChange - a.inChange || (a.file < b.file ? -1 : 1));
  if (ranked.length === 0) {
    return [{ type: "notice", level: "notice", text: "Change footprint: no changed file has a usual co-change partner, in the change or missing from it, so there is no matrix to draw." }];
  }
  const rows = ranked.slice(0, FOOTPRINT_ROWS).map((s) => s.file);
  const rowSet = new Set(rows);
  const drawable = missing.filter((m) => rowSet.has(m.towards));
  const drawn = drawable.slice(0, FOOTPRINT_MISSING_COLUMNS);
  const columns = [...rows, ...drawn.map((m) => m.file)];
  const missingPairs = new Set(drawn.map((m) => `${m.towards}\0${m.file}`));
  const cells = rows.map((r) => columns.map((c) => (r === c ? null : (state.partners(r).get(c) ?? null))));
  const cellMarks = rows.map((r) => columns.map((c) => (missingPairs.has(`${r}\0${c}`) ? "missing" : changedSet.has(c) && r !== c && coupled(r, c) ? "in-change" : null)));
  const left: string[] = [];
  const undrawnRows = ranked.length - rows.length;
  if (undrawnRows > 0) left.push(`${plural(undrawnRows, "changed file")} with partners not drawn as ${undrawnRows === 1 ? "a row" : "rows"}`);
  const noPartners = changed.length - ranked.length;
  if (noPartners > 0) left.push(`${plural(noPartners, "changed file")} with no usual partner`);
  const undrawnMissing = missing.length - drawn.length;
  if (undrawnMissing > 0) left.push(`${plural(undrawnMissing, "missing partner")} not drawn as ${undrawnMissing === 1 ? "a column" : "columns"}, all of them listed under Missing co-change partners`);
  const data: MatrixData = {
    title: `Change footprint: ${plural(rows.length, "changed file")} against ${plural(columns.length, "file")}`,
    valueLabel: "shared changes of the row file and the column file in the analysis window",
    rows: rows.map(label),
    columns: columns.map(label),
    cells,
    marks: {
      "in-change": { symbol: "+", text: `a usual partner of the row file that the change also changed (at least ${context.minSupport} shared changes and ${assessed.risk.missingConfidence}% of the row file's revisions)` },
      missing: { symbol: "!", text: "a usual partner of the row file that the change left out, as listed under Missing co-change partners" },
    },
    cellMarks,
    orderText: `Columns are the changed files, then the missing partners. Rows are ordered by missing partners, then by partners in the change, then by path. Missing columns follow the order of the Missing co-change partners section, and each is marked at the file it usually changes with.${left.length === 0 ? "" : ` Left out: ${left.join("; ")}.`}`,
  };
  return [{ type: "matrix", ...data }];
}
