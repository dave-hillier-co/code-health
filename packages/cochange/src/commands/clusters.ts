import type { Rule } from "@code-health/cli-kit/run-cli";
import { folderOf } from "@code-health/graph/tree-distance";
import { analysisCommand } from "../analysis-command.ts";
import { coupledPairs, integerOption } from "../coupled-pairs.ts";
import { compareBytes, degreeOf, type PairCount } from "../coupling.ts";
import { changeSpread } from "../spread-measure.ts";

export const name = "clusters";

/** A cluster spanning at least this many folders is a `cluster` finding. */
export const CLUSTER_MIN_FOLDERS = 3;

/**
 * A file is a `change-magnet` when its coupled neighbours sit in at least `folders` different folders
 * and at most `neighbourCoupling` percent of the cross-folder pairs among those neighbours are
 * coupled themselves: the neighbours each change with the file, rarely with one another.
 */
export const MAGNET = { folders: 3, neighbourCoupling: 25 } as const;

export const rules: Record<string, Rule> = {
  cluster: {
    summary: "A group of mutually coupled files spanning three or more folders",
    explanation: [
      "Clusters are the connected components of the coupling graph: files joined by pairs that reach the",
      "configured minimum support and degree (cochange.minSupport, cochange.minDegree), counted over eligible",
      `logical changes. A component is a cluster finding when its files sit in at least ${CLUSTER_MIN_FOLDERS} different folders.`,
      "Its spread is the mean tree distance over every pair of its files.",
      "",
      "Handoff: a candidate for co-location or a module boundary. Ask whether the files encode one design",
      "decision, and whether a folder or a module would make the next change local.",
      "",
      "This is a prompt for investigation, not a verdict. Weak evidence makes it tentative.",
    ].join("\n"),
  },
  "change-magnet": {
    summary: "A file that changes with files in many folders, which rarely change with each other",
    explanation: [
      `Raised on the cluster holding it when a file's coupled neighbours sit in at least ${MAGNET.folders} different`,
      `folders and at most ${MAGNET.neighbourCoupling} % of the cross-folder pairs among those neighbours are coupled with each other:`,
      "a star shape. The cluster lists the file under `magnets`.",
      "",
      "Handoff: likely a registration hub, where every new feature adds a line to one shared file. The",
      "structure plugin confirms it against the import graph and proposes the inversion remedy.",
      "",
      "This is a prompt for investigation, not a verdict. Weak evidence makes it tentative.",
    ].join("\n"),
  },
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Connected components of the pair graph. Each is a sorted list of files. */
function components(pairs: readonly PairCount[]): string[][] {
  const neighbours = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    let set = neighbours.get(from);
    if (!set) neighbours.set(from, (set = new Set()));
    set.add(to);
  };
  for (const pair of pairs) {
    link(pair.a, pair.b);
    link(pair.b, pair.a);
  }
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const start of [...neighbours.keys()].sort(compareBytes)) {
    if (seen.has(start)) continue;
    const members: string[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const next = queue.pop()!;
      members.push(next);
      for (const other of neighbours.get(next)!) {
        if (!seen.has(other)) {
          seen.add(other);
          queue.push(other);
        }
      }
    }
    result.push(members.sort(compareBytes));
  }
  return result;
}

function isMagnet(file: string, neighbours: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const around = [...neighbours.get(file)!];
  if (new Set(around.map(folderOf)).size < MAGNET.folders) return false;
  let crossPairs = 0;
  let coupled = 0;
  for (const [i, a] of around.entries()) {
    for (const b of around.slice(i + 1)) {
      if (folderOf(a) === folderOf(b)) continue;
      crossPairs++;
      if (neighbours.get(a)!.has(b)) coupled++;
    }
  }
  return crossPairs === 0 || (100 * coupled) / crossPairs <= MAGNET.neighbourCoupling;
}

export const command = analysisCommand(name, {
  summary: "Groups of mutually coupled files (connected components above the coupling thresholds) with their spread",
  options: { "min-degree": { type: "string" }, "min-support": { type: "string" } },
  partial: ({ values }) => values["min-degree"] !== undefined || values["min-support"] !== undefined,
  analyse({ context, history }) {
    const { settings } = history;
    const minDegree = integerOption(context, "min-degree", settings.minDegree, 0, 100);
    const minSupport = integerOption(context, "min-support", settings.minSupport, 1, Number.MAX_SAFE_INTEGER);
    const counts = coupledPairs(history, { minSupport, minDegree });

    const neighbours = new Map<string, Set<string>>();
    for (const pair of counts.pairs) {
      for (const [from, to] of [[pair.a, pair.b], [pair.b, pair.a]] as const) {
        let set = neighbours.get(from);
        if (!set) neighbours.set(from, (set = new Set()));
        set.add(to);
      }
    }

    const rows = components(counts.pairs).map((files) => {
      const members = new Set(files);
      const inside = counts.pairs.filter((pair) => members.has(pair.a));
      const folders = new Set(files.map(folderOf)).size;
      const spread = changeSpread(files);
      const meanDegree = inside.reduce((sum, pair) => sum + degreeOf(pair), 0) / inside.length;
      const weakestSupport = Math.min(...inside.map((pair) => pair.support));
      const magnets = files.filter((file) => isMagnet(file, neighbours));
      const findings = [...(magnets.length > 0 ? ["change-magnet"] : []), ...(folders >= CLUSTER_MIN_FOLDERS ? ["cluster"] : [])];
      return {
        path: files[0]!,
        score: round1((folders * spread * meanDegree) / 100),
        size: files.length,
        folders,
        spread: round1(spread),
        meanDegree: round1(meanDegree),
        files,
        magnets,
        findings,
        evidence: { pairs: inside.length, weakestSupport, clearsMinimum: weakestSupport >= settings.minSupport },
      };
    });
    rows.sort((x, y) => y.score - x.score || compareBytes(x.path, y.path));

    return {
      inputs: { minDegree, minSupport, magnet: MAGNET, clusterMinFolders: CLUSTER_MIN_FOLDERS },
      results: rows,
      columns: ["path", "score", "size", "folders", "spread", "meanDegree", "findings"],
      extra: {
        population: { eligibleChanges: counts.eligibleChanges, oversizedExcluded: counts.oversizedChanges },
        note:
          rows.length === 0
            ? `No cluster: no pair reaches support ${minSupport} and degree ${minDegree} %. The thresholds were not lowered; a young or sparse history has little coupling evidence.`
            : null,
      },
    };
  },
});
