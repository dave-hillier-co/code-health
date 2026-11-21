import { compareIds } from "@code-health/graph/graph";
import { runGit } from "@code-health/history/git";
import { round3 } from "../stability.ts";
import { percent, raise, type Finding, type FindingContext } from "./findings.ts";
import { consumerPackages, isPublished, isYoung, overrideOf, purposeOf, type PackageModel } from "./model.ts";
import type { DiscoveredPackage } from "./discovery.ts";
import type { ReuseAnalysis } from "./reuse-profile.ts";

/** The deployables a package ships in: what config says, otherwise every entry point that reaches it. */
export function deployablesOf(model: PackageModel, id: string): string[] {
  const configured = overrideOf(model, model.byId.get(id)!).deployables;
  if (configured !== undefined) return [...configured].sort(compareIds);
  const reaching: string[] = [];
  for (const entry of model.packages.filter((p) => p.entry && !p.testSupport)) {
    if (entry.id === id) {
      reaching.push(entry.id);
      continue;
    }
    const seen = new Set<string>([entry.id]);
    const stack = [entry.id];
    while (stack.length > 0) {
      for (const next of model.model.graph.graph.get(stack.pop()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    if (seen.has(id)) reaching.push(entry.id);
  }
  return reaching.sort(compareIds);
}

/** Every deployable of the repository: configured names, and the entry points. */
export function repositoryDeployables(model: PackageModel): string[] {
  const names = new Set<string>();
  for (const pkg of model.packages) {
    for (const name of overrideOf(model, pkg).deployables ?? []) names.add(name);
    if (pkg.entry && !pkg.testSupport && overrideOf(model, pkg).deployables === undefined) names.add(pkg.id);
  }
  return [...names].sort(compareIds);
}

const versionPattern: Partial<Record<DiscoveredPackage["ecosystem"], string>> = {
  npm: '"version"[[:space:]]*:',
  cargo: "^version[[:space:]]*=",
  python: "^version[[:space:]]*=",
  dotnet: "<Version(Prefix)?>",
};

/**
 * The commits in the window that changed a package's own version, read from its manifest's history.
 * Only ecosystems that keep the version in the manifest are covered.
 */
export async function versionChanges(model: PackageModel, root: string, pkg: DiscoveredPackage): Promise<Set<string> | null> {
  const pattern = versionPattern[pkg.ecosystem];
  if (pattern === undefined || pkg.manifest === null || pkg.version === null) return null;
  const out = await runGit(root, [
    "log",
    "--format=%H",
    `--since=@${model.windowSince}`,
    "-G",
    pattern,
    model.headSha,
    "--",
    pkg.manifest,
  ]);
  return new Set(out.split("\n").filter((line) => line !== ""));
}

/** Packages whose versions are fixed by one policy: a single version for the repository, or a fixed group. */
export function versionsAreFixed(model: PackageModel): boolean {
  const versions = model.packages.filter((p) => p.version !== null && p.private !== true).map((p) => p.version);
  return new Set(versions).size <= 1;
}

const contentFiles = (model: PackageModel, pkg: DiscoveredPackage): number => {
  const files = model.files.get(pkg.id) ?? [];
  return files.filter((path) => path !== pkg.manifest).length;
};

/** A package that is one entry point and at most one other file costs more to have than it contains. */
function tinyPackages(context: FindingContext): Finding[] {
  const { model } = context;
  const sizes = model.packages.map((p) => contentFiles(model, p)).sort((a, b) => a - b);
  if (sizes.length < 3) return [];
  const rank = Math.max(0, Math.ceil((model.settings.packages.tinyPercentile / 100) * sizes.length) - 1);
  const threshold = sizes[rank]!;
  const median = sizes[Math.floor((sizes.length - 1) / 2)]!;
  const findings: Finding[] = [];
  for (const pkg of model.packages) {
    const content = contentFiles(model, pkg);
    // the manifest is the overhead; the entry point is the other part of it
    if (content > threshold || content > 2 || content >= median) continue;
    findings.push(
      raise(context, "tiny", "REP", [pkg.id],
        `${pkg.id} holds ${content} file${content === 1 ? "" : "s"} beside its manifest: the package costs more to have than it contains`,
        { files: content, percentileSize: threshold, percentile: model.settings.packages.tinyPercentile },
        { changeCost: context.cost.package(pkg.id) }),
    );
  }
  return findings;
}

export async function releaseFindings(context: FindingContext, reuse: ReuseAnalysis, root: string): Promise<Finding[]> {
  const { model } = context;
  const findings: Finding[] = [];
  const deployables = repositoryDeployables(model);

  for (const pkg of model.packages) {
    const consumers = consumerPackages(model, pkg.id).filter((id) => id !== pkg.id);
    const published = isPublished(model, pkg);
    const purpose = purposeOf(model, pkg);
    const shipsIn = deployablesOf(model, pkg.id);
    const young = isYoung(model, pkg.id);

    if (!published && !young && !pkg.testSupport && !pkg.entry && consumers.length === 1) {
      findings.push(
        raise(context, "single-consumer", "REP", [pkg.id, consumers[0]!],
          `${pkg.id} is internal and ${consumers[0]} is the only package that uses it: nothing is being reused${purpose === null ? "" : ` (declared purpose: ${purpose})`}`,
          { consumers: 1, purpose, revisions: model.activity.revisions(pkg.id) },
          { subjects: [pkg.id], changeCost: context.cost.pair(pkg.id, consumers[0]!) }),
      );
    }

    if (consumers.length === 0 && !pkg.entry && !pkg.testSupport && purpose !== "deploy") {
      const declaredBy = model.packages.filter((p) => p.dependencies.some((d) => d.target === pkg.id && d.scope === "runtime")).map((p) => p.id);
      findings.push(
        raise(context, "no-consumer", "REP", [pkg.id],
          `nothing uses ${pkg.id}, and it is not an entry point or a deployable${declaredBy.length > 0 ? `; ${declaredBy.join(", ")} declares it without using it` : ""}`,
          { published, declaredBy },
          { changeCost: 0, priority: published ? "low" : "normal" }),
      );
    }

    if (deployables.length > 1 && shipsIn.length === 1 && !pkg.entry && !pkg.testSupport && !young) {
      findings.push(
        raise(context, "one-deployable", "REP", [pkg.id],
          `${pkg.id} ships only in ${shipsIn[0]}, of ${deployables.length} deployables: it has no release life of its own`,
          { deployable: shipsIn[0]!, deployables: deployables.length },
          { changeCost: 0 }),
      );
    }

    const profile = reuse.profiles.get(pkg.id);
    if (profile && profile.surface.length > 0 && profile.passThroughShare >= model.settings.packages.passThroughShare) {
      findings.push(
        raise(context, "pass-through-package", "REP", [pkg.id],
          `${percent(profile.passThroughShare)} of what ${pkg.id} exports is defined in other packages and only passed along: a shallow module at package level`,
          { surface: profile.surface.length, passThroughShare: profile.passThroughShare },
          { changeCost: context.cost.package(pkg.id) }),
      );
    }
  }

  findings.push(...tinyPackages(context));
  findings.push(...(await lockstep(context, root)));
  return findings;
}

/** Packages whose versions change in the same commits, where nothing fixes that. */
async function lockstep(context: FindingContext, root: string): Promise<Finding[]> {
  const { model } = context;
  if (versionsAreFixed(model)) return [];
  const versioned = model.packages.filter((p) => p.version !== null && p.private !== true && p.version !== "0.0.0");
  const changes = new Map<string, Set<string>>();
  for (const pkg of versioned) {
    const set = await versionChanges(model, root, pkg);
    if (set !== null) changes.set(pkg.id, set);
  }
  const findings: Finding[] = [];
  const ids = [...changes.keys()].sort(compareIds);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = changes.get(ids[i]!)!;
      const b = changes.get(ids[j]!)!;
      if (a.size < model.settings.packages.minSupport || a.size !== b.size || [...a].some((sha) => !b.has(sha))) continue;
      findings.push(
        raise(context, "lockstep", "REP", [ids[i]!, ids[j]!],
          `${ids[i]} and ${ids[j]} changed version in the same ${a.size} commits, with no policy fixing their versions together: separate versions are ceremony`,
          { versionChanges: a.size, ratio: round3(1) },
          { changeCost: context.cost.pair(ids[i]!, ids[j]!) }),
      );
    }
  }
  return findings;
}
