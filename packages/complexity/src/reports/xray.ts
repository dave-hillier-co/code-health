import { CliError, usageError } from "@code-health/cli-kit/errors";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { ReportKind } from "@code-health/cli-kit/report-command";
import { analyseHistory } from "@code-health/history/evidence";
import { noCacheOption } from "@code-health/history/results-cache";
import type { Block } from "@code-health/report/block";
import type { ReportBuild } from "@code-health/report/report-model";
import { XRAY_ROWS, sharedChanges, xrayBlocks, xrayFigures, xraySlots, type XrayData, type XrayFunction } from "@code-health/report/xray";
import { command as analyse } from "../commands/analyse.ts";
import { readSettings, guidelinesFor } from "../config.ts";
import { currentTree, normalisePaths } from "../current-tree.ts";
import { fixHeader, fixOptionHelp, fixOptions, measureFixesFor } from "../fix-report.ts";
import { limitOf } from "../metrics.ts";
import type { UnitFixes } from "../fix-statistics.ts";

const isoDate = (value: string) => value.slice(0, 10);
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

interface AnalyseRow {
  path: string;
  unit: string;
  id: string;
  startLine: number;
  endLine: number;
  role: "production" | "test";
  cognitive?: number;
  cyclomatic?: number;
  nesting?: number;
  length?: number;
  labels?: string[];
}

function functionOf(row: AnalyseRow, fixes: ReadonlyMap<string, UnitFixes> | undefined): XrayFunction {
  const measured = fixes?.get(row.id);
  return {
    id: row.id,
    name: row.unit,
    startLine: row.startLine,
    endLine: row.endLine,
    length: number(row.length),
    cognitive: number(row.cognitive),
    nesting: number(row.nesting),
    cyclomatic: number(row.cyclomatic),
    labels: row.labels ?? [],
    // A function no analysed change touched has no revisions and no fixes, and one the history could not read has neither figure.
    revisions: fixes === undefined ? null : (measured?.revisions ?? 0),
    fixes: fixes === undefined ? null : (measured?.fixCommits ?? 0),
  };
}

