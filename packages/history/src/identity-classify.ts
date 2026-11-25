import { normaliseName, type Address } from "./identity-names.ts";
import { InvalidPatternError } from "./noise.ts";

export type NonPersonKind = "bot" | "service" | "agent";

/** A reviewed classification from the decisions file. `person` overrides a heuristic that misfired. */
export interface ClassificationDecision {
  /** `Name <email>`. Matched by the address only. */
  identity: string;
  kind: NonPersonKind | "person";
  reason?: string;
}

export interface NonPersonRules {
  /** Regular expressions matched, case-insensitively, against `Name <email>`. */
  botPatterns: readonly string[];
  servicePatterns: readonly string[];
  agentPatterns: readonly string[];
  decisions: readonly ClassificationDecision[];
}

export interface Classification {
  kind: NonPersonKind;
  source: "builtin" | "config" | "decision";
  /** The pattern, name or decision address that matched. */
  pattern: string;
  /** What the pattern was matched against: the decisions file, the whole `Name <email>`, the name alone or the email's local part. */
  signal: "decision" | "identity" | "name" | "local-part";
}

/** Bot accounts known by name or address. */
export const BUILTIN_BOT_PATTERNS: readonly string[] = [
  "\\[bot\\]",
  "^dependabot",
  "^renovate",
  "^github-actions",
  "^greenkeeper",
  "^snyk-bot",
  "^mergify",
  "^imgbot",
  "^allcontributors",
  "^pre-commit-ci",
  "<bot@renovateapp\\.com>",
];

/**
 * `bot` or `robot` as a word of the name or of the email's local part: between separators or at an end, or
 * capitalised after a lower-case letter (`ReleaseBot`). Matches `Acme Bot`, `robot-sync@` and `ci_bot`, and
 * not `Abbott`, `Talbot` or `robotics`.
 */
const BOT_WORD = /(?<![\p{L}\p{N}])(?:ro)?bot(?![\p{L}\p{N}])/iu;
const CAPITALISED_BOT_WORD = /(?<=\p{Ll})(?:Robot|Bot)(?!\p{Ll})/u;
const BOT_WORD_IN_NAME = "bot or robot as a word in the name";
const BOT_WORD_IN_LOCAL_PART = "bot or robot as a word in the email's local part";

/** Generic account names, matched against the whole normalised name. */
export const BUILTIN_SERVICE_NAMES: readonly string[] = [
  "build",
  "builds",
  "buildbot",
  "jenkins",
  "release",
  "releases",
  "ci",
  "deploy",
  "deployer",
  "automation",
  "teamcity",
  "travis",
  "circleci",
  "gitlab ci",
  "azure pipelines",
  "service account",
];

/**
 * Coding agents known by the identity they commit as, matched against `Name <email>`: the Claude noreply address,
 * GitHub Copilot, Cursor and Devin addresses. A commit authored as one of them is the agent's, whatever
 * the name says. These are narrower than the trailer patterns below, which would also match a person
 * named Devin.
 */
export const BUILTIN_AGENT_IDENTITY_PATTERNS: readonly string[] = [
  "<noreply@anthropic\\.com>",
  "^copilot(-swe-agent)?(\\[bot\\])?\\s*<",
  "<copilot@github\\.com>",
  "\\+copilot(-swe-agent)?(\\[bot\\])?@users\\.noreply\\.github\\.com>",
  "<cursoragent@cursor\\.com>",
  "devin-ai-integration",
  "^devin ai\\b",
];

/** AI agents named in a `Co-Authored-By` trailer. */
export const BUILTIN_AGENT_PATTERNS: readonly string[] = [
  "\\bclaude\\b",
  "noreply@anthropic\\.com",
  "copilot",
  "\\bchatgpt\\b",
  "\\bopenai\\b",
  "\\bcodex\\b",
  "\\bgemini\\b",
  "\\bcursor\\b",
  "\\baider\\b",
  "\\bdevin\\b",
];

export function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (error) {
    throw new InvalidPatternError(pattern, error instanceof Error ? error.message : String(error));
  }
}

/** What a matcher applies, so a report can list the effective rules next to how many commits they dropped. */
export interface NonPersonRulesApplied {
  builtinBotPatterns: string[];
  builtinServiceNames: string[];
  servicePatterns: string[];
  /** Reviewed decisions: identities recorded as a bot, service, agent or person. */
  decisions: number;
}

export interface NonPersonMatcher {
  classify(name: string, email: string): Classification | null;
  /**
   * True for a bot or a service, whose commits are dropped as noise. An agent is not here: its commits are
   * real changes, and only its lines belong to nobody (`classify` returns `agent`).
   */
  isNonPerson(name: string, email: string): boolean;
  /**
   * The first `Co-Authored-By` trailer of a message that names a person (not a coding agent), or null.
   * A commit authored by an agent is attributed to this person.
   */
  humanCoAuthor(message: string): Address | null;
  applied: NonPersonRulesApplied;
}

const wordBot = (text: string): boolean => BOT_WORD.test(text) || CAPITALISED_BOT_WORD.test(text);

