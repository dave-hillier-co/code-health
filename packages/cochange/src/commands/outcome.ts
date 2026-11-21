import { existsSync } from "node:fs";
import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { checkouts } from "@code-health/history/checkouts";
import { monthsBefore } from "@code-health/history/evidence";
import { readSession, sessionFile } from "@code-health/history/session-state";
import { listTree } from "@code-health/history/tree";
import { defaultProjectsDirectory } from "@code-health/transcripts/projects-dir";
import { differenceOf, type Arm } from "@code-health/transcripts/difference";
import { readRepoSessionEdits } from "@code-health/transcripts/session-edits";
import { parseWindow } from "@code-health/transcripts/time-window";
import { historySections, identityStamps } from "../analysis-command.ts";
import { compareArms, findOpportunities, rateOf, type SessionRecord } from "../outcome/completeness.ts";
import { chooseControls, figuresOf, inSpan, revisionsOf, sharingChanges, type Span } from "../outcome/spread-outcome.ts";
import { confidenceOf, partnersOf } from "../coupling.ts";
import { integerOption } from "../coupled-pairs.ts";
import { focusPath } from "../focus-path.ts";
import { loadHistory } from "../history-access.ts";
import { HOOK_NAME } from "../hook.ts";
import { parseDate } from "../spread-measure.ts";

export const name = "outcome";

