import { folderOf } from "@code-health/graph/tree-distance";
import { toRepoPath } from "./repo-path.ts";
import { parseTranscript, type SessionEvent, type TokenCounts, type ToolAction } from "./transcript-format.ts";

export interface TaskTokens extends TokenCounts {
  total: number;
}

/** Paths and counts for one task. Nothing from message text or tool output. */
export interface TaskEffort {
  sessionId: string;
  /** Position of the task's prompt among the session's prompts, from 0. */
  taskIndex: number;
  /** Timestamp of the task's prompt. */
  startedAt: string;
  /** Read calls on repo files. */
  reads: number;
  filesRead: number;
  /** Reads of a file the task had already read. */
  reReads: number;
  searches: number;
  /** Distinct folders of the files read or edited, `""` being the repo root. */
  foldersVisited: number;
  edits: number;
  filesEdited: number;
  tokens: TaskTokens;
  readPaths: string[];
  editedPaths: string[];
  folders: string[];
}

export type SessionMeasurement =
  | { status: "measured"; sessionId: string; version: string; tasks: TaskEffort[] }
  | { status: "not-measured"; sessionId: string; version: string | null; reason: string };

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function sortedBytes(values: Iterable<string>): string[] {
  return [...values].sort(compareBytes);
}

function segment(events: readonly SessionEvent[]): { startedAt: string; turns: Extract<SessionEvent, { kind: "agent-turn" }>[] }[] {
  const tasks: { startedAt: string; turns: Extract<SessionEvent, { kind: "agent-turn" }>[] }[] = [];
  for (const event of events) {
    if (event.kind === "prompt") tasks.push({ startedAt: event.timestamp, turns: [] });
    else tasks.at(-1)?.turns.push(event);
  }
  return tasks;
}

function measureTask(
  sessionId: string,
  taskIndex: number,
  startedAt: string,
  turns: readonly { tokens: TokenCounts; actions: ToolAction[] }[],
  roots: readonly string[],
): TaskEffort {
  const readCounts = new Map<string, number>();
  const edited = new Set<string>();
  let searches = 0;
  let edits = 0;
  const tokens: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  for (const turn of turns) {
    tokens.input += turn.tokens.input;
    tokens.output += turn.tokens.output;
    tokens.cacheRead += turn.tokens.cacheRead;
    tokens.cacheCreation += turn.tokens.cacheCreation;
    for (const action of turn.actions) {
      const path = toRepoPath(action.path, roots);
      if (action.kind === "search") {
        searches++;
      } else if (path === null) {
        continue;
      } else if (action.kind === "read") {
        readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
      } else {
        edits++;
        edited.add(path);
      }
    }
  }

  const reads = [...readCounts.values()].reduce((sum, n) => sum + n, 0);
  const folders = new Set<string>();
  for (const path of [...readCounts.keys(), ...edited]) folders.add(folderOf(path));

  return {
    sessionId,
    taskIndex,
    startedAt,
    reads,
    filesRead: readCounts.size,
    reReads: reads - readCounts.size,
    searches,
    foldersVisited: folders.size,
    edits,
    filesEdited: edited.size,
    tokens: {
      ...tokens,
      total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation,
    },
    readPaths: sortedBytes(readCounts.keys()),
    editedPaths: sortedBytes(edited),
    folders: sortedBytes(folders),
  };
}

/**
 * Measures one session transcript. `roots` lists the checkouts of the repo the
 * session may have run in. Tasks with no edits to repo files are left out.
 */
export function measureSession(text: string, sessionId: string, roots: readonly string[]): SessionMeasurement {
  const parsed = parseTranscript(text);
  if (parsed.status === "not-measured") {
    return { status: "not-measured", sessionId, version: parsed.version, reason: parsed.reason };
  }
  const tasks = segment(parsed.events)
    .map((task, index) => measureTask(sessionId, index, task.startedAt, task.turns, roots))
    .filter((task) => task.edits > 0);
  return { status: "measured", sessionId, version: parsed.version, tasks };
}