const localPartOf = (email: string): string => {
  const at = email.lastIndexOf("@");
  return at === -1 ? email : email.slice(0, at);
};

const addressOf = (identity: string): string => {
  const open = identity.lastIndexOf("<");
  return (open === -1 ? identity : identity.slice(open + 1, identity.lastIndexOf(">"))).trim().toLowerCase();
};

/**
 * Classifies identities as bots, services or agents. A reviewed decision
 * comes first (and `person` removes a classification), then configured
 * patterns, then the built-in ones.
 */
export function createNonPersonMatcher(rules: NonPersonRules): NonPersonMatcher {
  const decisions = new Map(rules.decisions.map((d) => [addressOf(d.identity), d]));
  const config = [
    ...rules.botPatterns.map((p) => ({ kind: "bot" as const, pattern: p, re: compilePattern(p) })),
    ...rules.servicePatterns.map((p) => ({ kind: "service" as const, pattern: p, re: compilePattern(p) })),
  ];
  const builtinAgents = BUILTIN_AGENT_IDENTITY_PATTERNS.map((p) => ({ kind: "agent" as const, pattern: p, re: compilePattern(p) }));
  const builtin = BUILTIN_BOT_PATTERNS.map((p) => ({ kind: "bot" as const, pattern: p, re: compilePattern(p) }));
  const serviceNames = new Set(BUILTIN_SERVICE_NAMES);
  const trailerAgents = [...BUILTIN_AGENT_PATTERNS, ...rules.agentPatterns].map((p) => ({ re: compilePattern(p) }));

  const classify = (name: string, email: string): Classification | null => {
    const decision = decisions.get(email.trim().toLowerCase());
    if (decision) {
      return decision.kind === "person" ? null : { kind: decision.kind, source: "decision", pattern: decision.identity, signal: "decision" };
    }
    const text = `${name} <${email}>`;
    const fromConfig = config.find((c) => c.re.test(text));
    if (fromConfig) return { kind: fromConfig.kind, source: "config", pattern: fromConfig.pattern, signal: "identity" };
    const agent = builtinAgents.find((c) => c.re.test(text));
    if (agent) return { kind: "agent", source: "builtin", pattern: agent.pattern, signal: "identity" };
    const bot = builtin.find((c) => c.re.test(text));
    if (bot) return { kind: "bot", source: "builtin", pattern: bot.pattern, signal: "identity" };
    if (wordBot(name)) return { kind: "bot", source: "builtin", pattern: BOT_WORD_IN_NAME, signal: "name" };
    if (wordBot(localPartOf(email))) return { kind: "bot", source: "builtin", pattern: BOT_WORD_IN_LOCAL_PART, signal: "local-part" };
    const normalised = normaliseName(name);
    if (serviceNames.has(normalised)) return { kind: "service", source: "builtin", pattern: normalised, signal: "name" };
    return null;
  };
  return {
    classify,
    isNonPerson: (name, email) => {
      const found = classify(name, email);
      return found !== null && found.kind !== "agent";
    },
    humanCoAuthor: (message) => {
      for (const line of message.replace(/\r\n/g, "\n").split("\n")) {
        const match = /^co-authored-by[ \t]*:[ \t]*(.+?)[ \t]*<([^<>]*)>[ \t]*$/i.exec(line);
        if (!match) continue;
        const address = { name: match[1]!.trim(), email: match[2]!.trim() };
        if (address.name === "" || address.email === "") continue;
        if (classify(address.name, address.email) !== null) continue;
        if (trailerAgents.some((p) => p.re.test(line.replace(/^[^:]*:\s*/, "")))) continue;
        return address;
      }
      return null;
    },
    applied: {
      builtinBotPatterns: [...BUILTIN_BOT_PATTERNS],
      builtinServiceNames: [...BUILTIN_SERVICE_NAMES],
      servicePatterns: [...rules.servicePatterns],
      decisions: rules.decisions.length,
    },
  };
}

export interface AgentTrailer {
  /** The trailer value, as written. */
  value: string;
  pattern: string;
}

/** `Co-Authored-By` trailers whose value matches an agent pattern. Human co-authors are not returned. */
export function findAgentTrailers(message: string, extraPatterns: readonly string[]): AgentTrailer[] {
  const patterns = [...BUILTIN_AGENT_PATTERNS, ...extraPatterns].map((p) => ({ pattern: p, re: compilePattern(p) }));
  const found: AgentTrailer[] = [];
  for (const line of message.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^co-authored-by[ \t]*:[ \t]*(.+?)[ \t]*$/i.exec(line);
    if (!match) continue;
    const value = match[1]!;
    const hit = patterns.find((p) => p.re.test(value));
    if (hit) found.push({ value, pattern: hit.pattern });
  }
  return found;
}

const BUMP = /^(bump\b|release\b|version\b|chore\(release\)|chore: release|merge\b|v?\d+\.\d+\.\d+)/i;

/** True when there is at least one subject and every subject is a version bump, release or merge. */
export function onlyVersionBumpsOrMerges(subjects: readonly string[]): boolean {
  return subjects.length > 0 && subjects.every((s) => BUMP.test(s.trim()));
}
