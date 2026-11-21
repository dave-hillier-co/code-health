import { compareIds, type Graph } from "@code-health/graph/graph";
import { stronglyConnectedComponents } from "@code-health/graph/scc";
import { round3 } from "../stability.ts";
import type { PackageAnalysis } from "./analysis.ts";
import { independenceTail } from "./changes.ts";
import type { Finding } from "./findings.ts";
import { consumerPackages, isPublished, isYoung, purposeOf, type PackageModel } from "./model.ts";
import { deployablesOf } from "./release.ts";
import type { ExportComponent, ReuseAnalysis } from "./reuse.ts";

export type CandidateKind = "merge" | "split" | "move-unit" | "narrow-interface" | "fix-manifest" | "break-dependency";

/**
 * Evidence that argues against a candidate. A hard reason means the tool's own heuristics would recommend
 * the opposite once the candidate is applied (or that it cannot be applied), so the candidate is blocked.
 * A soft one is for the skill to weigh.
 */
export interface Against {
  kind: "declared-purpose" | "different-deployables" | "creates-disjoint-reuse" | "creates-always-together" | "creates-package-cycle" | "consumers-on-both-sides";
  hard: boolean;
  detail: string;
  packages: string[];
}

export interface Candidate {
  /** `<kind>:<subjects>`, stable across runs. */
  id: string;
  kind: CandidateKind;
  status: "proposed" | "blocked";
  /** The packages involved. For a merge, the package that goes first and the one that stays. */
  packages: string[];
  /** For a merge, the package that remains. */
  into: string | null;
  /** For a move, the file that moves. */
  unit: string | null;
  /** For a split, the groups of exports that would become packages. */
  parts: { exports: string[]; consumers: string[] }[] | null;
  /** The findings behind it, by id. */
  findings: string[];
  against: Against[];
  /** Logical changes in the window that crossed the boundary in question, weighted by recency. The most any one finding behind it addresses. */
  changeCost: number;
  tentative: boolean;
  /** Where the step stands in the skill's order of preference: manifests first, then moving a unit, narrowing, merging, splitting. */
  step: number;
  /** What the candidate would also fix, such as a package cycle. */
  also: string[];
  /** The command that gives the evidence pack for a dependency to break, for the structure skill. */
  handoff: string | null;
}

export interface Withheld {
  kind: CandidateKind;
  packages: string[];
  reason: string;
  findings: string[];
}

export interface Candidates {
  candidates: Candidate[];
  /** Candidates that would change a published package, whose consumers outside the repository cannot be seen. */
  withheld: Withheld[];
}

const STEP: Record<CandidateKind, number> = { "fix-manifest": 1, "move-unit": 2, "narrow-interface": 3, merge: 4, split: 5, "break-dependency": 3 };

const unordered = (a: string, b: string): string => (compareIds(a, b) < 0 ? `${a}\0${b}` : `${b}\0${a}`);

function newCycles(model: PackageModel, file: string, to: string): string[][] {
  const graphOf = (owner: (path: string) => string | undefined): Graph => {
    const adjacency = new Map<string, string[]>(model.packages.map((p) => [p.id, []]));
    for (const [from, targets] of model.project.graph) {
      const source = owner(from);
      if (source === undefined) continue;
      for (const target of targets) {
        const destination = owner(target);
        if (destination !== undefined && destination !== source) adjacency.get(source)!.push(destination);
      }
    }
    for (const edge of model.edges.values()) if (edge.declared === "runtime") adjacency.get(edge.from)!.push(edge.to);
    return adjacency;
  };
  const cyclic = (graph: Graph) => stronglyConnectedComponents(graph).filter((component) => component.length > 1);
  const before = new Set(cyclic(graphOf((path) => model.index.owner(path))).map((c) => c.join("\0")));
  return cyclic(graphOf((path) => (path === file ? to : model.index.owner(path)))).filter((component) => !before.has(component.join("\0")));
}

function importersOf(model: PackageModel, file: string): string[] {
  const importers: string[] = [];
  for (const [from, targets] of model.project.graph) if (from !== file && targets.includes(file)) importers.push(from);
  return importers;
}

