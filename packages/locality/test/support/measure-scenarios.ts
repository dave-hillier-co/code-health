import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { encodeProjectDir } from "@code-health/transcripts/measure-repo";
import { edit, read, SyntheticSession } from "../../../transcripts/test/synthetic-transcript.ts";

const ada: Identity = { name: "Ada", email: "ada@example.com" };
const grace: Identity = { name: "Grace", email: "grace@example.com" };

const add = (path: string, content: string): Change => ({ op: "add", path, content });
const modify = (path: string, content: string): Change => ({ op: "modify", path, content });

/** The six features, each with two files that use one helper, which starts out in src/shared/utils. */
export const features = [1, 2, 3, 4, 5, 6] as const;
export type Feature = (typeof features)[number];

const helperPath = (feature: Feature, moved: ReadonlySet<Feature>) => (moved.has(feature) ? `src/f${feature}/h${feature}.ts` : `src/shared/utils/h${feature}.ts`);
const helperImport = (feature: Feature, moved: ReadonlySet<Feature>) => (moved.has(feature) ? `./h${feature}.ts` : `../shared/utils/h${feature}.ts`);
const helperSource = (feature: Feature, revision: number) => `export const h${feature} = () => ${revision};\n`;
const consumerSource = (feature: Feature, side: "a" | "b", revision: number, moved: ReadonlySet<Feature>) =>
  `import { h${feature} } from "${helperImport(feature, moved)}";\nexport const ${side}${feature} = () => h${feature}() + ${revision};\n`;

const none: ReadonlySet<Feature> = new Set();

const day = (month: number, date: number, year = 2023) => `${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}T09:00:00Z`;

/** One commit that changes a feature's helper and both its consumers together. */
function changeFeature(feature: Feature, revision: number, date: string, moved: ReadonlySet<Feature>): Step {
  return {
    type: "commit",
    message: `Change feature ${feature} (${revision})`,
    date,
    author: revision % 2 === 0 ? ada : grace,
    changes: [
      modify(helperPath(feature, moved), helperSource(feature, revision)),
      modify(`src/f${feature}/a.ts`, consumerSource(feature, "a", revision, moved)),
      modify(`src/f${feature}/b.ts`, consumerSource(feature, "b", revision, moved)),
    ],
  };
}

/**
 * The app before anything moves. Every feature has two consumers sharing one helper in src/shared/utils, far
 * from them, and they change together. Feature 1 changes most, feature 6 least, so the helpers rank in
 * order. The last commit is 2024-01-01, and the only entry point is src/main.ts.
 */
export function relocationApp(): GitFixture {
  const main = `${features.map((feature) => `import { a${feature} } from "./f${feature}/a.ts";\nimport { b${feature} } from "./f${feature}/b.ts";`).join("\n")}\nexport const run = () => [${features.map((feature) => `a${feature}(), b${feature}()`).join(", ")}];\n`;
  const steps: Step[] = [
    {
      type: "commit",
      message: "Add the app",
      date: day(1, 2),
      author: ada,
      changes: [
        add("code-health.json", JSON.stringify({ entryPoints: ["src/main.ts"], locality: { measureMinSamples: 3 } })),
        add("src/main.ts", main),
        ...features.flatMap((feature) => [
          add(helperPath(feature, none), helperSource(feature, 0)),
          add(`src/f${feature}/a.ts`, consumerSource(feature, "a", 0, none)),
          add(`src/f${feature}/b.ts`, consumerSource(feature, "b", 0, none)),
        ]),
      ],
    },
  ];
  for (const feature of features) {
    for (let revision = 1; revision <= 8 - feature; revision++) {
      steps.push(changeFeature(feature, revision, day(1 + revision, 3 + feature), none));
    }
  }
  steps.push({ type: "commit", message: "Add notes", date: day(1, 1, 2024), author: grace, changes: [add("NOTES.md", "Notes.\n")] });
  return GitFixture.build(steps);
}

