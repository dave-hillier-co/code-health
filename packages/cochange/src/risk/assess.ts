import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { monthsBefore } from "@code-health/history/evidence";
import { readComponents } from "../components.ts";
import type { LoadedHistory } from "../history-access.ts";
import { extractChange, resolveRange, type BranchChange } from "./change.ts";
import { abandonedTouched } from "./abandoned-touched.ts";
import { liveMeasurements, readLocalityFanIn, withFanIn, type LocalityFanIn } from "./composition.ts";
import type { Factor } from "./factor.ts";
import { NO_EVIDENCE, readEvidence, type EvidenceInputs } from "./evidence-inputs.ts";
import { chronologicalPass, SECONDS_PER_MONTH, type PastChange } from "./history-pass.ts";
import type { HistoryState } from "./history-state.ts";
import { measureHistoryLayer, type ChangeFacts, type MeasureContext, type Measurement } from "./measure.ts";
import { mergedChanges, type Mainline } from "./merged-changes.ts";
import { baselineScores, impactOf, makeBander, SCORED_FACTORS, type BandResult, type ImpactResult } from "./scoring.ts";
import { readRiskSettings, type RiskSettings } from "./settings.ts";

export interface Assessed {
  change: BranchChange;
  /** The measurements before banding, for findings and placement to read. */
  measurements: Measurement[];
  factors: Factor[];
  impact: ImpactResult;
  baseline: {
    population: number;
    since: string;
    mergedChanges: number;
    merges: number;
    direct: number;
  };
  /** The state the change was measured against, and the history it came from. */
  state: HistoryState;
  history: LoadedHistory;
  risk: RiskSettings;
  mainline: Mainline;
  context: MeasureContext;
  facts: ChangeFacts;
  /** What the skill passed in with --evidence, and the locality report when one covers this tip. */
  evidence: EvidenceInputs;
  locality: LocalityFanIn | null;
  /** The abandonment report `abandoned-touched` was read from, when it was. */
  abandonment: { report: string; head: string; config: string } | null;
}

export function measureContext(context: CommandContext, history: LoadedHistory, risk: RiskSettings): MeasureContext {
  return {
    risk,
    minSupport: history.settings.minSupport,
    windowMonths: history.settings.windowMonths,
    recentMonths: history.settings.recentMonths,
    staleMonths: history.settings.staleMonths,
    hotspotPercentile: history.settings.hotspotPercentile,
    components: readComponents(context.config.effective.components),
  };
}

export function toFactor(measurement: Measurement, banded: BandResult, risk: RiskSettings): Factor {
  const disabled = risk.disabled.has(measurement.name);
  const status = disabled ? "disabled" : measurement.unavailable === null && banded.band !== "unavailable" ? "ok" : "unavailable";
  return {
    name: measurement.name,
    family: measurement.family,
    layer: measurement.layer,
    status,
    band: disabled ? null : banded.band === "unavailable" ? null : banded.band,
    scored: SCORED_FACTORS.has(measurement.name) && !disabled,
    value: disabled ? {} : measurement.value,
    guidelines: disabled ? {} : banded.guidelines,
    evidence: disabled ? [] : measurement.evidence,
    source: measurement.source,
    reason: disabled ? "switched off by cochange.risk.disable" : (measurement.unavailable ?? banded.reason),
  };
}

/**
 * The branch measured against its repository's own merged changes. The history before the base is
 * walked once, oldest first, so every past change is measured as of its own time, and the branch is
 * measured against the state at the base. Nothing after the base reaches the branch's score.
 */