function mergeDisjoint(model: PackageModel, reuse: ReuseAnalysis, a: string, b: string): { groups: string[]; overlap: number } | null {
  const profiles = [reuse.profiles.get(a), reuse.profiles.get(b)];
  if (profiles.some((p) => p === undefined)) return null;
  const components: ExportComponent[] = [];
  for (const profile of profiles) {
    for (const component of profile!.components) {
      const consumers = component.consumers.filter((c) => c !== a && c !== b);
      if (consumers.length > 0) components.push({ exports: component.exports, consumers });
    }
  }
  if (components.length < 2) return null;
  let overlap = 0;
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const left = new Set(components[i]!.consumers);
      const shared = components[j]!.consumers.filter((c) => left.has(c)).length;
      overlap = Math.max(overlap, shared / (left.size + components[j]!.consumers.length - shared));
    }
  }
  if (overlap > model.settings.packages.disjointOverlap) return null;
  return { groups: components.map((c) => `${c.exports.map((e) => e.slice(e.lastIndexOf("#") + 1)).join("+")}:${c.consumers.join("+")}`), overlap: round3(overlap) };
}

/** Components of a package that would become always-together if they were packages: they co-change with each other. */
function togetherComponents(model: PackageModel, id: string, parts: readonly ExportComponent[]): { a: number; b: number; shared: number }[] {
  const { minSupport, minConfidence, minLift, significance } = model.settings.packages;
  const filesOf = parts.map((part) => new Set(part.exports.map((key) => key.slice(0, key.lastIndexOf("#")))));
  const touching = model.changes.filter((c) => !c.oversized && c.touched.includes(id));
  const counts = parts.map(() => 0);
  const pair = new Map<string, number>();
  for (const change of touching) {
    const hit = filesOf.map((files) => change.files.some((f) => f.package === id && files.has(f.path)));
    hit.forEach((h, i) => {
      if (h) counts[i]!++;
    });
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) if (hit[i] && hit[j]) pair.set(`${i}:${j}`, (pair.get(`${i}:${j}`) ?? 0) + 1);
    }
  }
  const found: { a: number; b: number; shared: number }[] = [];
  for (const [key, shared] of pair) {
    const [a, b] = key.split(":").map(Number) as [number, number];
    const total = model.activity.eligibleChanges;
    const lift = (shared * total) / (counts[a]! * counts[b]!);
    if (shared >= minSupport && shared / counts[a]! >= minConfidence && shared / counts[b]! >= minConfidence && lift >= minLift && independenceTail(shared, counts[a]!, counts[b]!, total) <= significance) {
      found.push({ a, b, shared });
    }
  }
  return found;
}

