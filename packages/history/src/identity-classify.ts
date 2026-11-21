import { normaliseName } from "./identity-names.ts";
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

/** AI agents named in a `Co-Authored-By` trailer. */
export const BUILTIN_AGENT_PATTERNS: readonly string[] = [
  "\\bclaude\\b",
  "@anthropic\\.com",
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

export interface NonPersonMatcher {
  classify(name: string, email: string): Classification | null;
  isNonPerson(name: string, email: string): boolean;
}

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
  const builtin = BUILTIN_BOT_PATTERNS.map((p) => ({ kind: "bot" as const, pattern: p, re: compilePattern(p) }));
  const serviceNames = new Set(BUILTIN_SERVICE_NAMES);

  const classify = (name: string, email: string): Classification | null => {
    const decision = decisions.get(email.trim().toLowerCase());
    if (decision) {
      return decision.kind === "person" ? null : { kind: decision.kind, source: "decision", pattern: decision.identity };
    }
    const text = `${name} <${email}>`;
    const fromConfig = config.find((c) => c.re.test(text));
    if (fromConfig) return { kind: fromConfig.kind, source: "config", pattern: fromConfig.pattern };
    const bot = builtin.find((c) => c.re.test(text));
    if (bot) return { kind: "bot", source: "builtin", pattern: bot.pattern };
    const normalised = normaliseName(name);
    if (serviceNames.has(normalised)) return { kind: "service", source: "builtin", pattern: normalised };
    return null;
  };
  return { classify, isNonPerson: (name, email) => classify(name, email) !== null };
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
