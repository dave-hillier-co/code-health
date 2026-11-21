import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "@code-health/cli-kit/config";
import { monthsBefore } from "@code-health/history/evidence";
import { locateCache } from "@code-health/history/cache-location";
import { runGit } from "@code-health/history/git";
import { filterHistory } from "@code-health/history/noise";
import { readHistory } from "@code-health/history/read";
import { updateSession, type SessionState } from "@code-health/history/session-state";
import { openForRead } from "@code-health/history/store";
import { cochangeConfig, readSettings, type CochangeSettings } from "./config.ts";
import { confidenceOf, partnersOf } from "./coupling.ts";
import { repoRelative } from "./repo-paths.ts";
import { loadIdentityState } from "./identity-access.ts";

/** What Claude Code sends a hook on stdin. Only the fields the hook uses are read. */
interface HookInput {
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: { file_path?: unknown };
}

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

/** The tools whose edits the hook watches. */
export const WATCHED_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** The most partners one note names. */
const MAX_PARTNERS_NAMED = 3;

/**
 * The default time budget in milliseconds. Claude Code waits for the hook, so
 * a run that has not finished by then goes silent instead of slowing the
 * session. The hook's own timeout in `hooks.json` is a backstop above it.
 */
export const DEFAULT_BUDGET_MS = 250;

/** The directory holding `.git`, found by walking up from `start` with no process spawned. Undefined outside a repository. */
function findRepoRoot(start: string): string | undefined {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

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

/** One sentence naming the partners, in the form the spec shows. */
export function describeNote(file: string, partners: readonly { path: string; confidence: number; support: number }[]): string {
  const named = partners.map((p) => `\`${p.path}\` (confidence ${Math.round(p.confidence)} %, ${p.support} ${p.support === 1 ? "change" : "changes"})`);
  const list = named.length <= 1 ? named.join("") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  return `\`${file}\` usually changes with ${list}. Not yet edited in this session.`;
}

interface Decision {
  /** The sentence to inject, or null for silence. */
  note: string | null;
  outcome: string;
}

async function consider(root: string, file: string, settings: CochangeSettings, state: SessionState): Promise<Decision> {
  const location = await locateCache(root);
  const found = await commitsBehind(root, location.dbPath, settings.ref, settings.hook.maxCommitsBehind);
  if (!found) return { note: null, outcome: "silent: no cache within tolerance" };

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
  const named = partners
    .map((partner) => ({ path: partner.path, support: partner.support, confidence: confidenceOf(partner.support, changesFocus) }))
    .filter(
      (partner) =>
        partner.support >= settings.minSupport &&
        partner.confidence >= settings.hook.confidence &&
        !edited.has(partner.path) &&
        existsSync(join(root, partner.path)),
    )
    .sort((a, b) => b.confidence - a.confidence || b.support - a.support || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, MAX_PARTNERS_NAMED);
  if (named.length === 0) return { note: null, outcome: "silent: no unedited partner above the threshold" };
  return { note: describeNote(file, named), outcome: "spoke" };
}

/**
 * The change-set completeness hook, for a `PostToolUse` event on an edit.
 * Returns what to print on stdout: the `hookSpecificOutput` JSON, or the empty
 * string for silence. It never throws, never refreshes the cache and never
 * writes anything except its own session state, so the process can always exit 0.
 *
 * It is silent unless the repository enables it, the edited file is inside the
 * repository, the cache is no further behind than `cochange.hook.maxCommitsBehind`,
 * and the file has not been spoken about already this session.
 */
export async function runHook(request: HookRequest): Promise<string> {
  const started = request.startedAt ?? performance.now();
  try {
    const input = JSON.parse(request.stdin) as HookInput;
    const path = input.tool_input?.file_path;
    if (typeof input.session_id !== "string" || input.session_id === "" || typeof path !== "string") return "";
    if (typeof input.tool_name === "string" && !WATCHED_TOOLS.has(input.tool_name)) return "";

    const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : request.cwd;
    const root = findRepoRoot(cwd);
    if (root === undefined) return "";
    const settings = readSettings(loadConfig(root, cochangeConfig));
    if (!settings.hook.enabled) return "";

    const file = repoRelative(root, path);
    if (file.startsWith("..") || file.startsWith("/") || file === "") return "";

    // The edit is recorded first, under the lock, so it survives however the rest of the run ends.
    const state = updateSession(root, input.session_id, (current) => {
      if (!current.edited.includes(file)) current.edited.push(file);
    });

    const decision: Decision = state.spokenAbout.includes(file)
      ? { note: null, outcome: "silent: already spoke about this file" }
      : await within(request.budgetMs ?? DEFAULT_BUDGET_MS, started, consider(root, file, settings, state));
    updateSession(root, input.session_id, (current) => {
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

/** Resolves with the decision, or with silence when the budget is spent first. The work is abandoned, not awaited. */
function within(budgetMs: number, started: number, work: Promise<Decision>): Promise<Decision> {
  const remaining = Math.max(0, budgetMs - (performance.now() - started));
  return new Promise<Decision>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ note: null, outcome: "silent: over the time budget" }), remaining);
    work.then(
      (decision) => {
        clearTimeout(timer);
        resolve(decision);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
