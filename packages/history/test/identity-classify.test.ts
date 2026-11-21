import { expect, test } from "vitest";
import { createNonPersonMatcher, findAgentTrailers, onlyVersionBumpsOrMerges } from "../src/identity-classify.ts";
import { InvalidPatternError } from "../src/noise.ts";

const none = { botPatterns: [], servicePatterns: [], agentPatterns: [], decisions: [] };

test("known bots are recognised by name suffix and by address", () => {
  const matcher = createNonPersonMatcher(none);
  expect(matcher.classify("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com")).toMatchObject({ kind: "bot", source: "builtin" });
  expect(matcher.classify("renovate", "bot@renovateapp.com")).toMatchObject({ kind: "bot" });
  expect(matcher.classify("GitHub Actions", "actions@github.com")).toBeNull();
  expect(matcher.classify("github-actions", "41898282+github-actions[bot]@users.noreply.github.com")).toMatchObject({ kind: "bot" });
  expect(matcher.classify("Ann Lee", "ann@corp.com")).toBeNull();
});

test("generic service names are recognised, whole names only", () => {
  const matcher = createNonPersonMatcher(none);
  expect(matcher.classify("Jenkins", "jenkins@corp.com")).toMatchObject({ kind: "service", source: "builtin" });
  expect(matcher.classify("release", "r@corp.com")).toMatchObject({ kind: "service" });
  expect(matcher.classify("Builder Bob", "bob@corp.com")).toBeNull();
});

test("configured patterns apply to the name and address, and say where they came from", () => {
  const matcher = createNonPersonMatcher({ ...none, botPatterns: ["<ops-.*@corp\\.com"], servicePatterns: ["Deploy Team"] });
  expect(matcher.classify("Ops", "ops-sync@corp.com")).toMatchObject({ kind: "bot", source: "config", pattern: "<ops-.*@corp\\.com" });
  expect(matcher.classify("Deploy Team", "t@corp.com")).toMatchObject({ kind: "service", source: "config" });
});

test("a recorded decision classifies by address and overrides the heuristics", () => {
  const matcher = createNonPersonMatcher({
    ...none,
    decisions: [
      { identity: "Sync Robot <SYNC@corp.com>", kind: "bot" },
      { identity: "Release <release@corp.com>", kind: "person", reason: "a human named Release" },
    ],
  });
  expect(matcher.classify("anything", "sync@corp.com")).toMatchObject({ kind: "bot", source: "decision" });
  expect(matcher.classify("Release", "release@corp.com")).toBeNull();
  expect(matcher.isNonPerson("Release", "release@corp.com")).toBe(false);
  expect(matcher.isNonPerson("Sync Robot", "sync@corp.com")).toBe(true);
});

test("an invalid configured pattern is reported with the pattern", () => {
  expect(() => createNonPersonMatcher({ ...none, botPatterns: ["("] })).toThrow(InvalidPatternError);
});

test("Co-Authored-By trailers naming an agent are found, human co-authors are not", () => {
  const message = [
    "Add a thing",
    "",
    "Body.",
    "",
    "Co-authored-by: Claude Opus 5.5 <noreply@anthropic.com>",
    "Co-Authored-By: Ann Lee <ann@corp.com>",
    "Co-Authored-By: Copilot <copilot@github.com>",
  ].join("\n");
  expect(findAgentTrailers(message, [])).toEqual([
    { value: "Claude Opus 5.5 <noreply@anthropic.com>", pattern: "\\bclaude\\b" },
    { value: "Copilot <copilot@github.com>", pattern: "copilot" },
  ]);
  expect(findAgentTrailers(message, ["ann"])).toHaveLength(3);
  expect(findAgentTrailers("Plain\n\nNo trailers", [])).toEqual([]);
});

test("an identity whose commits are only version bumps or merges is a service candidate", () => {
  expect(onlyVersionBumpsOrMerges(["Bump version to 1.2.3", "chore(release): 1.2.4", "Merge branch 'x'"])).toBe(true);
  expect(onlyVersionBumpsOrMerges(["Bump version to 1.2.3", "Fix the parser"])).toBe(false);
  expect(onlyVersionBumpsOrMerges([])).toBe(false);
});
