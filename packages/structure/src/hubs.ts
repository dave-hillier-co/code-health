import { compareIds } from "@code-health/graph/graph";
import { runGit } from "@code-health/history/git";
import type { LogicalChange } from "@code-health/history/noise";
import { readBlobAt } from "@code-health/history/tree";
import { appendShape, collectionOpener, parseUnifiedHunks, type Hunk } from "@code-health/lexical/hunk-shape";
import type { StructureSettings } from "./config.ts";
import type { Model } from "./model.ts";
import { coChangePValue } from "./significance.ts";

export type HubSettings = Pick<
  StructureSettings,
  | "minSupport"
  | "minRevisions"
  | "significanceLevel"
  | "hubMinFeatures"
  | "hubMinConfidence"
  | "hubMaxFeatureCoupling"
  | "hubMinOutward"
  | "hubMinAppendShare"
  | "hubContentionDays"
  | "hubMinAuthors"
>;

export interface HubFeature {
  module: string;
  /** Eligible logical changes that touched the hub file and the feature. */
  shared: number;
  featureChanges: number;
  /** Percent of the feature's changes that also touched the hub: feature to hub. */
  confidenceFeatureToHub: number;
  /** Percent of the hub's changes that also touched the feature. */
  confidenceHubToFeature: number;
  /** Chance of at least `shared` shared changes if hub and feature changed independently. */
  pValue: number;
  /** How the hub names the feature: it imports one of its files, or holds a path string naming it. */
  referencedBy: "import" | "path-string" | null;
}

export interface Hub {
  id: string;
  file: string;
  module: string;
  level: string;
  featureCount: number;
  /** Logical changes to the hub file in the window. */
  revisions: number;
  features: HubFeature[];
  /** How many of the four signals reached their guidelines. A hub is listed when at least two did. */
  signalsReached: number;
  /** The four signals, each with the figures behind it and whether it reached its guideline. */
  signals: {
    starCoChange: {
      reached: boolean;
      features: number;
      /** Pairs of those features that are active or co-change highly, so a low co-change between them is evidence. */
      featurePairs: { classified: number; high: number };
    };
    outwardDependencies: { reached: boolean; referenced: number; of: number };
    appendShapedEdits: {
      reached: boolean;
      hunks: number;
      appendShaped: number;
      additions: number;
      removals: number;
      /** The line, at the analysed commit, that opens the collection literal being appended to. */
      collection: { line: number; text: string } | null;
    };
    contention: { reached: boolean; maxAuthors: number; windowDays: number };
  };
}

export interface HubInputs {
  root: string;
  headSha: string;
  model: Model;
  changes: readonly LogicalChange[];
  settings: HubSettings;
}

interface FileHistory {
  changes: LogicalChange[];
  /** Eligible changes that touched the file. */
  eligible: number;
  /** Eligible changes that touched the file and each other module. */
  shared: Map<string, number>;
}

const percent = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What each production file changed with, one pass over the changes. */
function fileHistories(model: Model, changes: readonly LogicalChange[]): Map<string, FileHistory> {
  const histories = new Map<string, FileHistory>();
  for (const change of changes) {
    const touched = new Map<string, string>();
    for (const file of change.files) {
      const module = model.graph.moduleByFile.get(file.fileId);
      if (module !== undefined) touched.set(file.fileId, module);
    }
    const modules = new Set(touched.values());
    for (const [path, own] of touched) {
      let history = histories.get(path);
      if (history === undefined) histories.set(path, (history = { changes: [], eligible: 0, shared: new Map() }));
      history.changes.push(change);
      if (change.oversized) continue;
      history.eligible++;
      for (const module of modules) if (module !== own) history.shared.set(module, (history.shared.get(module) ?? 0) + 1);
    }
  }
  return histories;
}

/** Whether a path string in the text names the module: a quoted string with the module's own name as one of its segments. */
function namesInPathString(text: string, module: string): boolean {
  const name = module.slice(module.lastIndexOf("/") + 1);
  if (name === "" || name === ".") return false;
  const segment = escape(name);
  return new RegExp(`["'\`](?:[^"'\`\\n]*[/._-])?${segment}(?:[/._-][^"'\`\\n]*)?["'\`]`, "i").test(text);
}

