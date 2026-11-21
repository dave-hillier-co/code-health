import { usageError } from "@code-health/cli-kit/errors";
import { buildCensus } from "../census/census.ts";
import { treeFromRef } from "@code-health/parse/source-tree";
import { analysisCommand } from "../analysis-command.ts";
import { findCycles } from "../cycles.ts";
import { findCoupling, orientPair } from "../coupling.ts";
import { evidencePack, hubEvidencePack } from "../evidence-pack.ts";
import { findHubs } from "../hubs.ts";
import { buildModel, type Model } from "../model.ts";
import { inferLevel, readLevel, type Level } from "../modules.ts";
import { loadProject } from "../project.ts";

export const name = "evidence";

const allLevels: readonly Level[] = ["file", "folder", "package", "component"];

const usage =
  "usage: evidence <from>-><to> [--level file|folder|package|component], or evidence <finding id> (cycle:<level>:<node>, layer:<from>-><to>, unstable:<level>:<from>-><to>, coupling:<level>:<from>-><to> or hub:<file>)";

type Target =
  | { kind: "cycle"; level: Level; id: string }
  | { kind: "hub"; level: Level | undefined; id: string }
  | { kind: "edge"; level: Level | undefined; from: string; to: string };

function parseTarget(text: string, requested: Level | undefined): Target {
  const hub = /^hub:(.+)$/.exec(text);
  if (hub) return { kind: "hub", level: requested, id: text };
  const pair = /^coupling:(file|folder|component):(.+)$/.exec(text);
  if (pair) return { ...parseEdge(pair[2]!), level: pair[1] as Level };
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
    if (target.kind === "hub") {
      const level = target.level ?? "folder";
      model = await buildModel(context, history, level, undefined, { everyPair: true });
      const hub = (await findHubs({ root: context.repo.root, headSha: history.view.headSha, model, changes: history.filtered.changes, settings })).find((h) => h.id === target.id);
      if (!hub) throw usageError(`no registration hub "${target.id.slice("hub:".length)}" at level ${level} at the analysed commit`);
      const census = await buildCensus(await treeFromRef(context.repo.root, history.view.headSha), model.project, settings.census);
      return {
        inputs: { target: text, level: model.graph.level, locality: model.locality?.input ?? null },
        results: [hubEvidencePack(model, hub, census)],
        columns: ["id", "kind", "findings", "features", "signals", "stability", "unblocks"],
      };
    }
    if (target.kind === "cycle") {
      model = await buildModel(context, history, target.level);
      const cycle = findCycles(model, settings).find((c) => c.id === target.id);
      if (!cycle) throw usageError(`no cycle "${target.id}" at the analysed commit`);
      edges = cycle.breakingSet.map((e) => [e.from, e.to]);
    } else {
      const project = await loadProject(context.repo.root, history.view.headSha, settings.exclude);
      const level = target.level ?? inferLevel(project, target.from, target.to);
      model = await buildModel(context, history, level, project);
      const imported = (a: string, b: string) => model.graph.graph.get(a)?.includes(b) === true;
      if (imported(target.from, target.to)) {
        edges = [[target.from, target.to]];
      } else {
        // No import in that direction: a pair is still worth a pack when it is coupled by what changes together, as a hidden pair is.
        model = await buildModel(context, history, level, project, { everyPair: true });
        const row = findCoupling(model, settings).find((r) => (r.from === target.from && r.to === target.to) || (r.from === target.to && r.to === target.from));
        if (!row) throw usageError(`no dependency from "${target.from}" to "${target.to}" at level ${level}, and the two do not change together`);
        edges = [orientPair(model.project, model.graph, row.from, row.to)];
      }
    }

    const census = await buildCensus(await treeFromRef(context.repo.root, history.view.headSha), model.project, settings.census);
    return {
      inputs: { target: text, level: model.graph.level, locality: model.locality?.input ?? null },
      results: edges.map(([from, to]) => evidencePack(model, from, to, settings, census)),
      columns: ["id", "kind", "findings", "quadrant", "inBreakingSet", "breakingSet", "stability", "coChange", "misplacement", "unblocks"],
    };
  },
});
