import { usageError } from "@code-health/cli-kit/errors";
import type { Rule } from "@code-health/cli-kit/run-cli";
import { runGit } from "@code-health/history/git";
import { monthsBefore } from "@code-health/history/evidence";
import { stampOf } from "@code-health/transcripts/stamp";
import { readAgentTasks } from "../incidental.ts";
import { analysisCommand } from "../analysis-command.ts";
import { buildModel } from "../model.ts";
import { inferLevel, readLevel, type Level } from "../modules.ts";
import { measureOutcome } from "../outcome.ts";
import { loadProject } from "../project.ts";
import { resolveRevision } from "../regressions.ts";

export const name = "outcome";

const allLevels: readonly Level[] = ["file", "folder", "package", "component"];

const usage = "usage: outcome <from>-><to> --at <revision of the break> [--level file|folder|package|component]";

export const rules: Record<string, Rule> = {
  "hidden-not-broken": {
    summary: "A dependency whose import went away but whose co-change stayed",
    explanation: [
      "A break succeeded only if it made change cheaper, not merely if the import went away. `outcome`",
      "compares the co-change of the pair over a window before the break with a window of the same",
      "length after it (neither holds the break's own change), and the static coupling at the break's",
      "parent with that at the analysed commit.",
      "",
      "broken: static coupling dropped and the co-change went with it.",
      "hidden-not-broken: static coupling dropped and the co-change stayed. The indirection (events, a",
      "mediator, string-keyed registries) hid the dependency without removing it. The remedy treated",
      "the symptom: reconsider whether the two sides share a decision that belongs in one place.",
      "unchanged: both stayed. co-change-reduced: the co-change went with the import still there.",
      "no-baseline: the pair did not co-change before. insufficient-evidence: a side was too quiet",
      "afterwards to tell a reduction from idleness.",
      "",
      "`hiddenCreated` applies the same test to every pair that lost its static dependency between the",
      "break's parent and the analysed commit.",
    ].join("\n"),
  },
};

export const command = analysisCommand(name, {
  summary: "Whether a break reduced coupling or only hid it: co-change before and after over matching windows",
  usage: "<from>-><to>",
  options: { at: { type: "string" }, level: { type: "string" }, "projects-dir": { type: "string" } },
  optionHelp: {
    at: "the revision that made the break (required)",
    level: "what a node is: file, folder, package or component (default: inferred from the arguments)",
    "projects-dir": "read Claude Code session transcripts here (usually ~/.claude/projects) to measure agent effort on tasks touching either side",
  },
  // A query about one pair and one break, never the whole-repository answer a report stores.
  partial: () => true,
  wholeHistory: true,
  async analyse({ context, history }) {
    const [text] = context.positionals;
    const at = context.values.at;
    if (text === undefined || typeof at !== "string") throw usageError(usage);
    const arrow = text.indexOf("->");
    if (arrow <= 0 || arrow + 2 >= text.length) throw usageError(usage);
    const from = text.slice(0, arrow);
    const to = text.slice(arrow + 2);

    const { root } = context.repo;
    const { settings } = history;
    const sha = await resolveRevision(root, at);
    let parent: string;
    try {
      parent = (await runGit(root, ["rev-parse", "--verify", `${sha}^1`])).trim();
    } catch {
      throw usageError(`"${at}" has no parent commit, so there is no code before it to compare with`);
    }
    const date = Number((await runGit(root, ["log", "-1", "--format=%ct", sha])).trim());

    const projectAfter = await loadProject(root, history.view.headSha, settings.exclude);
    const level = context.values.level === undefined ? inferLevel(projectAfter, from, to) : readLevel("level", context.values.level, allLevels, "folder");
    const model = await buildModel(context, history, level, projectAfter);
    for (const side of [from, to]) {
      if (!model.graph.filesOf.has(side)) throw usageError(`"${side}" is not a ${level} of the analysed commit`);
    }

    const projectBefore = await loadProject(root, parent, settings.exclude);
    const projectsDir = typeof context.values["projects-dir"] === "string" ? context.values["projects-dir"] : undefined;
    const seconds = Math.min(date - monthsBefore(date, settings.windowMonths), history.window.until - date);
    const tasks =
      projectsDir === undefined
        ? { reason: "no --projects-dir was given" }
        : { tasks: readAgentTasks(root, projectsDir, { since: date - seconds, until: date + seconds }) };
    const measured = measureOutcome(
      {
        level,
        graphAfter: model.graph,
        projectAfter,
        projectBefore,
        changes: history.filtered.changes,
        point: { rev: at, sha, parent, date, until: history.window.until },
        settings,
        tasks,
      },
      from,
      to,
    );
    if (measured === undefined) {
      throw usageError(`"${at}" is not before the analysed commit, so there is no history after it to measure`);
    }
    return {
      inputs: {
        target: text,
        level,
        at,
        minStaticCoupling: settings.minStaticCoupling,
        minSupport: settings.minSupport,
        minRevisions: settings.minRevisions,
        significanceLevel: settings.significanceLevel,
        transcripts: projectsDir !== undefined,
        transcriptStamp: tasks.tasks === undefined ? null : stampOf(tasks.tasks),
      },
      results: [measured.outcome],
      columns: ["id", "verdict", "before", "after"],
      extra: { hiddenCreated: measured.hiddenCreated },
    };
  },
});