/** The hunks of every window commit that changed the file, newest first. Commits that add the file are left out: nothing was appended to it. */
async function windowHunks(root: string, headSha: string, file: string, shas: ReadonlySet<string>): Promise<Hunk[]> {
  const log = await runGit(root, ["log", "-p", "-U2", "--no-renames", "--no-color", "--no-ext-diff", "--format=%x01%H", headSha, "--", file]);
  const hunks: Hunk[] = [];
  for (const entry of log.split("\u0001").slice(1)) {
    const newline = entry.indexOf("\n");
    const sha = entry.slice(0, newline).trim();
    const diff = entry.slice(newline + 1);
    if (!shas.has(sha) || /^new file mode/m.test(diff)) continue;
    hunks.push(...parseUnifiedHunks(diff));
  }
  return hunks;
}

/** The most distinct authors among changes whose dates fall within `windowSeconds` of each other. */
function maxAuthorsWithin(changes: readonly LogicalChange[], windowSeconds: number): number {
  const sorted = [...changes].sort((a, b) => a.committerDate - b.committerDate);
  const inWindow = new Map<string, number>();
  let most = 0;
  let start = 0;
  for (const change of sorted) {
    for (const author of change.authors) inWindow.set(author, (inWindow.get(author) ?? 0) + 1);
    while (change.committerDate - sorted[start]!.committerDate > windowSeconds) {
      for (const author of sorted[start]!.authors) {
        const left = inWindow.get(author)! - 1;
        if (left === 0) inWindow.delete(author);
        else inWindow.set(author, left);
      }
      start++;
    }
    most = Math.max(most, inWindow.size);
  }
  return most;
}

const SIGNALS_LISTED = 2;

const share = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

/** Hubs with more signals first, then by the figures behind each signal (features, outward share, append share, authors), then revisions and path. */
export function compareHubs(a: Hub, b: Hub): number {
  return (
    b.signalsReached - a.signalsReached ||
    b.featureCount - a.featureCount ||
    share(b.signals.outwardDependencies.referenced, b.signals.outwardDependencies.of) - share(a.signals.outwardDependencies.referenced, a.signals.outwardDependencies.of) ||
    share(b.signals.appendShapedEdits.appendShaped, b.signals.appendShapedEdits.hunks) - share(a.signals.appendShapedEdits.appendShaped, a.signals.appendShapedEdits.hunks) ||
    b.signals.contention.maxAuthors - a.signals.contention.maxAuthors ||
    b.revisions - a.revisions ||
    compareIds(a.file, b.file)
  );
}

/**
 * Registration hubs: central files that every feature has to edit. Four signals describe one, and
 * each alone matches ordinary files (a busy file, a barrel of imports), so a file is listed when at
 * least two reach their guidelines and the all-four files sort first:
 *
 * 1. Star co-change: at least `hubMinFeatures` modules each co-change with it significantly and at
 *    high confidence feature to hub, while those features rarely co-change with each other.
 * 2. Outward dependencies: it imports the features, or holds a path string naming them.
 * 3. Append-shaped edits: most of its diff hunks add or remove entries of one collection (see
 *    `appendShape`, which works in any language).
 * 4. Contention: `hubMinAuthors` distinct authors edit it within `hubContentionDays`. Only the count is used.
 *
 * The model must count every pair of modules (`everyPair`). See `compareHubs` for the order.
 */