export function buildCandidates(model: PackageModel, analysis: PackageAnalysis): Candidates {
  const { reuse } = analysis;
  const found = new Map<string, Candidate>();
  const withheld: Withheld[] = [];
  const mismatched = new Set(analysis.boundaries.filter((f) => f.kind === "purpose-mismatch").map((f) => f.packages[0]!));

  const add = (candidate: Omit<Candidate, "step" | "status" | "tentative" | "also" | "handoff"> & { also?: string[]; handoff?: string | null }): void => {
    const existing = found.get(candidate.id);
    if (existing) {
      existing.findings = [...new Set([...existing.findings, ...candidate.findings])].sort(compareIds);
      existing.changeCost = Math.max(existing.changeCost, candidate.changeCost);
      return;
    }
    found.set(candidate.id, {
      ...candidate,
      status: candidate.against.some((a) => a.hard) ? "blocked" : "proposed",
      tentative: candidate.packages.some((id) => isYoung(model, id)),
      step: STEP[candidate.kind],
      also: candidate.also ?? [],
      handoff: candidate.handoff ?? null,
    });
  };

  const publishedAmong = (ids: readonly string[]): string[] => ids.filter((id) => isPublished(model, model.byId.get(id)!));
  const withhold = (kind: CandidateKind, ids: string[], findings: Finding[]): boolean => {
    const published = publishedAmong(ids);
    if (published.length === 0) return false;
    withheld.push({ kind, packages: ids, reason: `${published.join(", ")} ${published.length === 1 ? "is" : "are"} published: its consumers outside the repository cannot be seen, so nothing is proposed`, findings: findings.map((f) => f.id).sort(compareIds) });
    return true;
  };

  const softAgainst = (ids: readonly string[]): Against[] => {
    const against: Against[] = [];
    for (const id of ids) {
      const purpose = purposeOf(model, model.byId.get(id)!);
      if (purpose !== null && !mismatched.has(id)) {
        against.push({ kind: "declared-purpose", hard: false, detail: `${id} is declared for ${purpose}, and the evidence does not contradict it`, packages: [id] });
      }
    }
    return against;
  };

  // ---- merge ----
  // A finding may say which package should stay: the consumer of a single-consumer package, the source of
  // a pass-through. When findings disagree about one pair, a pass-through outranks a single consumer.
  const merges = new Map<string, { a: string; b: string; findings: Finding[]; keep: { id: string; rank: number } | null }>();
  const gather = (a: string, b: string, finding: Finding, keep?: { id: string; rank: number }): void => {
    if (a === b || !model.byId.has(a) || !model.byId.has(b)) return;
    const key = unordered(a, b);
    const entry = merges.get(key) ?? { a: compareIds(a, b) < 0 ? a : b, b: compareIds(a, b) < 0 ? b : a, findings: [], keep: null };
    entry.findings.push(finding);
    if (keep !== undefined && (entry.keep === null || keep.rank > entry.keep.rank)) entry.keep = keep;
    merges.set(key, entry);
  };
  for (const finding of analysis.all) {
    const [first, second] = finding.packages as [string, string | undefined];
    if (finding.kind === "always-together" || finding.kind === "lockstep") gather(first, second!, finding);
    if (finding.kind === "single-consumer") gather(first, second!, finding, { id: second!, rank: 2 });
    if (finding.kind === "tiny") {
      const consumers = consumerPackages(model, first);
      const partner = consumers.length === 1 ? consumers[0] : [...model.activity.partners(first)].sort(([ia, a], [ib, b]) => b - a || compareIds(ia, ib))[0]?.[0];
      if (partner !== undefined) gather(first, partner, finding, consumers.length === 1 ? { id: partner, rank: 1 } : undefined);
    }
    if (finding.kind === "pass-through-package") {
      const profile = reuse.profiles.get(first);
      const owners = new Map<string, number>();
      for (const element of profile?.surface ?? []) {
        const owner = model.index.owner(element.file);
        if (owner !== undefined && owner !== first) owners.set(owner, (owners.get(owner) ?? 0) + 1);
      }
      const source = [...owners].sort(([ia, a], [ib, b]) => b - a || compareIds(ia, ib))[0]?.[0];
      if (source !== undefined) gather(first, source, finding, { id: source, rank: 3 });
    }
  }
  for (const { a, b, findings, keep: preferred } of [...merges.values()].sort((x, y) => compareIds(x.a, y.a) || compareIds(x.b, y.b))) {
    if (withhold("merge", [a, b], findings)) continue;
    const [keep, go] = preferred !== null && !model.byId.get(preferred.id === a ? b : a)!.entry ? [preferred.id, preferred.id === a ? b : a] : mergeDirection(model, a, b);
    const against: Against[] = softAgainst([a, b]);
    const [da, db] = [deployablesOf(model, a), deployablesOf(model, b)];
    if (da.length > 0 && db.length > 0 && da.join() !== db.join()) {
      against.push({ kind: "different-deployables", hard: false, detail: `${a} ships in ${da.join(", ")} and ${b} in ${db.join(", ")}`, packages: [a, b] });
    }
    const disjoint = mergeDisjoint(model, reuse, a, b);
    if (disjoint !== null) {
      against.push({ kind: "creates-disjoint-reuse", hard: true, detail: `the merged package would have consumers that use disjoint parts of it (${disjoint.groups.join("; ")}), and disjoint-reuse would recommend the split back`, packages: [a, b] });
    }
    const cycle = analysis.coupling.find((f) => f.kind === "package-cycle" && f.packages.includes(a) && f.packages.includes(b));
    add({
      id: `merge:${go}->${keep}`,
      kind: "merge",
      packages: [go, keep],
      into: keep,
      unit: null,
      parts: null,
      findings: findings.map((f) => f.id).sort(compareIds),
      against,
      changeCost: Math.max(...findings.map((f) => f.changeCost)),
      also: cycle === undefined ? [] : [cycle.id],
    });
  }

  // ---- split ----
  const splitFindings = new Map<string, Finding[]>();
  for (const finding of analysis.cohesion) {
    if (finding.kind === "disjoint-reuse" || finding.kind === "dumping-ground" || finding.kind === "inherited-weight") {
      splitFindings.set(finding.packages[0]!, [...(splitFindings.get(finding.packages[0]!) ?? []), finding]);
    }
  }
  for (const [id, findings] of [...splitFindings].sort(([a], [b]) => compareIds(a, b))) {
    if (withhold("split", [id], findings)) continue;
    const profile = reuse.profiles.get(id);
    if (!profile) continue;
    const consumed = profile.components.filter((c) => c.consumers.length > 0);
    const parts = consumed.length >= 2 ? consumed : profile.components;
    if (parts.length < 2) continue;
    const against = softAgainst([id]);
    const together = togetherComponents(model, id, parts);
    if (together.length > 0) {
      against.push({
        kind: "creates-always-together",
        hard: true,
        detail: `${together.map((t) => `groups ${t.a + 1} and ${t.b + 1} changed together in ${t.shared} changes`).join("; ")}: as packages they would be always-together, and the merge would be recommended back`,
        packages: [id],
      });
    }
    add({
      id: `split:${id}`,
      kind: "split",
      packages: [id],
      into: null,
      unit: null,
      parts: parts.map((p) => ({ exports: p.exports.map((e) => e.slice(e.lastIndexOf("#") + 1)), consumers: p.consumers })),
      findings: findings.map((f) => f.id).sort(compareIds),
      against,
      changeCost: Math.max(...findings.map((f) => f.changeCost)),
    });
  }

  // ---- move-unit ----
  const followers = analysis.cohesion.filter((f) => f.kind === "follower");
  for (const finding of analysis.cohesion.filter((f) => f.kind === "crossing-unit")) {
    const [from, to] = finding.packages as [string, string];
    const unit = finding.unit!;
    if (withhold("move-unit", [from, to], [finding])) continue;
    const against = softAgainst([from, to]);
    const cycles = newCycles(model, unit, to);
    if (cycles.length > 0) {
      against.push({ kind: "creates-package-cycle", hard: true, detail: `moving ${unit} into ${to} would make ${cycles.map((c) => c.join(", ")).join("; ")} depend on each other`, packages: [from, to] });
    }
    const importers = importersOf(model, unit);
    const inFrom = importers.filter((f) => model.index.owner(f) === from);
    const inTo = importers.filter((f) => model.index.owner(f) === to);
    if (inFrom.length > 0 && inTo.length > 0) {
      against.push({ kind: "consumers-on-both-sides", hard: true, detail: `${unit} is imported by ${inFrom.length} file${inFrom.length === 1 ? "" : "s"} of ${from} and ${inTo.length} of ${to}`, packages: [from, to] });
    }
    const related = followers.filter((f) => (f.packages[0] === to && f.packages[1] === from) || (f.packages[0] === from && f.packages[1] === to));
    add({
      id: `move-unit:${unit}->${to}`,
      kind: "move-unit",
      packages: [from, to],
      into: to,
      unit,
      parts: null,
      findings: [finding.id, ...related.map((f) => f.id)].sort(compareIds),
      against,
      changeCost: finding.changeCost,
    });
  }
  for (const finding of followers) {
    const [from, to] = finding.packages as [string, string];
    if ([...found.values()].some((c) => c.kind === "move-unit" && c.findings.includes(finding.id))) continue;
    if (withhold("move-unit", [from, to], [finding])) continue;
    add({
      id: `move-unit:${to}->${from}`,
      kind: "move-unit",
      packages: [to, from],
      into: from,
      unit: null,
      parts: null,
      findings: [finding.id],
      against: softAgainst([from, to]),
      changeCost: finding.changeCost,
    });
  }

  // ---- narrow-interface ----
  const narrowing = new Map<string, Finding[]>();
  for (const finding of [...analysis.cohesion.filter((f) => f.kind === "overexposed"), ...analysis.boundaries.filter((f) => f.kind === "deep-import"), ...analysis.coupling.filter((f) => f.kind === "volatile-interface")]) {
    narrowing.set(finding.packages[0]!, [...(narrowing.get(finding.packages[0]!) ?? []), finding]);
  }
  for (const [id, findings] of [...narrowing].sort(([a], [b]) => compareIds(a, b))) {
    if (withhold("narrow-interface", [id], findings)) continue;
    add({
      id: `narrow-interface:${id}`,
      kind: "narrow-interface",
      packages: [id],
      into: null,
      unit: null,
      parts: null,
      findings: findings.map((f) => f.id).sort(compareIds),
      against: softAgainst([id]),
      changeCost: Math.max(...findings.map((f) => f.changeCost)),
    });
  }

  // ---- fix-manifest ----
  const fixes = new Map<string, Finding[]>();
  for (const finding of analysis.boundaries.filter((f) => f.kind === "undeclared-dependency" || f.kind === "unused-dependency")) {
    fixes.set(finding.packages[0]!, [...(fixes.get(finding.packages[0]!) ?? []), finding]);
  }
  for (const [id, findings] of [...fixes].sort(([a], [b]) => compareIds(a, b))) {
    add({
      id: `fix-manifest:${id}`,
      kind: "fix-manifest",
      packages: [id],
      into: null,
      unit: null,
      parts: null,
      findings: findings.map((f) => f.id).sort(compareIds),
      against: [],
      changeCost: 0,
    });
  }

  // ---- break-dependency ----
  for (const finding of analysis.coupling) {
    if (finding.kind === "against-stability") {
      const [from, to] = finding.packages as [string, string];
      add({ id: `break-dependency:${from}->${to}`, kind: "break-dependency", packages: [from, to], into: null, unit: null, parts: null, findings: [finding.id], against: [], changeCost: finding.changeCost, handoff: `structure evidence "${from}->${to}" --level package` });
    }
    if (finding.kind === "zone-of-pain") {
      // the dependants are what ripples: each dependency on it is one to break or invert
      const id = finding.packages[0]!;
      for (const [from, targets] of model.model.graph.graph) {
        if (!targets.includes(id)) continue;
        add({ id: `break-dependency:${from}->${id}`, kind: "break-dependency", packages: [from, id], into: null, unit: null, parts: null, findings: [finding.id], against: [], changeCost: finding.changeCost, handoff: `structure evidence "${from}->${id}" --level package` });
      }
    }
    if (finding.kind === "package-cycle") {
      for (const edge of finding.evidence.breakingSet as string[]) {
        const [from, to] = edge.split("->") as [string, string];
        add({ id: `break-dependency:${from}->${to}`, kind: "break-dependency", packages: [from, to], into: null, unit: null, parts: null, findings: [finding.id], against: [], changeCost: finding.changeCost, handoff: `structure evidence "${from}->${to}" --level package` });
      }
    }
  }

  const candidates = [...found.values()].sort(
    (a, b) =>
      Number(a.status === "blocked") - Number(b.status === "blocked") ||
      b.changeCost - a.changeCost ||
      a.step - b.step ||
      Number(a.tentative) - Number(b.tentative) ||
      compareIds(a.id, b.id),
  );
  return { candidates, withheld: withheld.sort((a, b) => compareIds(a.kind, b.kind) || compareIds(a.packages.join(), b.packages.join())) };
}

/** Which of two packages stays in a merge: an entry point, else the one with more consumers, then more files, then the first by name. Returns [keep, go]. */
function mergeDirection(model: PackageModel, a: string, b: string): [string, string] {
  // an application or tool is never merged away
  const entry = [a, b].filter((id) => model.byId.get(id)!.entry);
  if (entry.length === 1) return entry[0] === a ? [a, b] : [b, a];
  const score = (id: string): [number, number] => [consumerPackages(model, id).length, model.files.get(id)?.length ?? 0];
  const [sa, sb] = [score(a), score(b)];
  if (sa[0] !== sb[0]) return sa[0] > sb[0] ? [a, b] : [b, a];
  if (sa[1] !== sb[1]) return sa[1] > sb[1] ? [a, b] : [b, a];
  return compareIds(a, b) <= 0 ? [a, b] : [b, a];
}