/**
 * What follows the baseline: the suite moves the helpers of `moved` next to their consumers in 2024-01-10, each in
 * a commit with a `Code-Health:` trailer, then every feature keeps changing through 2024 as before.
 */
export function tidyUp(fixture: GitFixture, moved: readonly Feature[], options: { trailer?: boolean; last?: string } = {}): void {
  const done = new Set<Feature>();
  const steps: Step[] = [];
  for (const feature of moved) {
    done.add(feature);
    steps.push({
      type: "commit",
      message: `Move h${feature} next to its consumers${options.trailer === false ? "" : `\n\nCode-Health: locality two-consumers`}`,
      date: day(1, 10, 2024),
      author: ada,
      changes: [
        { op: "rename", from: helperPath(feature, none), path: helperPath(feature, done) },
        modify(`src/f${feature}/a.ts`, consumerSource(feature, "a", 8 - feature, done)),
        modify(`src/f${feature}/b.ts`, consumerSource(feature, "b", 8 - feature, done)),
      ],
    });
  }
  for (const feature of features) {
    for (let revision = 1; revision <= 8 - feature; revision++) {
      steps.push(changeFeature(feature, 100 + revision, day(1 + revision, 3 + feature, 2024), done));
    }
  }
  steps.push({ type: "commit", message: "Add more notes", date: options.last ?? day(1, 20, 2025), author: grace, changes: [add("NOTES2.md", "Notes.\n")] });
  fixture.apply(steps);
}

/** A directory of Claude Code sessions for a repository, as the transcripts package reads them. */
export class Sessions {
  readonly directory: string;
  /** The repository as git names it, which is where the sessions say they ran. */
  readonly root: string;
  private readonly project: string;
  private count = 0;

  constructor(repositoryPath: string) {
    this.directory = mkdtempSync(join(tmpdir(), "code-health-sessions-"));
    this.root = realpathSync(repositoryPath);
    this.project = join(this.directory, encodeProjectDir(this.root));
    mkdirSync(this.project, { recursive: true });
  }

  dispose(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }

  /**
   * One session of `tasks` tasks on a feature, starting at `start`: each reads the helper, reads both consumers
   * (twice when `rereads`), and edits one, spending `tokens` in all.
   */
  featureTasks(feature: Feature, options: { start: string; tasks: number; helper: string; rereads: boolean; tokens: number }): void {
    const session = new SyntheticSession({ cwd: this.root, sessionId: `session-${++this.count}`, start: options.start });
    const file = (path: string) => join(this.root, path);
    for (let task = 0; task < options.tasks; task++) {
      session.prompt(`Change feature ${feature}`);
      const calls = [read(file(`src/f${feature}/a.ts`)), read(file(options.helper)), read(file(`src/f${feature}/b.ts`))];
      if (options.rereads) calls.push(read(file(`src/f${feature}/a.ts`)));
      session.assistant(`m${this.count}-${task}`, [...calls, edit(file(`src/f${feature}/a.ts`))], { input: options.tokens });
    }
    writeFileSync(join(this.project, `session-${this.count}.jsonl`), session.toJsonl());
  }
}

/** Sessions before the tidy-up: every feature costs the same, with a wasted re-read in each task. */
export function sessionsBefore(sessions: Sessions): void {
  for (const feature of features) {
    sessions.featureTasks(feature, { start: day(3, 1 + feature), tasks: 4, helper: helperPath(feature, none), rereads: true, tokens: 5000 });
  }
}

/** Sessions after it: the moved features cost less, with no re-read and fewer tokens, and the others the same as before. */
export function sessionsAfter(sessions: Sessions, moved: readonly Feature[]): void {
  for (const feature of features) {
    const wasMoved = moved.includes(feature);
    sessions.featureTasks(feature, {
      start: day(3, 1 + feature, 2024),
      tasks: 4,
      helper: helperPath(feature, new Set(moved)),
      rereads: !wasMoved,
      tokens: wasMoved ? 3000 : 5000,
    });
  }
}