export async function assessBranch(
  context: CommandContext,
  history: LoadedHistory,
  request: { range: string | undefined; worktree: boolean; evidence?: readonly string[] },
): Promise<Assessed> {
  const root = context.repo.root;
  const risk = readRiskSettings(context.config);
  const range = await resolveRange(root, { range: request.range, mainBranch: risk.mainBranch, worktree: request.worktree });
  const measure = measureContext(context, history, risk);

  const change = await extractChange(root, history.view, range, request.worktree, {
    similarity: history.settings.renameSimilarity,
    exclude: history.settings.exclude,
    owner: { localMailmap: history.identities.localMailmap, matcher: history.identities.matcher },
    agentPatterns: history.settings.identities.agentTrailerPatterns,
  });

  const evidence = request.evidence === undefined || request.evidence.length === 0
    ? NO_EVIDENCE
    : readEvidence(root, request.evidence, { base: change.base, head: change.head, worktree: request.worktree });
  const mainline = await mergedChanges(root, history.view, history.filtered.changes, range.base);
  const time = history.view.headDate;
  const since = monthsBefore(time, history.settings.windowMonths);
  const total = mainline.changes.length;
  const { state, past } = chronologicalPass(mainline.changes, measure, {
    windowMonths: history.settings.windowMonths,
    maxChangesetSize: history.settings.maxChangesetSize,
    fixPatterns: [...risk.fixPatterns, ...risk.revertPatterns],
    measureWhen: (c, index) => c.time >= since && index >= total - risk.baselineChanges,
  });

  const facts: ChangeFacts = {
    time,
    authors: authorEmails(change),
    files: change.files,
    moved: change.moved,
  };
  state.advance(time);
  const abandoned = await abandonedTouched(context, history, change);
  const measurements = [
    ...measureHistoryLayer(facts, state, measure),
    ...(await liveMeasurements(root, change, risk, evidence, abandoned.measurement)),
  ];
  const baselineMeasures = past.map((p) => p.measurements);
  const bander = makeBander(baselineMeasures, risk);
  const banded = measurements.map((m) => ({ m, result: bander(m) }));
  const locality = readLocalityFanIn(root, change.head);
  const touched = change.files.filter((file) => file.status !== "D").map((file) => file.fileId);
  // The parse layer is loaded when a change needs it, so the hook's bundle never carries the grammar loader.
  const { changedSignatures, withSignatures } = await import("./signatures.ts");
  const signatures = risk.disabled.has("blast-radius") ? null : await changedSignatures(root, change);
  const factors = banded.map(({ m, result }) => {
    let factor = toFactor(m, result, risk);
    if (factor.name !== "blast-radius" || factor.status === "disabled") return factor;
    if (locality !== null) factor = withFanIn(factor, touched, locality, risk);
    return signatures === null ? factor : withSignatures(factor, signatures, risk);
  });
  const impact = impactOf(
    factors.map((f) => ({ name: f.name, family: f.family, band: f.band ?? "unavailable", disabled: f.status === "disabled" })),
    baselineScores(baselineMeasures, risk),
    eventsOf(factors),
    risk,
  );
  return {
    change,
    measurements,
    factors,
    impact,
    baseline: {
      population: past.length,
      since: new Date(since * 1000).toISOString(),
      mergedChanges: total,
      merges: mainline.merges,
      direct: mainline.direct,
    },
    state,
    history,
    risk,
    mainline,
    context: measure,
    facts,
    evidence,
    locality,
    abandonment: abandoned.report,
  };
}

/** Lower-case emails of the people behind the change's commits. Bots, services and agents are not authors of record. */
export function authorEmails(change: BranchChange): string[] {
  return [...new Set([...change.owners.values()].filter((o) => o.kind === "person").map((o) => o.email.toLowerCase()))].sort();
}

/**
 * Three findings are events, not positions in a distribution: a high `missing-co-change`, any
 * `structure-delta`, and any `sensitive-paths` match. Together they raise the impact band once.
 */
export function eventsOf(factors: readonly Factor[]): string[] {
  const events: string[] = [];
  const get = (name: string) => factors.find((f) => f.name === name && f.status === "ok");
  if (get("missing-co-change")?.band === "high") events.push("missing-co-change");
  const structure = get("structure-delta");
  if (structure && Number(structure.value.count ?? 0) > 0) events.push("structure-delta");
  const sensitive = get("sensitive-paths");
  if (sensitive && Number(sensitive.value.count ?? 0) > 0) events.push("sensitive-paths");
  return events;
}

export { SECONDS_PER_MONTH };
export type { PastChange };
