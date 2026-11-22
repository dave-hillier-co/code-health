import type { Sessions } from "./measure-scenarios.ts";

interface TaskSpec {
  reads: string[];
  edits: string[];
  tokens: number;
}

const START = "2023-03-05T09:00:00Z";

/**
 * Sessions in which distance and cost go together. A near task edits files of one folder, a far task edits a
 * file of src/shared/utils beside them, and the far task reads more files and spends more. Some tasks edit a
 * third file, so size varies on its own.
 */
export function sessionsWhereDistanceCosts(sessions: Sessions): void {
  sessions.tasks(START, distanceCostsSpecs());
}

/** The tasks of `sessionsWhereDistanceCosts`, done entirely through Bash calls, each task also making one call that cannot be parsed. */
export function shellSessionsWhereDistanceCosts(sessions: Sessions): void {
  sessions.shellTasks(START, distanceCostsSpecs(), 1);
}

/**
 * The same tasks as `sessionsWhereDistanceCosts`, each run by a subagent in a worktree that has since been deleted:
 * its paths are `<worktree>/src/...` and only map to the repo through the worktree rule.
 */
export function subagentsInDeletedWorktree(sessions: Sessions, worktree: string): void {
  sessions.subagents(START, distanceCostsSpecs(), { checkout: worktree, meta: { agentType: "general-purpose", description: "Change a feature", worktreePath: worktree } });
}

function distanceCostsSpecs(): TaskSpec[] {
  const specs: TaskSpec[] = [];
  for (let i = 0; i < 8; i++) {
    const feature = (i % 6) + 1;
    const third = i % 2 === 0;
    const folder = `src/f${feature}`;
    const nearEdits = [`${folder}/a.ts`, `${folder}/b.ts`, ...(third ? [`${folder}/c.ts`] : [])];
    const farEdits = [`${folder}/a.ts`, `src/shared/utils/h${feature}.ts`, ...(third ? [`${folder}/b.ts`] : [])];
    const nearExtra = Array.from({ length: i % 3 }, (_, n) => `${folder}/near${n}.ts`);
    const farExtra = Array.from({ length: 2 + (i % 3) }, (_, n) => `src/shared/utils/other${n}.ts`);
    specs.push({ reads: [...nearEdits, ...nearExtra], edits: nearEdits, tokens: 2000 + 100 * i });
    specs.push({ reads: [...farEdits, ...farExtra], edits: farEdits, tokens: 4000 + 100 * i });
  }
  return specs;
}

/** Sessions in which every task edits two files of one folder: cost varies, distance never does. */
export function sessionsWhereDistanceNeverVaries(sessions: Sessions): void {
  const specs: TaskSpec[] = [];
  for (let i = 0; i < 16; i++) {
    const folder = `src/f${(i % 6) + 1}`;
    const edits = [`${folder}/a.ts`, `${folder}/b.ts`];
    const extra = Array.from({ length: (i * 7) % 4 }, (_, n) => `${folder}/extra${n}.ts`);
    specs.push({ reads: [...edits, ...extra], edits, tokens: 3000 + ((i * 37) % 5) * 100 });
  }
  sessions.tasks(START, specs);
}

/** Sessions in which cost varies but does not follow distance: near and far tasks cost alike. */
export function sessionsWhereDistanceDoesNotCost(sessions: Sessions): void {
  const specs: TaskSpec[] = [];
  for (let i = 0; i < 16; i++) {
    const feature = (i % 6) + 1;
    const third = i % 2 === 0;
    const folder = `src/f${feature}`;
    const far = i % 4 < 2;
    const edits = far
      ? [`${folder}/a.ts`, `src/shared/utils/h${feature}.ts`, ...(third ? [`${folder}/b.ts`] : [])]
      : [`${folder}/a.ts`, `${folder}/b.ts`, ...(third ? [`${folder}/c.ts`] : [])];
    const extra = Array.from({ length: (i * 7) % 4 }, (_, n) => `${folder}/extra${n}.ts`);
    specs.push({ reads: [...edits, ...extra], edits, tokens: 3000 + ((i * 37) % 5) * 100 });
  }
  sessions.tasks(START, specs);
}