export const xray: ReportKind = {
  summary: "The functions of one file with their length, complexity, revisions, fixes and code smells, and a judgement of each of the top 5",
  usage: "FILE",
  options: { ...fixOptions, ...noCacheOption },
  optionHelp: { ...fixOptionHelp, "no-cache": "compute the analysis and the fix statistics again instead of reading the stored ones" },
  async build(context: CommandContext): Promise<ReportBuild> {
    const paths = normalisePaths(context.positionals);
    if (paths.length !== 1) throw usageError("usage: complexity report xray FILE");
    const file = paths[0]!;
    const settings = readSettings(context.config);
    const forFile: CommandContext = { ...context, positionals: [file], values: { ...context.values, "include-tests": true } };

    const analysis = await analyse.run(forFile);
    const measured = (analysis.results as AnalyseRow[]).filter((row) => row.path === file);
    if (measured.length === 0) throw usageError(`no functions were measured in "${file}": name a source file of the current tree that a language adapter reads`);
    // The test code inside a production file, such as a Rust `#[cfg(test)]` module, is counted, not listed. A test file lists its tests.
    const production = measured.filter((row) => row.role !== "test");
    const rows = production.length === 0 ? measured : production;
    const testsLeftOut = measured.length - rows.length;

    const current = await currentTree(context);
    let fixes: ReadonlyMap<string, UnitFixes> | undefined;
    let changes: ReadonlyMap<string, ReadonlySet<string>> | undefined;
    let header: ReturnType<typeof fixHeader> | undefined;
    let fixProblem: string | undefined;
    try {
      const measured = await measureFixesFor(forFile, settings, current);
      fixes = measured.stats.units;
      changes = measured.stats.changes;
      header = fixHeader(measured.stats, measured.request, settings);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      fixProblem = error.message;
    }

    const guidelines = guidelinesFor(settings, file);
    const data: XrayData = {
      file,
      functions: rows.map((row) => functionOf(row, fixes)),
      allCommand: `complexity analyse ${file} --with-fixes --limit all`,
      guidelines: {
        cognitive: limitOf(guidelines, "cognitive"),
        cyclomatic: limitOf(guidelines, "cyclomatic"),
        nesting: limitOf(guidelines, "nesting"),
        note: "complexity.guidelines, the warn level",
      },
    };
    if (fixes !== undefined) data.shared = sharedChanges(data.functions, (id) => changes?.get(id));
    const above = data.functions.filter((fn) => fn.labels.length > 0).length;
    const touched = data.functions.filter((fn) => (fn.revisions ?? 0) > 0).length;

    const grade = fixes === undefined ? "not graded" : (await analyseHistory(context.repo.root, { ref: "HEAD", noise: { exclude: [...context.config.effective.exclude], botPatterns: settings.botPatterns, maxChangesetSize: settings.maxChangesetSize } })).evidence.grade;
    const commits = header?.commits;
    const excluded = header === undefined ? [] : [
      { what: "commits over --max-commits", count: header.commits.skippedBy.maxCommits },
      { what: "commits in oversized changes", count: header.commits.skippedBy.oversized },
      { what: "commits touching no source file", count: header.commits.skippedBy.noSourceFile },
      { what: "landed changes a fix exclude pattern removed", count: header.fixesExcluded.fixes },
    ];

    const summary: Block[] = [
      {
        type: "facts",
        caption: `Measures of ${file}`,
        facts: [
          { label: "Functions measured", value: String(data.functions.length) },
          ...(testsLeftOut === 0 ? [] : [{ label: "Test functions left out", value: String(testsLeftOut) }]),
          { label: "Functions with a code smell label", value: String(above) },
          ...(fixes === undefined ? [] : [{ label: "Functions changed in the window", value: String(touched) }]),
          ...(commits === undefined ? [] : [{ label: "Commits analysed", value: `${commits.analysed} of ${commits.inWindow} in the window` }]),
        ],
      },
      ...(fixProblem === undefined ? [] : [{ type: "notice" as const, level: "warning" as const, text: `Fix statistics are not available: ${fixProblem}` }]),
    ];

    return {
      title: `X-Ray of ${file}`,
      inputs: { file, fixes: fixes === undefined ? null : { maxCommits: header!.commits.maxCommits, evidence: Number(context.values.evidence ?? settings.fixes.evidence) } },
      header: {
        evidenceGrade: grade,
        historyWindow: header === undefined ? "no history was read for this report" : `${header.window.months} months of fix history, ${isoDate(header.window.since)} to ${isoDate(header.window.until)}`,
        excluded: excluded.filter((e) => e.count > 0),
      },
      sections: [
        { id: "summary", heading: "Summary", blocks: [...summary, ...xrayFigures(data), { type: "judgement", slot: "summary" }] },
        {
          id: "xray",
          heading: "X-Ray",
          blocks: [...xrayBlocks(data), ...xraySlots(data).map((slot): Block => ({ type: "judgement", slot: slot.id }))],
        },
      ],
      limits: [
        "Guidelines order and label results. They are heuristics for investigation and decide nothing.",
        `${data.functions.length <= XRAY_ROWS ? `The table lists every ${testsLeftOut === 0 ? "" : "production "}function of the file` : `The table lists the ${XRAY_ROWS} most complex of the file's ${data.functions.length} ${testsLeftOut === 0 ? "" : "production "}functions; \`complexity analyse ${file} --with-fixes --limit all\` lists every one`}, sorted by cognitive complexity, then cyclomatic complexity, highest first. Length has no guideline: a long, linear function is often clearer than five shallow fragments.`,
        ...(testsLeftOut === 0 ? [] : [`The ${testsLeftOut} functions of the file's inline test code are left out of the table and the judgements.`]),
        "Revisions and fixes are counts of landed changes in the window that touched the function, and a fix is a count of commit messages, not of defects.",
        ...(header?.shallow === true ? ["The clone is shallow, so history before its boundary is missing."] : []),
        ...(commits !== undefined && commits.skipped > 0 ? [`${commits.skipped} of ${commits.inWindow} commits in the window were not analysed (see what was excluded).`] : []),
        `Only the first ${xraySlots(data).length} functions have a judgement, because the table is ordered by cognitive complexity.`,
      ],
      slots: [
        {
          id: "summary",
          title: "Judgement: the file as a whole",
          about: { kind: "file", ref: file, label: file },
          task: "In at most three sentences, say what the table shows about this file: where its complexity is concentrated, and whether the functions that changed or were fixed most are the complex ones. Cite only values the table shows, and say so when there are no fix figures.",
          verdicts: [],
          maxChars: 500,
        },
        ...xraySlots(data),
        {
          id: "limits",
          title: "Judgement: what limits these results",
          about: { kind: "report", ref: "xray", label: file },
          task: "In at most three sentences, say what limits how far this X-Ray can be trusted, using only the evidence grade, the exclusions and the notices shown.",
          verdicts: [],
          maxChars: 500,
        },
      ],
    };
  },
};
