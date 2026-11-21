import { usageError } from "@code-health/cli-kit/errors";
import { analysisCommand } from "../analysis-command.ts";
import { findCycles } from "../cycles.ts";
import { evidencePack } from "../evidence-pack.ts";
import { buildModel, type Model } from "../model.ts";
import { readLevel, type Level } from "../modules.ts";
import { folderOf, loadProject, type Project } from "../project.ts";

export const name = "evidence";

const allLevels: readonly Level[] = ["file", "folder", "package", "component"];

const usage = "usage: evidence <from>-><to> [--level file|folder|package|component], or evidence <finding id> (cycle:<level>:<node>, layer:<from>-><to> or unstable:<level>:<from>-><to>)";

type Target =
  | { kind: "cycle"; level: Level; id: string }
  | { kind: "edge"; level: Level | undefined; from: string; to: string };

function parseTarget(text: string, requested: Level | undefined): Target {
  const cycle = /^cycle:(file|folder|package):(.+)$/.exec(text);
  if (cycle) return { kind: "cycle", level: cycle[1] as Level, id: text };
  const layer = /^layer:(.+)$/.exec(text);
  if (layer) return { ...parseEdge(layer[1]!), level: "file" };
  const unstable = /^unstable:(folder|component):(.+)$/.exec(text);
  const edge = unstable ? unstable[2]! : text;
  return { ...parseEdge(edge), level: unstable ? (unstable[1] as Level) : requested };
}

function parseEdge(edge: string): { kind: "edge"; from: string; to: string } {
  const arrow = edge.indexOf("->");
  if (arrow <= 0 || arrow + 2 >= edge.length) throw usageError(usage);
  return { kind: "edge", from: edge.slice(0, arrow), to: edge.slice(arrow + 2) };
}

/** The finest level at which both names are modules: a file, then a folder, then a package. */
function inferLevel(project: Project, from: string, to: string): Level {
  const files = new Set(project.files);
  if (files.has(from) && files.has(to)) return "file";
  const folders = new Set(project.files.map(folderOf));
  if (folders.has(from) && folders.has(to)) return "folder";
  const packages = new Set(project.files.map((f) => project.packageOf(f)));
  if (packages.has(from) && packages.has(to)) return "package";
  throw usageError(`cannot tell what "${from}" and "${to}" are: they are not both files, both folders or both packages of the analysed commit; name the level with --level`);
}

export const command = analysisCommand(name, {
  summary: "The evidence pack for one dependency or one finding: symbols across it, stability, co-change, misplacement",
  options: { level: { type: "string" } },
  // A query about one dependency, never the whole-repository answer a report stores.
  partial: () => true,
  async analyse({ context, history }) {
    const [text] = context.positionals;
    if (text === undefined) throw usageError(usage);
    const requested = context.values.level === undefined ? undefined : readLevel("level", context.values.level, allLevels, "file");
    const target = parseTarget(text, requested);
    const { settings } = history;

    let model: Model;
    let edges: [string, string][];
    if (target.kind === "cycle") {
      model = await buildModel(context, history, target.level);
      const cycle = findCycles(model, settings).find((c) => c.id === target.id);
      if (!cycle) throw usageError(`no cycle "${target.id}" at the analysed commit`);
      edges = cycle.breakingSet.map((e) => [e.from, e.to]);
    } else {
      const project = await loadProject(context.repo.root, history.view.headSha, settings.exclude);
      const level = target.level ?? inferLevel(project, target.from, target.to);
      model = await buildModel(context, history, level, project);
      if (!model.graph.graph.get(target.from)?.includes(target.to)) {
        throw usageError(`no dependency from "${target.from}" to "${target.to}" at level ${level}`);
      }
      edges = [[target.from, target.to]];
    }

    return {
      inputs: { target: text, level: model.graph.level, locality: model.locality?.input ?? null },
      results: edges.map(([from, to]) => evidencePack(model, from, to, settings)),
      columns: ["id", "kind", "findings", "inBreakingSet", "breakingSet", "stability", "coChange", "misplacement", "unblocks"],
      extra: {
        deferred: [
          { field: "quadrant", milestone: 6 },
          { field: "nearbyMechanisms", milestone: 3 },
        ],
      },
    };
  },
});