const SUBCOMMANDS = ["completeness", "spread"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const isoDay = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

/**
 * The plugin's own outcome measures. `spread` sets change spread (and revisions) of the files acted on
 * beside similarly ranked files left alone, before and after a date. `completeness` measures, from session
 * transcripts, how often an agent's edit to a file is followed by an edit to a coupled file later in the
 * same session, with and without the completeness hook. Neither writes a report.
 */
export const command: Command = {
  summary: "Measure whether acting on findings worked: change spread against untouched files, and agent completeness with and without the hook",
  options: {
    at: { type: "string" },
    months: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    "projects-dir": { type: "string" },
    "min-samples": { type: "string" },
    noise: { type: "string" },
    "no-refresh": { type: "boolean" },
  },
  async run(context) {
    const [sub, ...rest] = context.positionals;
    if (!SUBCOMMANDS.includes(sub as Subcommand)) throw usageError(`usage: outcome <${SUBCOMMANDS.join("|")}> ...`);
    rejectOptionsOutsideTheirCommand(sub as Subcommand, context);
    if (sub === "spread") return spreadOutcome(context, rest);
    if (rest.length > 0) throw usageError("outcome completeness takes no paths");
    return completeness(context);
  },
};

function rejectOptionsOutsideTheirCommand(sub: Subcommand, context: CommandContext): void {
  const only: Record<string, Subcommand[]> = {
    at: ["spread"],
    months: ["spread"],
    since: ["completeness"],
    until: ["completeness"],
    "projects-dir": ["completeness"],
  };
  for (const [option, owners] of Object.entries(only)) {
    if (context.values[option] !== undefined && !owners.includes(sub)) throw usageError(`--${option} belongs to outcome ${owners.join(", ")}`);
  }
}

function day(context: CommandContext, option: string): string {
  const value = context.values[option];
  if (typeof value !== "string" || parseDate(value) === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw usageError(`--${option} is required and must be a date as YYYY-MM-DD`);
  }
  return value;
}

function monthsAfter(seconds: number, months: number): number {
  const date = new Date(seconds * 1000);
  date.setUTCMonth(date.getUTCMonth() + months);
  return Math.floor(date.getTime() / 1000);
}

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

async function spreadOutcome(context: CommandContext, requested: string[]): Promise<CommandOutput> {
  if (requested.length === 0) throw usageError("usage: outcome spread --at DATE PATH...: name the files the findings were acted on");
  const at = parseDate(day(context, "at"))!;
  const months = integerOption(context, "months", 3, 1, 60);
  const minSamples = integerOption(context, "min-samples", 10, 1, 1_000_000);
  const noise = integerOption(context, "noise", 10, 0, 100);

  const before: Span = { since: monthsBefore(at, months), until: at };
  const wanted: Span = { since: at, until: monthsAfter(at, months) };
  const history = await loadHistory(context, {
    noRefresh: context.values["no-refresh"] === true,
    window: { since: before.since, until: wanted.until },
  });
  // The after window stops at the analysed commit, and says so, so a short window is never mistaken for a quiet one.
  const after: Span = { since: at, until: Math.min(wanted.until, history.view.headDate + 1) };
  if (at > history.view.headDate) throw usageError(`--at ${isoDay(at)} is after the analysed commit`);

  const present = new Set(await listTree(context.repo.root, history.view.headSha));
  const acted = new Set<string>();
  for (const path of requested) {
    const resolved = await focusPath(context, history, path);
    if (!present.has(resolved)) throw usageError(`${path} is not a file at the analysed commit`);
    acted.add(resolved);
  }

  const all = history.filtered.changes;
  const beforeChanges = inSpan(all, before);
  const afterChanges = inSpan(all, after);
  const revisions = new Map([...revisionsOf(beforeChanges)].filter(([path]) => present.has(path)));
  for (const path of acted) if (!revisions.has(path)) revisions.set(path, 0);
  const overlap = sharingChanges([...beforeChanges, ...afterChanges], acted);
  const controls = chooseControls(revisions, [...acted], overlap);
  const control = new Set(controls.group);

  const arms = (ids: ReadonlySet<string>) => ({ before: figuresOf(beforeChanges, ids), after: figuresOf(afterChanges, ids) });
  const actedArms = arms(acted);
  const controlArms = arms(control);
  const spreadArm = (a: ReturnType<typeof arms>): Arm => ({
    before: { mean: a.before.spread.mean, n: a.before.spread.measured },
    after: { mean: a.after.spread.mean, n: a.after.spread.measured },
  });
  const revisionsArm = (a: ReturnType<typeof arms>): Arm => ({
    before: { mean: a.before.revisions.perFile, n: a.before.revisions.files },
    after: { mean: a.after.revisions.perFile, n: a.after.revisions.files },
  });

  return {
    inputs: { subcommand: "spread", at: isoDay(at), months, minSamples, noisePercent: noise, files: [...acted].sort(byBytes), ...identityStamps(history) },
    extra: historySections(history),
    results: {
      at: isoDay(at),
      windows: {
        before: { since: isoDay(before.since), until: isoDay(before.until) },
        after: { since: isoDay(after.since), until: isoDay(after.until), complete: after.until === wanted.until },
      },
      actedOn: { files: [...acted].sort(byBytes), ...actedArms },
      comparison: { files: [...control].sort(byBytes), pairs: controls.pairs, overlapping: controls.overlapping, ...controlArms },
      spread: { role: "primary outcome", ...differenceOf(spreadArm(actedArms), spreadArm(controlArms), minSamples, noise) },
      revisions: { role: "secondary outcome", ...differenceOf(revisionsArm(actedArms), revisionsArm(controlArms), minSamples, noise) },
    },
  };
}

async function completeness(context: CommandContext): Promise<CommandOutput> {
  const since = day(context, "since");
  const until = day(context, "until");
  const window = (() => {
    try {
      return parseWindow(since, until);
    } catch (error) {
      throw usageError(error instanceof Error ? error.message : String(error));
    }
  })();
  const minSamples = integerOption(context, "min-samples", 10, 1, 1_000_000);
  const noise = integerOption(context, "noise", 10, 0, 100);
  const projects = context.values["projects-dir"];
  if (projects !== undefined && (typeof projects !== "string" || projects === "")) throw usageError("--projects-dir needs a value");
  const projectsDir = typeof projects === "string" ? projects : defaultProjectsDirectory();

  const { root } = context.repo;
  const roots = await checkouts(root);
  const history = await loadHistory(context, { noRefresh: context.values["no-refresh"] === true });
  const { settings } = history;
  const present = new Set(await listTree(root, history.view.headSha));
  const identityOf = (path: string) => (present.has(path) ? path : history.view.renames.resolve(path, -1));
  const couplingChanges = history.filtered.changes.map((c) => ({ files: c.files.map((f) => f.fileId), oversized: c.oversized }));

  // The partners the hook would name for a file: the same support and confidence thresholds, and files that still exist.
  const cache = new Map<string, string[]>();
  const partnersNamed = (file: string): string[] => {
    const known = cache.get(file);
    if (known !== undefined) return known;
    const { changesFocus, partners } = partnersOf(couplingChanges, file);
    const named = partners
      .filter((p) => p.support >= settings.minSupport && confidenceOf(p.support, changesFocus) >= settings.hook.confidence && present.has(p.path))
      .map((p) => p.path);
    cache.set(file, named);
    return named;
  };

  const found = readRepoSessionEdits({ projectsDir, repoRoots: roots, window });
  const records: SessionRecord[] = found.map((session) => {
    // The hook ran in a session when it left state for it in one of the repository's checkouts.
    const holder = roots.find((r) => existsSync(sessionFile(r, session.sessionId, HOOK_NAME)));
    const state = holder === undefined ? null : readSession(holder, session.sessionId, HOOK_NAME);
    return {
      sessionId: session.sessionId,
      edits: session.edits.map(identityOf),
      hook: state !== null,
      spokenAbout: new Set((state?.spokenAbout ?? []).map(identityOf)),
    };
  });

  const opportunities = findOpportunities(records, partnersNamed);
  const hookSessions = new Set(records.filter((r) => r.hook).map((r) => r.sessionId));
  const inHook = opportunities.filter((o) => hookSessions.has(o.sessionId));
  const noHook = opportunities.filter((o) => !hookSessions.has(o.sessionId));
  const hookRate = rateOf(inHook);
  const noHookRate = rateOf(noHook);
  const comparison = compareArms(hookRate, noHookRate, minSamples, noise);

  return {
    inputs: {
      subcommand: "completeness",
      since,
      until,
      minSamples,
      noisePercent: noise,
      minSupport: settings.minSupport,
      confidence: settings.hook.confidence,
      ...identityStamps(history),
    },
    extra: historySections(history),
    results: {
      window: { since, until },
      sessions: { measured: records.length, withHook: hookSessions.size, withoutHook: records.length - hookSessions.size },
      withHook: { sessions: hookSessions.size, ...hookRate, briefed: rateOf(inHook.filter((o) => o.briefed)), notBriefed: rateOf(inHook.filter((o) => !o.briefed)) },
      withoutHook: { sessions: records.length - hookSessions.size, ...noHookRate },
      role: "agent outcome",
      difference: comparison.difference,
      smallestSample: Math.min(inHook.length, noHook.length),
      conclusion: comparison.conclusion,
      caveat: "Sessions were not assigned to the hook at random: a difference may come from the work, the period or the people, so read it as an association.",
    },
  };
}
