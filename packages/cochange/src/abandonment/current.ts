import { componentOf, type Component } from "../components.ts";
import { goneLinesOf, reachesGuideline, type KnowledgeModel } from "./knowledge-model.ts";

export const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

export interface FileAbandonment {
  path: string;
  /** Lines held by people. */
  peopleLines: number;
  /** Of those, lines held by people who have left. */
  abandonedLines: number;
  /** abandonedLines / peopleLines, 0 to 1. */
  abandonedShare: number;
  abandoned: boolean;
  activeAuthors: number;
  formerAuthors: number;
  /** Lines held by bots, services and agents, left out of both sides of the share. */
  nonPersonLines: number;
}

/** Abandonment at the model's date for every file that has lines held by people. */
export function measureCurrent(model: KnowledgeModel, guidelinePercent: number): FileAbandonment[] {
  return model.files.map((file) => {
    const gone = goneLinesOf(file, model.developers);
    const former = file.holders.filter((h) => !model.developers[h.dev]!.active).length;
    return {
      path: file.path,
      peopleLines: file.people,
      abandonedLines: gone,
      abandonedShare: round4(gone / file.people),
      abandoned: reachesGuideline(gone, file.people, guidelinePercent),
      activeAuthors: file.holders.length - former,
      formerAuthors: former,
      nonPersonLines: file.nonPerson,
    };
  });
}

export interface ComponentAbandonment {
  path: string;
  files: number;
  abandonedFiles: number;
  peopleLines: number;
  abandonedLines: number;
  abandonedShare: number;
}

/** The same measure per component: files and lines, the lines' share being the component's abandoned share. */
export function groupByComponent(files: readonly FileAbandonment[], components: readonly Component[]): ComponentAbandonment[] {
  const groups = new Map<string, ComponentAbandonment>();
  for (const f of files) {
    const name = componentOf(components, f.path);
    const g = groups.get(name) ?? { path: name, files: 0, abandonedFiles: 0, peopleLines: 0, abandonedLines: 0, abandonedShare: 0 };
    g.files++;
    if (f.abandoned) g.abandonedFiles++;
    g.peopleLines += f.peopleLines;
    g.abandonedLines += f.abandonedLines;
    groups.set(name, g);
  }
  return [...groups.values()].map((g) => ({ ...g, abandonedShare: round4(g.abandonedLines / g.peopleLines) }));
}

export interface CurrentSummary {
  files: { measured: number; abandoned: number; share: number };
  lines: { people: number; abandoned: number; share: number; nonPerson: number; unattributed: number };
}

export function summariseCurrent(files: readonly FileAbandonment[], unattributed: number): CurrentSummary {
  const abandoned = files.filter((f) => f.abandoned).length;
  const people = files.reduce((sum, f) => sum + f.peopleLines, 0);
  const gone = files.reduce((sum, f) => sum + f.abandonedLines, 0);
  return {
    files: { measured: files.length, abandoned, share: files.length === 0 ? 0 : round4(abandoned / files.length) },
    lines: {
      people,
      abandoned: gone,
      share: people === 0 ? 0 : round4(gone / people),
      nonPerson: files.reduce((sum, f) => sum + f.nonPersonLines, 0),
      unattributed,
    },
  };
}
