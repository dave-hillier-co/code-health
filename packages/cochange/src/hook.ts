import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@code-health/cli-kit/config";
import { monthsBefore } from "@code-health/history/evidence";
import { readEditEvent, within } from "@code-health/history/hook-event";
import { locateCache } from "@code-health/history/cache-location";
import { runGit } from "@code-health/history/git";
import { filterHistory } from "@code-health/history/noise";
import { readHistory } from "@code-health/history/read";
import { updateSession, type SessionState } from "@code-health/history/session-state";
import { openForRead } from "@code-health/history/store";
import { cochangeConfig, readSettings, type CochangeSettings } from "./config.ts";
import { confidenceOf, partnersOf } from "./coupling.ts";
import { loadIdentityState } from "./identity-access.ts";

export interface HookRequest {
  /** The raw stdin of the hook process. */
  stdin: string;
  /** The hook process's own working directory, used when the input names none. */
  cwd: string;
  /** Wall time the hook allows itself in milliseconds, counted from `startedAt`. Defaults to `DEFAULT_BUDGET_MS`. */
  budgetMs?: number;
  /**
   * When the budget starts counting, as a `performance.now()` reading. A hook
   * process passes 0, Node's time origin, so that process start is inside the
   * budget. Defaults to the moment `runHook` is called.
   */
  startedAt?: number;
}

/** Names the hook in its session state, apart from other plugins' hooks. */
export const HOOK_NAME = "cochange";

/**
 * The default time budget in milliseconds. Claude Code waits for the hook, so
 * a run that has not finished by then prints nothing instead of slowing the
 * session. The hook's own timeout in `hooks.json` (1 second, the smallest it
 * takes) is a backstop above it.
 */
export const DEFAULT_BUDGET_MS = 200;

/** How many commits the cache is behind the ref, or undefined when it is further behind than `limit` or has no usable commit. */
async function commitsBehind(root: string, dbPath: string, ref: string, limit: number): Promise<{ behind: number; sha: string } | undefined> {
  const recent = (await runGit(root, ["rev-list", `--max-count=${limit + 1}`, ref])).split("\n").filter((sha) => sha !== "");
  if (recent.length === 0) return undefined;
  const db = openForRead(dbPath);
  if (!db) return undefined;
  try {
    const find = db.prepare("SELECT 1 AS found FROM commits WHERE sha = ?");
    const index = recent.findIndex((sha) => find.get(sha) !== undefined);
    return index === -1 ? undefined : { behind: index, sha: recent[index]! };
  } finally {
    db.close();
  }
}

/**
 * The note: the measured confidence and support of each partner named, how many more qualified, and the guideline
 * the confidence is read against. It suggests looking and states no rule.
 */
export function describeNote(
  file: string,
  partners: readonly { path: string; confidence: number; support: number }[],
  omitted: number,
  guideline: number,
): string {
  const q = (text: string): string => '`' + text + '`';
  const named = partners.map((p) => `${q(p.path)} (confidence ${Math.round(p.confidence)} %, ${p.support} ${p.support === 1 ? "change" : "changes"})`);
  const list = named.length <= 1 ? named.join("") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  const more = omitted === 0 ? "" : `, and ${omitted} more not named`;
  return `${q(file)} changed together with ${list}${more}. Guideline: confidence ${guideline} %. Not yet edited in this session, so worth a look.`;
}

interface Decision {
  /** The sentence to inject, or null to print nothing. */
  note: string | null;
  outcome: string;
}

async function consider(root: string, file: string, settings: CochangeSettings, state: SessionState): Promise<Decision> {
  const location = await locateCache(root);
  const found = await commitsBehind(root, location.dbPath, settings.ref, settings.hook.maxCommitsBehind);
  if (!found) return { note: null, outcome: "printed nothing: no cache within tolerance" };

  // The same filters the commands apply, so the hook's confidence agrees with brief and coupling.
  const identities = loadIdentityState(root, settings);
  const view = await readHistory(root, { ref: found.sha, firstParent: settings.firstParent, mailmapFile: identities.localMailmap });
  const filtered = await filterHistory(root, view, {
    exclude: settings.exclude,
    botPatterns: settings.botPatterns,
    nonPerson: identities.matcher,
    maxChangesetSize: settings.maxChangesetSize,
    grouping: settings.grouping,
    since: monthsBefore(view.headDate, settings.windowMonths),
    until: view.headDate + 1,
  });

  // A path that exists at the analysed commit names the file there; only a path that is gone is followed through renames.
  const exists = await runGit(root, ["cat-file", "-e", `${found.sha}:${file}`]).then(
    () => true,
    () => false,
  );
  const identity = exists ? file : view.renames.resolve(file, -1);

  const { changesFocus, partners } = partnersOf(
    filtered.changes.map((change) => ({ files: change.files.map((f) => f.fileId), oversized: change.oversized })),
    identity,
  );
  const edited = new Set(state.edited);
  const qualified = partners
    .map((partner) => ({ path: partner.path, support: partner.support, confidence: confidenceOf(partner.support, changesFocus) }))
    .filter(
      (partner) =>
        partner.support >= settings.minSupport &&
        partner.confidence >= settings.hook.confidence &&
        !edited.has(partner.path) &&
        existsSync(join(root, partner.path)),
    )
    .sort((a, b) => b.confidence - a.confidence || b.support - a.support || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (qualified.length === 0) return { note: null, outcome: "printed nothing: no unedited partner at or above the guideline" };
  const named = qualified.slice(0, settings.hook.maxPartners);
  return { note: describeNote(file, named, qualified.length - named.length, settings.hook.confidence), outcome: "printed a note" };
}

/**
 * The change-set completeness hook, for a `PostToolUse` event on an edit.
 * Returns what to print on stdout: the `hookSpecificOutput` JSON, or the empty
 * string when there is nothing to print. It never throws, never refreshes the cache and never
 * writes anything except its own session state, so the process can always exit 0.
 *
 * It prints nothing unless the repository enables it, the edited file is inside the
 * repository, the cache is no further behind than `cochange.hook.maxCommitsBehind`,
 * and no note has been printed for the file already this session.
 */
export async function runHook(request: HookRequest): Promise<string> {
  const started = request.startedAt ?? performance.now();
  try {
    const event = readEditEvent(request.stdin, request.cwd);
    if (event === undefined) return "";
    const { root, file, sessionId } = event;
    const settings = readSettings(loadConfig(root, cochangeConfig));
    if (!settings.hook.enabled) return "";

    // The edit is recorded first, under the lock, so it survives however the rest of the run ends.
    const state = updateSession(root, sessionId, HOOK_NAME, (current) => {
      if (!current.edited.includes(file)) current.edited.push(file);
    });

    const decision: Decision = state.spokenAbout.includes(file)
      ? { note: null, outcome: "printed nothing: already printed a note for this file" }
      : await within(request.budgetMs ?? DEFAULT_BUDGET_MS, started, consider(root, file, settings, state), {
          note: null,
          outcome: "printed nothing: over the time budget",
        });
    updateSession(root, sessionId, HOOK_NAME, (current) => {
      if (decision.note !== null && !current.spokenAbout.includes(file)) current.spokenAbout.push(file);
      current.lastRun = { outcome: decision.outcome, durationMs: Math.round(performance.now() - started) };
    });

    return decision.note === null
      ? ""
      : JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: decision.note } });
  } catch {
    return "";
  }
}
