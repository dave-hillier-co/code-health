import { usageError } from "@code-health/cli-kit/errors";
import { identityKey, type Address } from "./identity-names.ts";

/** One mapping: commits made as `alias` are shown as `canonical`. */
export interface MailmapMapping {
  canonical: Address;
  alias: Address;
}

interface ParsedEntry {
  properName: string | undefined;
  properEmail: string | undefined;
  commitName: string | undefined;
  commitEmail: string;
}

const ENTRY = /^\s*(?:([^<#]*?)\s*)?<([^>]*)>(?:\s*(?:([^<#]*?)\s*)?<([^>]*)>)?\s*(?:#.*)?$/;

function parseLine(line: string): ParsedEntry | undefined {
  if (line.trim() === "" || line.trimStart().startsWith("#")) return undefined;
  const match = ENTRY.exec(line);
  if (!match) return undefined;
  const [, first, firstEmail, second, secondEmail] = match;
  if (secondEmail === undefined) {
    // `Proper Name <commit@email>`
    return { properName: first || undefined, properEmail: undefined, commitName: undefined, commitEmail: firstEmail! };
  }
  return {
    properName: first || undefined,
    properEmail: firstEmail!,
    commitName: second || undefined,
    commitEmail: secondEmail,
  };
}

/** The line that writes a mapping in full, so it matches on both name and email. */
export function formatMapping(mapping: MailmapMapping): string {
  return `${identityKey(mapping.canonical)} ${identityKey(mapping.alias)}`;
}

export interface MailmapUpdate {
  text: string;
  /** Lines appended, in the order written. */
  added: string[];
  /** Mappings that were already in the file. */
  present: string[];
}

const same = (x: string | undefined, y: string) => x !== undefined && x.toLowerCase() === y.toLowerCase();

/**
 * Appends mappings to a `.mailmap`, keeping every existing line, comment and
 * blank line exactly as it was. New lines are sorted and added at the end. A
 * mapping already in the file is left alone, and one whose alias is already
 * mapped to someone else is a usage error: nothing is ever replaced or removed.
 */
export function addMailmapMappings(existing: string, mappings: readonly MailmapMapping[]): MailmapUpdate {
  const parsed = existing
    .split("\n")
    .map(parseLine)
    .filter((e): e is ParsedEntry => e !== undefined);

  const added: string[] = [];
  const present: string[] = [];
  for (const mapping of [...mappings].sort((p, q) => compare(formatMapping(p), formatMapping(q)))) {
    const line = formatMapping(mapping);
    const current = parsed.find(
      (e) => same(e.commitEmail, mapping.alias.email) && (e.commitName === undefined || same(e.commitName, mapping.alias.name)),
    );
    if (current) {
      const name = current.properName ?? mapping.alias.name;
      const email = current.properEmail ?? mapping.alias.email;
      if (same(name, mapping.canonical.name) && same(email, mapping.canonical.email)) {
        present.push(line);
        continue;
      }
      throw usageError(
        `${identityKey(mapping.alias)} is already mapped to ${identityKey({ name, email })} in the mailmap; edit the file to change it`,
      );
    }
    if (added.includes(line)) continue;
    if (mapping.canonical.email.toLowerCase() === mapping.alias.email.toLowerCase() && mapping.canonical.name === mapping.alias.name) continue;
    added.push(line);
    parsed.push({
      properName: mapping.canonical.name,
      properEmail: mapping.canonical.email,
      commitName: mapping.alias.name,
      commitEmail: mapping.alias.email,
    });
  }
  if (added.length === 0) return { text: existing, added, present };
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  return { text: `${existing}${separator}${added.join("\n")}\n`, added, present };
}

const compare = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
