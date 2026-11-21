import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { usageError } from "@code-health/cli-kit/errors";
import type { ClassificationDecision } from "@code-health/history/identity-classify";
import {
  decisionsFile,
  ensureLocalState,
  identityFiles,
  mergeDecisions,
  readDecisions,
  resolveLocation,
  writeDecisions,
  type IdentityDecisions,
  type MappingLocation,
  type RejectedMerge,
} from "@code-health/history/identity-decisions";
import { addMailmapMappings, type MailmapMapping } from "@code-health/history/identity-mailmap";
import { identityKey, type Address } from "@code-health/history/identity-names";
import type { IdentityAnalysis } from "./analysis.ts";
import { emailOf } from "./views.ts";

/** What the agent prepares and the user approves. */
export interface DecisionsInput {
  /** Each alias is shown as the canonical identity. Aliases and canonical identities are identities as written in commits. */
  merges: { canonical: Address; aliases: Address[] }[];
  rejectedMerges: RejectedMerge[];
  classifications: ClassificationDecision[];
}

const KEYS = ["merges", "rejectedMerges", "classifications"];

function address(value: unknown, where: string): Address {
  const entry = value as { name?: unknown; email?: unknown };
  if (typeof entry?.name !== "string" || typeof entry.email !== "string" || entry.name === "" || entry.email === "") {
    throw usageError(`${where} must be {"name": ..., "email": ...}`);
  }
  return { name: entry.name, email: entry.email };
}