export async function findHubs({ root, headSha, model, changes, settings }: HubInputs): Promise<Hub[]> {
  const { activity, graph, project } = model;
  const histories = fileHistories(model, changes);
  const hubs: Hub[] = [];

  for (const [file, history] of [...histories].sort((a, b) => compareIds(a[0], b[0]))) {
    if (history.eligible < settings.minRevisions) continue;
    const features: HubFeature[] = [];
    for (const [module, shared] of history.shared) {
      const featureChanges = activity.eligibleRevisions(module);
      const pValue = coChangePValue({ shared, a: history.eligible, b: featureChanges, total: activity.eligibleChanges });
      const confidence = percent(shared, featureChanges);
      if (shared < settings.minSupport || confidence < settings.hubMinConfidence || pValue > settings.significanceLevel) continue;
      features.push({
        module,
        shared,
        featureChanges,
        confidenceFeatureToHub: confidence,
        confidenceHubToFeature: percent(shared, history.eligible),
        pValue,
        referencedBy: null,
      });
    }
    features.sort((a, b) => compareIds(a.module, b.module));

    // the features must rarely co-change with each other
    let classified = 0;
    let high = 0;
    for (let i = 0; i < features.length; i++) {
      for (let j = i + 1; j < features.length; j++) {
        const [a, b] = [features[i]!.module, features[j]!.module];
        const shared = activity.shared(a, b);
        const together =
          shared >= settings.minSupport &&
          coChangePValue({ shared, a: activity.eligibleRevisions(a), b: activity.eligibleRevisions(b), total: activity.eligibleChanges }) <= settings.significanceLevel;
        const bothActive = activity.revisions(a) >= settings.minRevisions && activity.revisions(b) >= settings.minRevisions;
        if (together || bothActive) classified++;
        if (together) high++;
      }
    }
    const starReached = features.length >= settings.hubMinFeatures && !(classified > 0 && percent(high, classified) > settings.hubMaxFeatureCoupling);

    // the stable mechanism depends on the volatile features
    let text = "";
    let referenced = 0;
    if (features.length > 0) {
      text = (await readBlobAt(root, headSha, file)) ?? "";
      const imported = new Set((project.graph.get(file) ?? []).map((target) => graph.moduleByFile.get(target)));
      for (const feature of features) {
        feature.referencedBy = imported.has(feature.module) ? "import" : namesInPathString(text, feature.module) ? "path-string" : null;
      }
      referenced = features.filter((f) => f.referencedBy !== null).length;
    }
    const outwardReached = features.length > 0 && percent(referenced, features.length) >= settings.hubMinOutward;

    const maxAuthors = maxAuthorsWithin(history.changes, settings.hubContentionDays * 86_400);
    const contentionReached = maxAuthors >= settings.hubMinAuthors;

    // the diff is read only when the file can still reach two signals
    const cheapReached = [starReached, outwardReached, contentionReached].filter(Boolean).length;
    if (cheapReached === 0) continue;

    // most of its edits add or remove entries of one collection
    const shas = new Set(history.changes.flatMap((change) => change.shas));
    const hunks = await windowHunks(root, headSha, file, shas);
    const shapes = hunks.map((hunk) => ({ hunk, shape: appendShape(hunk) }));
    const appended = shapes.filter((s) => s.shape !== null);
    const appendReached = hunks.length >= settings.minSupport && percent(appended.length, hunks.length) >= settings.hubMinAppendShare;
    const signalsReached = cheapReached + (appendReached ? 1 : 0);
    if (signalsReached < SIGNALS_LISTED) continue;

    if (text === "") text = (await readBlobAt(root, headSha, file)) ?? "";
    const lines = text.split("\n");
    let collection: { line: number; text: string } | null = null;
    for (const { hunk } of appended) {
      const entries = hunk.lines.filter((l) => l.kind !== " " && l.text.trim() !== "").map((l) => l.text);
      const context = hunk.lines.filter((l) => l.kind === " " && l.text.trim() !== "").map((l) => l.text);
      for (const candidate of [...entries, ...context]) {
        collection = collectionOpener(lines, candidate) ?? null;
        if (collection !== null) break;
      }
      if (collection !== null) break;
    }

    hubs.push({
      id: `hub:${file}`,
      file,
      module: graph.moduleByFile.get(file)!,
      level: graph.level,
      featureCount: features.length,
      revisions: history.changes.length,
      features,
      signalsReached,
      signals: {
        starCoChange: { reached: starReached, features: features.length, featurePairs: { classified, high } },
        outwardDependencies: { reached: outwardReached, referenced, of: features.length },
        appendShapedEdits: {
          reached: appendReached,
          hunks: hunks.length,
          appendShaped: appended.length,
          additions: shapes.filter((s) => s.shape === "addition").length,
          removals: shapes.filter((s) => s.shape === "removal").length,
          collection,
        },
        contention: { reached: contentionReached, maxAuthors, windowDays: settings.hubContentionDays },
      },
    });
  }
  return hubs.sort(compareHubs);
}
