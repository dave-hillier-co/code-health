import { describe, expect, test } from "vitest";
import { historyDefaults } from "@code-health/cli-kit/config";
import { checkFixConvention, compileFixClassifier, defaultFixSettings, findFix, fixEvidence } from "../src/fix-commits.ts";
import { InvalidPatternError } from "../src/noise.ts";

const classifier = compileFixClassifier(defaultFixSettings);

describe("the default fix patterns", () => {
  test("match whole words in the subject", () => {
    for (const subject of ["Fix the parser", "fixes crash", "Fixed it", "fixing flaky test", "bug in login", "bugs everywhere", "bugfix: login", "hotfix 1.2", "defect in parser", "issue with caching"]) {
      expect(classifier.classify(subject).kind, subject).toBe("fix");
    }
  });

  test("do not match inside longer words", () => {
    for (const subject of ["Add a prefix option", "debug logging", "Add a suffix", "reissue token", "Refactor the parser"]) {
      expect(classifier.classify(subject).kind, subject).toBe("other");
    }
  });

  test("match a Conventional Commits fix prefix, with or without a scope", () => {
    expect(classifier.classify("fix: stop crashing")).toMatchObject({ kind: "fix", pattern: historyDefaults.fixPatterns[0] });
    expect(classifier.classify("fix(parser)!: stop crashing")).toMatchObject({ kind: "fix", pattern: historyDefaults.fixPatterns[0] });
  });

  test("match a merge of a fix branch and name that pattern", () => {
    expect(classifier.classify("Merge branch 'hotfix/login'")).toMatchObject({ kind: "fix", pattern: "^merge .*\\b(fix|hotfix|bugfix)[/-]" });
  });

  test("return the pattern that matched", () => {
    expect(classifier.classify("Fix the parser")).toEqual({ kind: "fix", pattern: "\\bfix\\b", matchedIn: "subject" });
  });

  test("also match subjects that are not defects, which is why every count keeps the matching commits", () => {
    expect(classifier.classify("address review issue")).toMatchObject({ kind: "fix", pattern: "\\bissue\\b" });
  });
});

describe("bodies", () => {
  const message = "Add retries\n\nFixes #123";

  test("are not matched by default, because a Fixes trailer closes any kind of issue", () => {
    expect(classifier.classify(message).kind).toBe("other");
  });

  test("are matched with fixMatchBody, and the match says it was in the body", () => {
    const withBody = compileFixClassifier({ ...defaultFixSettings, fixMatchBody: true });
    expect(withBody.classify(message)).toEqual({ kind: "fix", pattern: "\\bfixes\\b", matchedIn: "body" });
  });
});

describe("reverts", () => {
  test("are a subject starting with Revert, and are not fixes even when the subject names a fix", () => {
    expect(classifier.classify('Revert "Fix the parser"')).toEqual({ kind: "revert", pattern: "^revert\\b", matchedIn: "subject" });
  });

  test("are the body line git writes", () => {
    const message = "Undo the cache\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.";
    expect(classifier.classify(message)).toEqual({ kind: "revert", pattern: "This reverts commit", matchedIn: "body" });
  });

  test("findFix skips a revert and returns null for a change of only reverts", () => {
    expect(findFix(classifier, "abc", ['Revert "Fix the parser"'])).toBeNull();
    expect(findFix(classifier, "abc", ['Revert "Fix the parser"', "Fix the lexer"])).toEqual({ id: "abc", subject: "Fix the lexer", pattern: "\\bfix\\b", matchedIn: "subject" });
  });
});

test("a pattern that is not a regular expression is named in the error", () => {
  expect(() => compileFixClassifier({ ...defaultFixSettings, fixPatterns: ["("] })).toThrow(InvalidPatternError);
});

describe("fixEvidence", () => {
  const matches = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, subject: "Fix it", pattern: i < 20 ? "\\bfix\\b" : "\\bbug\\b", matchedIn: "subject" as const }));

  test("counts by pattern, lists the first matches and says how many it omits", () => {
    const evidence = fixEvidence(matches, 10);
    expect(evidence.fixes).toBe(25);
    expect(evidence.byPattern).toEqual([{ pattern: "\\bfix\\b", count: 20 }, { pattern: "\\bbug\\b", count: 5 }]);
    expect(evidence.commits).toHaveLength(10);
    expect(evidence.omitted).toBe(15);
  });
});

describe("checkFixConvention", () => {
  test("accepts a share from 2 to 60 percent over at least 30 logical changes", () => {
    expect(checkFixConvention(100, 20)).toMatchObject({ share: 0.2, followsConvention: true, note: null });
    expect(checkFixConvention(30, 1).followsConvention).toBe(true);
    expect(checkFixConvention(100, 60).followsConvention).toBe(true);
  });

  test("says the messages probably do not follow a convention under 2 percent, over 60 percent and under 30 changes", () => {
    expect(checkFixConvention(100, 1).note).toMatch(/under 2%/);
    expect(checkFixConvention(100, 61).note).toMatch(/over 60%/);
    expect(checkFixConvention(29, 10).note).toMatch(/fewer than 30/);
    expect(checkFixConvention(0, 0)).toMatchObject({ share: null, followsConvention: false });
    expect(checkFixConvention(100, 1).note).toMatch(/probably do not follow a convention/);
  });

  test("states its provenance", () => {
    expect(checkFixConvention(100, 20).guidelines.provenance).toMatch(/Judgement calls/);
  });
});