/** Reads and validates the decisions JSON. Anything unexpected is a usage error naming where. */
export function readDecisionsInput(path: string, root: string): { input: DecisionsInput; hash: string } {
  const file = isAbsolute(path) ? path : resolve(root, path);
  if (!existsSync(file)) throw usageError(`--from: ${path} does not exist`);
  const text = readFileSync(file, "utf8");
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw usageError(`--from: ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw usageError(`--from: ${path} must be a JSON object`);
  const document = value as Record<string, unknown>;
  const unknown = Object.keys(document).filter((k) => !KEYS.includes(k));
  if (unknown.length > 0) throw usageError(`--from: unknown key ${unknown.join(", ")}; expected ${KEYS.join(", ")}`);
  const list = (key: string): unknown[] => {
    const entry = document[key] ?? [];
    if (!Array.isArray(entry)) throw usageError(`--from: ${key} must be an array`);
    return entry;
  };
  const merges = list("merges").map((m, i) => {
    const entry = m as { canonical?: unknown; aliases?: unknown };
    if (!Array.isArray(entry?.aliases) || entry.aliases.length === 0) throw usageError(`--from: merges[${i}].aliases must be a non-empty array`);
    return {
      canonical: address(entry.canonical, `merges[${i}].canonical`),
      aliases: entry.aliases.map((a, j) => address(a, `merges[${i}].aliases[${j}]`)),
    };
  });
  const rejectedMerges = list("rejectedMerges").map((r, i): RejectedMerge => {
    const entry = r as { identities?: unknown; reason?: unknown };
    const ids = entry?.identities;
    if (!Array.isArray(ids) || ids.length !== 2 || ids.some((x) => typeof x !== "string")) {
      throw usageError(`--from: rejectedMerges[${i}].identities must be two "Name <email>" strings`);
    }
    return { identities: [ids[0], ids[1]] as [string, string], ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}) };
  });
  const classifications = list("classifications").map((c, i): ClassificationDecision => {
    const entry = c as { identity?: unknown; kind?: unknown; reason?: unknown };
    if (typeof entry?.identity !== "string") throw usageError(`--from: classifications[${i}].identity must be a "Name <email>" string`);
    if (entry.kind !== "bot" && entry.kind !== "service" && entry.kind !== "agent" && entry.kind !== "person") {
      throw usageError(`--from: classifications[${i}].kind must be bot, service, agent or person`);
    }
    return { identity: entry.identity, kind: entry.kind, ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}) };
  });
  return { input: { merges, rejectedMerges, classifications }, hash };
}

export interface ApplyChange {
  /** The file the change is for, relative to the repository. */
  target: string;
  change: "add" | "present";
  entry: string;
}

export interface ApplyPlan {
  location: MappingLocation;
  mailmapPath: string;
  mailmapText: string;
  decisionsPath: string;
  decisions: IdentityDecisions;
  changes: ApplyChange[];
  /** True when running with `--apply` would change a file. */
  dirty: boolean;
}

/** Where the mapping goes: `--location`, else the configuration, else the files already there. Undecided is a usage error that tells the agent to ask. */
export function chooseLocation(root: string, flag: string | boolean | undefined | (string | boolean)[], configured: MappingLocation | null): MappingLocation {
  if (flag !== undefined) {
    if (flag !== "committed" && flag !== "local") throw usageError('--location must be "committed" or "local"');
    return flag;
  }
  const location = resolveLocation(root, configured);
  if (location === null) {
    throw usageError(
      "no mapping location has been chosen: ask the user whether to commit .mailmap and the decisions file (committed) or keep them under .code-health/local (local), then pass --location committed|local",
    );
  }
  return location;
}

const rejectedPair = (a: string, b: string): string => [a, b].map((x) => x.toLowerCase()).sort().join("\u0000");

/**
 * Works out what applying a decisions file would write, without writing. The
 * mailmap keeps every existing line, and decisions only gain entries.
 */
export function planApply(root: string, location: MappingLocation, input: DecisionsInput, analysis: IdentityAnalysis): ApplyPlan {
  const known = new Set(analysis.raws.map((r) => identityKey(r).toLowerCase()));
  const missing = [
    ...input.merges.flatMap((m) => [m.canonical, ...m.aliases]).map(identityKey),
    ...input.rejectedMerges.flatMap((r) => r.identities),
  ].filter((k) => !known.has(k.toLowerCase()));
  if (missing.length > 0) {
    throw usageError(`not an identity in this history: ${[...new Set(missing)].sort().join("; ")}; names and emails must be exactly as \`identities list\` shows them`);
  }

  const files = identityFiles(root);
  const existing = readDecisions(root, location);
  const rejected = new Set([...existing.rejectedMerges, ...input.rejectedMerges].map((r) => rejectedPair(...r.identities)));
  const mappings: MailmapMapping[] = [];
  for (const merge of input.merges) {
    for (const alias of merge.aliases) {
      if (identityKey(alias).toLowerCase() === identityKey(merge.canonical).toLowerCase()) continue;
      if (rejected.has(rejectedPair(identityKey(alias), identityKey(merge.canonical)))) {
        throw usageError(`${identityKey(alias)} and ${identityKey(merge.canonical)} are recorded as different people; remove the rejection by editing the decisions file first`);
      }
      mappings.push({ canonical: merge.canonical, alias });
    }
  }

  const mailmapPath = location === "local" ? files.localMailmap : files.mailmap;
  const before = existsSync(mailmapPath) ? readFileSync(mailmapPath, "utf8") : "";
  const update = addMailmapMappings(before, mappings);

  const decisions = mergeDecisions(existing, input);
  const decisionsPath = decisionsFile(root, location);
  const changes: ApplyChange[] = [
    ...update.added.map((entry): ApplyChange => ({ target: relative(root, mailmapPath), change: "add", entry })),
    ...update.present.map((entry): ApplyChange => ({ target: relative(root, mailmapPath), change: "present", entry })),
  ];
  const target = relative(root, decisionsPath);
  const hadRejection = new Set(existing.rejectedMerges.map((r) => rejectedPair(...r.identities)));
  const seen = new Set<string>();
  for (const r of input.rejectedMerges) {
    const pair = rejectedPair(...r.identities);
    if (seen.has(pair)) continue;
    seen.add(pair);
    changes.push({ target, change: hadRejection.has(pair) ? "present" : "add", entry: `different people: ${r.identities.join(" | ")}${r.reason ? ` (${r.reason})` : ""}` });
  }
  const hadClass = new Map(existing.classifications.map((c) => [emailOf(c.identity), c.kind]));
  for (const c of input.classifications) {
    changes.push({ target, change: hadClass.get(emailOf(c.identity)) === c.kind ? "present" : "add", entry: `${c.kind}: ${c.identity}${c.reason ? ` (${c.reason})` : ""}` });
  }
  return {
    location,
    mailmapPath,
    mailmapText: update.text,
    decisionsPath,
    decisions,
    changes,
    dirty: changes.some((c) => c.change === "add"),
  };
}

/** Writes the plan. The mailmap goes in by rename, so a reader never sees half a file. */
export function writePlan(root: string, plan: ApplyPlan): void {
  if (!plan.dirty) return;
  if (plan.location === "local") ensureLocalState(root);
  if (plan.changes.some((c) => c.target === relative(root, plan.mailmapPath) && c.change === "add")) {
    mkdirSync(dirname(plan.mailmapPath), { recursive: true });
    const temporary = `${plan.mailmapPath}.${process.pid}.tmp`;
    writeFileSync(temporary, plan.mailmapText);
    renameSync(temporary, plan.mailmapPath);
  }
  if (plan.changes.some((c) => c.target === relative(root, plan.decisionsPath) && c.change === "add")) {
    writeDecisions(root, plan.location, plan.decisions);
  }
}
