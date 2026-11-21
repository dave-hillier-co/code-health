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
 * `human`. Every other line type is metadata and ignored.
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
  | { status: "recognised"; version: string; events: SessionEvent[] }
  | { status: "not-measured"; version: string | null; reason: string };

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

function isHumanPrompt(line: Json, message: Json): boolean {
  if (line["isMeta"] === true || line["toolUseResult"] !== undefined) return false;
  const origin = line["origin"];
  if (isObject(origin) && origin["kind"] !== "human") return false;
  const content = message["content"];
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.some((block) => isObject(block) && block["type"] === "text");
}

function notMeasured(version: string | null, reason: string): ParsedTranscript {
  return { status: "not-measured", version, reason };
}

export function parseTranscript(text: string): ParsedTranscript {
  const lines: Json[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed)) lines.push(parsed);
    } catch {
      continue;
    }
  }

  const messageLines = lines.filter((line) => line["type"] === "user" || line["type"] === "assistant");
  const versions = new Set<string>();
  for (const line of messageLines) {
    const version = asString(line["version"]);
    if (version !== null) versions.add(version);
  }
  if (versions.size === 0) return notMeasured(null, "no versioned messages");
  const sorted = [...versions].sort();
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
      return notMeasured(sorted[0] ?? null, "unexpected assistant message shape");
    }
    let turn = turnsById.get(id);
    if (turn === undefined) {
      const usage = isObject(message["usage"]) ? message["usage"] : {};
      turn = {
        kind: "agent-turn",
        timestamp,
        messageId: id,
        tokens: {
          input: count(usage["input_tokens"]),
          output: count(usage["output_tokens"]),
          cacheRead: count(usage["cache_read_input_tokens"]),
          cacheCreation: count(usage["cache_creation_input_tokens"]),
        },
        actions: [],
      };
      turnsById.set(id, turn);
      events.push(turn);
    }
    for (const block of message["content"]) {
      if (!isObject(block) || block["type"] !== "tool_use") continue;
      const action = actionOf(block);
      if (action !== null) turn.actions.push(action);
    }
  }

  return { status: "recognised", version: sorted[sorted.length - 1] ?? "", events };
}
