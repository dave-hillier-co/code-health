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

test.each([
  ["Claude", "noreply@anthropic.com"],
  ["Claude Opus 5.5", "noreply@anthropic.com"],
  ["Copilot", "198982749+Copilot@users.noreply.github.com"],
  ["copilot-swe-agent[bot]", "198982749+copilot-swe-agent[bot]@users.noreply.github.com"],
  ["Cursor Agent", "cursoragent@cursor.com"],
  ["devin-ai-integration[bot]", "158243242+devin-ai-integration[bot]@users.noreply.github.com"],
])("%s <%s> is a coding agent by default", (name, email) => {
  expect(createNonPersonMatcher(none).classify(name, email)).toMatchObject({ kind: "agent", source: "builtin" });
});

test("a person with an address at anthropic.com is not an agent, as author or as co-author", () => {
  const matcher = createNonPersonMatcher(none);
  expect(matcher.classify("Ann Lee", "ann@anthropic.com")).toBeNull();
  expect(matcher.humanCoAuthor("Fix it\n\nCo-authored-by: Ann Lee <ann@anthropic.com>")).toEqual({ name: "Ann Lee", email: "ann@anthropic.com" });
});

test("a person named like an agent is not one, and a decision of person overrides the default", () => {
  expect(createNonPersonMatcher(none).classify("Devin Patel", "devin@corp.com")).toBeNull();
  const matcher = createNonPersonMatcher({ ...none, decisions: [{ identity: "Claude <noreply@anthropic.com>", kind: "person" }] });
  expect(matcher.classify("Claude", "noreply@anthropic.com")).toBeNull();
});

test("an agent's commits are still changes: only bots and services are dropped as non-person", () => {
  const matcher = createNonPersonMatcher(none);
  expect(matcher.isNonPerson("Claude", "noreply@anthropic.com")).toBe(false);
  expect(matcher.isNonPerson("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com")).toBe(true);
});

test("the human co-author of a message is the first Co-Authored-By trailer that is not an agent", () => {
  const matcher = createNonPersonMatcher(none);
  const message = "Fix it\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nCo-authored-by: Ann Lee <ann@corp.com>\nCo-authored-by: Bo Chen <bo@corp.com>";
  expect(matcher.humanCoAuthor(message)).toEqual({ name: "Ann Lee", email: "ann@corp.com" });
  expect(matcher.humanCoAuthor("Fix it\n\nCo-Authored-By: Claude <noreply@anthropic.com>")).toBeNull();
  expect(matcher.humanCoAuthor("Fix it")).toBeNull();
});
