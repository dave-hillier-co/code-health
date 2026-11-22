import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@code-health/cli-kit/config";
import { readEditEvent, within } from "@code-health/history/hook-event";
import { runGit } from "@code-health/history/git";
import { updateSession, type FileMeasurement } from "@code-health/history/session-state";
import { hasSupportedExtension } from "@code-health/parse/supported-extensions";
import { complexityConfig, readSettings, thresholdsFor, type ComplexitySettings } from "./config.ts";
import { DEFAULT_BUDGET_MS } from "./hook-budget.ts";
import { describeFindings, findingsFor, measureFile } from "./hook-findings.ts";

export interface HookRequest {
  /** The raw stdin of the hook process. */
  stdin: string;
  /** The hook process's own working directory, used when the input names none. */
  cwd: string;
  /** Wall time the hook allows itself in milliseconds, counted from `startedAt`. Defaults to `DEFAULT_BUDGET_MS`. */
  budgetMs?: number;
  /**
   * When the budget starts counting, as a `performance.now()` reading. A hook process passes 0, Node's
   * time origin, so that process start is inside the budget. Defaults to the moment `runHook` is called.
   */
  startedAt?: number;
}

export { DEFAULT_BUDGET_MS };

/** Names the hook in its session state, apart from other plugins' hooks. */
const HOOK_NAME = "complexity";

const MAX_BYTES = 1_000_000;

interface Decision {
  /** The sentence to inject, or null for silence. */
  note: string | null;
  outcome: string;
  /** What the file measured as, to compare the next edit with. */
  measurement?: FileMeasurement;
}

/** The units of the file at HEAD, or none when it is not there (a new file) or cannot be measured. */
async function measurementAtHead(root: string, file: string, settings: ComplexitySettings): Promise<FileMeasurement> {
  try {
    const text = await runGit(root, ["show", `HEAD:${file}`]);
    const measured = measureFile(file, text, { ...settings, thresholds: thresholdsFor(settings, file) });
    return "measurement" in measured ? measured.measurement : {};
  } catch {
    return {};
  }
}

/** Whether the file is a test. The adapters that decide it are loaded here, and only when tests are not analysed, so a hook that never asks never parses them. */
async function isTestPath(file: string): Promise<boolean> {
  return (await import("@code-health/parse/languages")).isTestPath(file);
}

/** The command that breaks a unit down, for the files `explain` can read. It names the plugin's bundle when the host says where it is. */
function explainCommand(file: string): string | undefined {
  if (!hasSupportedExtension(file)) return undefined;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  return pluginRoot === undefined || pluginRoot === "" ? "complexity explain" : `node ${pluginRoot}/dist/complexity.mjs explain`;
}

async function consider(
  root: string,
  file: string,
  settings: ComplexitySettings,
  previous: FileMeasurement | undefined,
): Promise<Decision> {
  if (settings.isExcluded(file)) return { note: null, outcome: "printed nothing: the file is excluded" };
  if (!settings.analyseTests && (await isTestPath(file))) return { note: null, outcome: "printed nothing: tests are not analysed" };
  const text = readFileSync(join(root, file), "utf8");
  if (text.length > MAX_BYTES || text.includes("\0")) return { note: null, outcome: "printed nothing: the file is binary or too large" };

  const measured = measureFile(file, text, { ...settings, thresholds: thresholdsFor(settings, file) });
  if ("unmeasured" in measured) return { note: null, outcome: `printed nothing: no per-function metrics (${measured.unmeasured})` };

  const before = previous ?? (await measurementAtHead(root, file, settings));
  const findings = findingsFor(before, measured.measurement, thresholdsFor(settings, file), settings.delta);
  if (findings.length === 0) {
    return { note: null, outcome: "printed nothing: nothing went above a guideline or worsened", measurement: measured.measurement };
  }
  return { note: describeFindings(file, findings, explainCommand(file)), outcome: "printed", measurement: measured.measurement };
}

/**
 * The post-edit feedback hook, for a `PostToolUse` event on an edit. Returns what to print on stdout:
 * the `hookSpecificOutput` JSON, or the empty string when nothing is printed. It never throws, never refreshes the
 * cache and never writes anything except its own session state, so the process can always exit 0.
 *
 * It prints nothing unless the repository enables it, the edited file is inside the repository and measurable
 * by the lexical layer at the configured agreement bar, a unit went above a guideline or worsened by more
 * than `complexity.delta` since the session's last measurement of the file (or HEAD), and the file has
 * not been printed for already this session.
 */
export async function runHook(request: HookRequest): Promise<string> {
  const started = request.startedAt ?? performance.now();
  try {
    const event = readEditEvent(request.stdin, request.cwd);
    if (event === undefined) return "";
    const { root, file, sessionId } = event;
    const settings = readSettings(loadConfig(root, complexityConfig));
    if (!settings.hook.enabled) return "";

    // The edit is recorded first, under the lock, so it survives however the rest of the run ends.
    const state = updateSession(root, sessionId, HOOK_NAME, (current) => {
      if (!current.edited.includes(file)) current.edited.push(file);
    });

    const decision: Decision = state.spokenAbout.includes(file)
      ? { note: null, outcome: "printed nothing: already printed for this file" }
      : await within(request.budgetMs ?? DEFAULT_BUDGET_MS, started, consider(root, file, settings, state.measurements[file]), {
          note: null,
          outcome: "printed nothing: over the time budget",
        }).catch(() => ({ note: null, outcome: "printed nothing: could not measure the file" }));
    updateSession(root, sessionId, HOOK_NAME, (current) => {
      if (decision.note !== null && !current.spokenAbout.includes(file)) current.spokenAbout.push(file);
      if (decision.measurement !== undefined) current.measurements[file] = decision.measurement;
      current.lastRun = { outcome: decision.outcome, durationMs: Math.round(performance.now() - started) };
    });

    return decision.note === null
      ? ""
      : JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: decision.note } });
  } catch {
    return "";
  }
}
