/**
 * The only module that knows the Claude Code session transcript format. The
 * format is internal to Claude Code and can change, so everything else works on
 * the normalised events returned here, and a transcript from a version this
 * module does not recognise is reported as not measured rather than guessed.
 *
 * Format as observed (Claude Code 2.1.x): one JSON object per line. Lines of
 * type `user` and `assistant` carry `version`, `timestamp`, `isSidechain` and a
 * `message`. An assistant message is written as one line per content block, all
 * sharing `message.id` and repeating the same `message.usage`. A human prompt is
 * a `user` line with no `toolUseResult` whose `origin.kind` is absent or
 * `human`, and which is not synthetic: compaction summaries (`isCompactSummary`), lines shown only
 * in the transcript, and `[Request interrupted by user...]` markers are not prompts. Every other line
 * type is metadata and ignored.
 *
 * Choices that shape the numbers:
 * - Token usage is taken from the last line seen for a `message.id`, since the final line is the one
 *   that can carry the completed usage.
 * - Sidechain lines (subagent turns) are left out. Effort is the main agent's: reads, edits and tokens
 *   spent inside delegated subagents are not counted, so a task that delegates looks cheaper than it was.
 * - An assistant line with no id, timestamp or content array (a synthetic API error, say) is skipped and
 *   counted in `skippedLines` rather than failing the session, as are lines that are not JSON.
 *
 * Only paths and counts leave this module. Message text, tool output and tool
 * inputs other than path fields are never copied.
 */

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export type ActionKind = "read" | "search" | "edit";

export interface ToolAction {
  kind: ActionKind;
  /** The path as written in the tool call, or null when the call named none. */
  path: string | null;
}

export type SessionEvent =
  | { kind: "prompt"; timestamp: string }
  | { kind: "agent-turn"; timestamp: string; messageId: string; tokens: TokenCounts; actions: ToolAction[] };

export type ParsedTranscript =
  | {
      status: "recognised";
      version: string;
      events: SessionEvent[];
      /** Lines skipped as malformed: not JSON, or an assistant line of an unexpected shape. */
      skippedLines: number;
      /** Working directories recorded in the transcript, sorted. */
      cwds: string[];
    }
  | { status: "not-measured"; version: string | null; reason: string; startedAt: string | null; cwds: string[] };

const RECOGNISED_VERSION = /^2\.1\.\d+$/;

const READ_TOOLS = new Set(["Read"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function pathOf(input: Json): string | null {
  return asString(input["file_path"]) ?? asString(input["notebook_path"]) ?? asString(input["path"]);
}

function actionOf(block: Json): ToolAction | null {
  const name = asString(block["name"]);
  if (name === null) return null;
  const input = isObject(block["input"]) ? block["input"] : {};
  if (READ_TOOLS.has(name)) return { kind: "read", path: pathOf(input) };
  if (SEARCH_TOOLS.has(name)) return { kind: "search", path: pathOf(input) };
  if (EDIT_TOOLS.has(name)) return { kind: "edit", path: pathOf(input) };
  return null;
}

const INTERRUPT_MARKER = "[Request interrupted by user";

function isHumanText(text: unknown): boolean {
  return typeof text === "string" && !text.startsWith(INTERRUPT_MARKER);
}

function isHumanPrompt(line: Json, message: Json): boolean {
  if (line["isMeta"] === true || line["toolUseResult"] !== undefined) return false;
  if (line["isCompactSummary"] === true || line["isVisibleInTranscriptOnly"] === true) return false;
  const origin = line["origin"];
  if (isObject(origin) && origin["kind"] !== "human") return false;
  const content = message["content"];
  if (typeof content === "string") return isHumanText(content);
  return Array.isArray(content) && content.some((block) => isObject(block) && block["type"] === "text" && isHumanText(block["text"]));
}

/** Compares dotted numeric versions part by part, so 2.1.10 sorts after 2.1.9. Other text compares as a string. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? "0";
    const y = right[i] ?? "0";
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const order = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (order !== 0) return order;
  }
  return 0;
}

/** Earliest timestamp among message lines, so a session not measured can still be placed in a time window. */
function earliest(lines: readonly Json[]): string | null {
  let best: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const timestamp = asString(line["timestamp"]);
    const ms = timestamp === null ? Number.NaN : Date.parse(timestamp);
    if (timestamp !== null && ms < bestMs) {
      best = timestamp;
      bestMs = ms;
    }
  }
  return best;
}

export function parseTranscript(text: string): ParsedTranscript {
  const lines: Json[] = [];
  let skippedLines = 0;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const raw of body.split(/\r?\n/)) {
    if (raw === "") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed)) lines.push(parsed);
    } catch {
      skippedLines++;
    }
  }

  const messageLines = lines.filter((line) => line["type"] === "user" || line["type"] === "assistant");
  const cwds = [...new Set(messageLines.flatMap((line) => (typeof line["cwd"] === "string" ? [line["cwd"] as string] : [])))].sort();
  const notMeasured = (version: string | null, reason: string): ParsedTranscript => ({
    status: "not-measured",
    version,
    reason,
    startedAt: earliest(messageLines),
    cwds,
  });
  const versions = new Set<string>();
  for (const line of messageLines) {
    const version = asString(line["version"]);
    if (version !== null) versions.add(version);
  }
  if (versions.size === 0) return notMeasured(null, "no versioned messages");
  const sorted = [...versions].sort(compareVersions);
  const unrecognised = sorted.find((version) => !RECOGNISED_VERSION.test(version));
  if (unrecognised !== undefined) return notMeasured(unrecognised, "unrecognised transcript version");

  const events: SessionEvent[] = [];
  const turnsById = new Map<string, Extract<SessionEvent, { kind: "agent-turn" }>>();

  for (const line of messageLines) {
    if (line["isSidechain"] === true) continue;
    const message = line["message"];
    const timestamp = asString(line["timestamp"]);
    if (line["type"] === "user") {
      if (isObject(message) && timestamp !== null && isHumanPrompt(line, message)) {
        events.push({ kind: "prompt", timestamp });
      }
      continue;
    }

    const id = isObject(message) ? asString(message["id"]) : null;
    if (!isObject(message) || id === null || timestamp === null || !Array.isArray(message["content"])) {
      skippedLines++;
      continue;
    }
    let turn = turnsById.get(id);
    if (turn === undefined) {
      turn = {
        kind: "agent-turn",
        timestamp,
        messageId: id,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        actions: [],
      };
      turnsById.set(id, turn);
      events.push(turn);
    }
    if (isObject(message["usage"])) {
      const usage = message["usage"];
      turn.tokens = {
        input: count(usage["input_tokens"]),
        output: count(usage["output_tokens"]),
        cacheRead: count(usage["cache_read_input_tokens"]),
        cacheCreation: count(usage["cache_creation_input_tokens"]),
      };
    }
    for (const block of message["content"]) {
      if (!isObject(block) || block["type"] !== "tool_use") continue;
      const action = actionOf(block);
      if (action !== null) turn.actions.push(action);
    }
  }

  return { status: "recognised", version: sorted[sorted.length - 1] ?? "", events, skippedLines, cwds };
}
