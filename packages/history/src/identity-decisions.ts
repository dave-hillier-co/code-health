import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configError } from "@code-health/cli-kit/errors";
import { serialise } from "@code-health/cli-kit/serialise";
import type { ClassificationDecision } from "./identity-classify.ts";

export type MappingLocation = "committed" | "local";

export interface RejectedMerge {
  /** Two raw identities, `Name <email>`, that are different people. */
  identities: [string, string];
  reason?: string;
}

export interface IdentityDecisions {
  schemaVersion: 1;
  rejectedMerges: RejectedMerge[];
  classifications: ClassificationDecision[];
}

export const emptyDecisions = (): IdentityDecisions => ({ schemaVersion: 1, rejectedMerges: [], classifications: [] });

export interface IdentityFiles {
  /** The tracked mailmap at the repository root. */
  mailmap: string;
  localMailmap: string;
  committedDecisions: string;
  localDecisions: string;
  localDir: string;
}

export function identityFiles(root: string): IdentityFiles {
  const localDir = join(root, ".code-health", "local");
  return {
    mailmap: join(root, ".mailmap"),
    localMailmap: join(localDir, "mailmap"),
    committedDecisions: join(root, ".code-health", "identity-decisions.json"),
    localDecisions: join(localDir, "identity-decisions.json"),
    localDir,
  };
}

/**
 * Where the team keeps its mapping. The configured location wins. Without one, files
 * already present say: local files (which are never tracked) mean a local choice, a
 * `.mailmap` or committed decisions mean a committed one. With neither, the
 * choice has not been made and the caller must ask.
 */
export function resolveLocation(root: string, configured: MappingLocation | null): MappingLocation | null {
  if (configured) return configured;
  const files = identityFiles(root);
  if (existsSync(files.localMailmap) || existsSync(files.localDecisions)) return "local";
  if (existsSync(files.mailmap) || existsSync(files.committedDecisions)) return "committed";
  return null;
}

/** Creates `.code-health/local/` with a `.gitignore` that excludes everything in it. */
export function ensureLocalState(root: string): void {
  const { localDir } = identityFiles(root);
  mkdirSync(localDir, { recursive: true });
  const ignore = join(localDir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
}

const KINDS = new Set(["bot", "service", "agent", "person"]);

function parse(text: string, file: string): IdentityDecisions {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw configError(`${file}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const fail = (what: string): never => {
    throw configError(`${file}: ${what}`);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("must be a JSON object");
  const document = value as Record<string, unknown>;
  const unknown = Object.keys(document).filter((k) => !["schemaVersion", "rejectedMerges", "classifications"].includes(k));
  if (unknown.length > 0) fail(`unknown key ${unknown.join(", ")}`);
  if (document.schemaVersion !== 1) fail("schemaVersion must be 1");
  const rejected = document.rejectedMerges ?? [];
  const classes = document.classifications ?? [];
  if (!Array.isArray(rejected) || !Array.isArray(classes)) return fail("rejectedMerges and classifications must be arrays");
  const rejectedMerges = rejected.map((r, i): RejectedMerge => {
    const entry = r as { identities?: unknown; reason?: unknown };
    const ids = entry?.identities;
    if (!Array.isArray(ids) || ids.length !== 2 || ids.some((x) => typeof x !== "string")) {
      return fail(`rejectedMerges[${i}].identities must be two "Name <email>" strings`);
    }
    return { identities: [ids[0], ids[1]] as [string, string], ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}) };
  });
  const classifications = classes.map((c, i): ClassificationDecision => {
    const entry = c as { identity?: unknown; kind?: unknown; reason?: unknown };
    if (typeof entry?.identity !== "string") return fail(`classifications[${i}].identity must be a "Name <email>" string`);
    if (typeof entry.kind !== "string" || !KINDS.has(entry.kind)) {
      return fail(`classifications[${i}].kind must be bot, service, agent or person`);
    }
    return {
      identity: entry.identity,
      kind: entry.kind as ClassificationDecision["kind"],
      ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
    };
  });
  return normaliseDecisions({ schemaVersion: 1, rejectedMerges, classifications });
}

const emailOf = (identity: string): string => {
  const open = identity.lastIndexOf("<");
  return (open === -1 ? identity : identity.slice(open + 1, identity.lastIndexOf(">"))).trim().toLowerCase();
};

const pairKey = (m: RejectedMerge): string => m.identities.map((i) => i.toLowerCase()).sort().join("\u0000");

const compare = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** Sorted and deduplicated, so the file is stable. A later classification of an address replaces an earlier one. */
export function normaliseDecisions(decisions: IdentityDecisions): IdentityDecisions {
  const rejected = new Map<string, RejectedMerge>();
  for (const m of decisions.rejectedMerges) {
    const ordered = [...m.identities].sort((p, q) => compare(p.toLowerCase(), q.toLowerCase())) as [string, string];
    rejected.set(pairKey(m), { ...m, identities: ordered });
  }
  const classes = new Map<string, ClassificationDecision>();
  for (const c of decisions.classifications) classes.set(emailOf(c.identity), c);
  return {
    schemaVersion: 1,
    rejectedMerges: [...rejected.entries()].sort(([p], [q]) => compare(p, q)).map(([, m]) => m),
    classifications: [...classes.entries()].sort(([p], [q]) => compare(p, q)).map(([, c]) => c),
  };
}

/** Adds decisions to existing ones. */
export function mergeDecisions(existing: IdentityDecisions, additions: Pick<IdentityDecisions, "rejectedMerges" | "classifications">): IdentityDecisions {
  return normaliseDecisions({
    schemaVersion: 1,
    rejectedMerges: [...existing.rejectedMerges, ...additions.rejectedMerges],
    classifications: [...existing.classifications, ...additions.classifications],
  });
}

function readFile(file: string): IdentityDecisions {
  return existsSync(file) ? parse(readFileSync(file, "utf8"), file) : emptyDecisions();
}

/** The decisions of the chosen location. Reading ignores the other file only when the location is explicit. */
export function readDecisions(root: string, location?: MappingLocation): IdentityDecisions {
  const files = identityFiles(root);
  if (location === "committed") return readFile(files.committedDecisions);
  if (location === "local") return readFile(files.localDecisions);
  return mergeDecisions(readFile(files.committedDecisions), readFile(files.localDecisions));
}

export function decisionsFile(root: string, location: MappingLocation): string {
  const files = identityFiles(root);
  return location === "local" ? files.localDecisions : files.committedDecisions;
}

export function writeDecisions(root: string, location: MappingLocation, decisions: IdentityDecisions): void {
  if (location === "local") ensureLocalState(root);
  const file = decisionsFile(root, location);
  mkdirSync(join(file, ".."), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, serialise(normaliseDecisions(decisions)));
  renameSync(temporary, file);
}
