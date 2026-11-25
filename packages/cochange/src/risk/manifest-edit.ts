import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBlobAt } from "@code-health/history/tree";
import { bandCount } from "./bands.ts";
import type { BranchChange } from "./change.ts";
import type { Factor } from "./factor.ts";
import type { RiskSettings } from "./settings.ts";

/** Dependency manifests, by file name, whose edits are often only version bumps. */
const MANIFEST_NAMES = new Set(["package.json", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "pyproject.toml", "requirements.txt", "Gemfile", "composer.json"]);
const MANIFEST_EXTENSIONS = [".csproj", ".fsproj", ".vbproj"];

export function isDependencyManifest(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return MANIFEST_NAMES.has(name) || MANIFEST_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** A commit id written in a manifest to pin a git dependency. */
const REVISION = /(?<![0-9A-Za-z_])[0-9a-f]{7,40}(?![0-9A-Za-z_])/g;
/** A version with its constraint operator: `1.0.100`, `^18.2.0`, `>=2`, `v0.0.0-20230101-abcdef`, `1.2.*`. Not the digits of a name such as `md-5` or `foo2`. */
const VERSION = /(?<![0-9A-Za-z_-])[~^=<>!]{0,2}v?\d+(?:\.[0-9A-Za-z*]+)*(?:[-+][0-9A-Za-z.]+)*/g;

const normalise = (line: string): string => line.replace(REVISION, "<revision>").replace(VERSION, "<version>").trim();

/** The lines only one side has, each side as a multiset. */
function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after.split("\n")) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added.push(line);
  }
  const removed = [...counts].flatMap(([line, left]) => Array.from({ length: left }, () => line));
  return { removed, added };
}

/**
 * Whether an edit to a manifest changes dependency versions and nothing else: every line it removes has a line it adds
 * that is the same once versions and pinned revisions are set aside, and the other way round. Adding, removing or
 * reconfiguring a dependency, or any other edit, is a structural change. Decided from the text alone, so the answer is
 * the same on every run.
 */
export function versionOnly(before: string, after: string): boolean {
  const { removed, added } = changedLines(before, after);
  if (removed.length === 0 && added.length === 0) return false;
  if (removed.length !== added.length) return false;
  const left = removed.map(normalise).sort();
  const right = added.map(normalise).sort();
  return left.every((line, i) => line === right[i]);
}

async function sides(root: string, change: BranchChange, path: string, oldPath: string | null): Promise<{ before?: string; after?: string }> {
  const before = await readBlobAt(root, change.base, oldPath ?? path);
  let after: string | undefined;
  if (change.worktree) {
    try {
      after = readFileSync(join(root, path), "utf8");
    } catch {
      after = undefined;
    }
  } else after = await readBlobAt(root, change.head, path);
  return { before, after };
}

/**
 * `sensitive-paths` with dependency version bumps set apart: a manifest whose edit only changes versions is listed in
 * `value.versionOnly` and not counted, so it raises no event. Every other match still counts.
 */
export async function withVersionBumps(factor: Factor, root: string, change: BranchChange, risk: RiskSettings): Promise<Factor> {
  if (factor.status !== "ok") return factor;
  const bumps: string[] = [];
  for (const row of factor.evidence) {
    const path = String(row.file);
    if (!isDependencyManifest(path)) continue;
    const file = change.files.find((f) => f.path === path);
    if (file === undefined || file.status !== "M") continue;
    const { before, after } = await sides(root, change, path, file.oldPath);
    if (before === undefined || after === undefined) continue;
    if (versionOnly(before, after)) bumps.push(path);
  }
  if (bumps.length === 0) return factor;
  const evidence = factor.evidence.filter((row) => !bumps.includes(String(row.file)));
  const count = evidence.length;
  return {
    ...factor,
    band: bandCount(count, { moderate: risk.countModerate, high: risk.countHigh }),
    value: { ...factor.value, count, versionOnly: bumps },
    evidence,
  };
}
