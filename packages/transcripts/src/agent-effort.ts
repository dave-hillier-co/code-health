import { folderOf } from "@code-health/graph/tree-distance";
import { isWithinRepo, toRepoPath, worktreeRootOf } from "./repo-path.ts";
import { parseTranscript, type SessionEvent, type TokenCounts, type ToolAction } from "./transcript-format.ts";

export type TaskSource = "main" | "subagent";

/** What the meta file beside a subagent transcript says. The first two are short labels written by whoever spawned the subagent. */
export interface SubagentMeta {
  agentType: string | null;
  description: string | null;
  worktreePath: string | null;
}

export interface TaskTokens extends TokenCounts {
  total: number;
}

/** Paths and counts for one task. Nothing from message text or tool output. */
export interface TaskEffort {
  /** The session the task ran under: for a subagent task, the session that spawned it. */
  sessionId: string;
  /** `main` for a task of a main session, `subagent` for one subagent transcript. */
  source: TaskSource;
  /** The subagent's id, or null for a main-session task. */
  agentId: string | null;
  /** The meta file's `agentType`, or null for a main-session task or a subagent with no meta file. */
  agentType: string | null;
  /** The meta file's `description`, a short label written by the orchestrator, or null as for `agentType`. */
  description: string | null;
  /** Position of the task's prompt among the session's prompts, from 0. A subagent task is 0. */
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
  | { status: "measured"; sessionId: string; version: string; tasks: TaskEffort[]; cwds: string[] }
  | {
      status: "not-measured";
      sessionId: string;
      version: string | null;
      reason: string;
      startedAt: string | null;
      cwds: string[];
    };

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

interface TaskOrigin {
  sessionId: string;
  source: TaskSource;
  agentId: string | null;
  agentType: string | null;
  description: string | null;
}

function measureTask(
  origin: TaskOrigin,
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
        if (isWithinRepo(action.path, roots)) searches++;
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
    ...origin,
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

function mainOrigin(sessionId: string): TaskOrigin {
  return { sessionId, source: "main", agentId: null, agentType: null, description: null };
}

/**
 * Measures one subagent transcript as one task: its first prompt starts it, every later turn of the file belongs
 * to it, and it is measured from the file's sidechain lines. The checkouts it may have run in are `roots`, the
 * meta file's `worktreePath` and the worktree its recorded working directories lie in, so paths in a worktree that
 * has since been deleted still map to the repo. The task is left out when it made no edit to a repo file.
 */
export function measureSubagent(
  text: string,
  sessionId: string,
  agentId: string,
  roots: readonly string[],
  meta: SubagentMeta | null,
): SessionMeasurement {
  const parsed = parseTranscript(text, "sidechain");
  if (parsed.status === "not-measured") {
    return { status: "not-measured", sessionId, version: parsed.version, reason: parsed.reason, startedAt: parsed.startedAt, cwds: parsed.cwds };
  }
  const worktrees = [meta?.worktreePath ?? null, ...parsed.cwds.map(worktreeRootOf)].filter((root): root is string => root !== null);
  const mapRoots = [...roots, ...worktrees];
  const first = parsed.events.findIndex((event) => event.kind === "prompt");
  const start = parsed.events[first];
  const turns = parsed.events.slice(first + 1).flatMap((event) => (event.kind === "agent-turn" ? [event] : []));
  const origin: TaskOrigin = {
    sessionId,
    source: "subagent",
    agentId,
    agentType: meta?.agentType ?? null,
    description: meta?.description ?? null,
  };
  const task = start === undefined ? null : measureTask(origin, 0, start.timestamp, turns, mapRoots);
  return { status: "measured", sessionId, version: parsed.version, tasks: task === null || task.edits === 0 ? [] : [task], cwds: parsed.cwds };
}

/**
 * Measures one session transcript. `roots` lists the checkouts of the repo the
 * session may have run in. Tasks with no edits to repo files are left out.
 */
export function measureSession(text: string, sessionId: string, roots: readonly string[]): SessionMeasurement {
  const parsed = parseTranscript(text);
  if (parsed.status === "not-measured") {
    return { status: "not-measured", sessionId, version: parsed.version, reason: parsed.reason, startedAt: parsed.startedAt, cwds: parsed.cwds };
  }
  const tasks = segment(parsed.events)
    .map((task, index) => measureTask(mainOrigin(sessionId), index, task.startedAt, task.turns, roots))
    .filter((task) => task.edits > 0);
  return { status: "measured", sessionId, version: parsed.version, tasks, cwds: parsed.cwds };
}
