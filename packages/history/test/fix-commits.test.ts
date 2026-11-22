import { describe, expect, test } from "vitest";
import { historyDefaults } from "@code-health/cli-kit/config";
import { checkFixConvention, compileFixClassifier, defaultFixSettings, findExcludedFix, findFix, fixEvidence } from "../src/fix-commits.ts";
import { InvalidPatternError } from "../src/noise.ts";

const classifier = compileFixClassifier(defaultFixSettings);

describe("the default fix patterns", () => {
  test("match fix words at the start of the subject, after to, and bug words anywhere", () => {
    for (const subject of [
      "Fix the parser",
      "fixes crash",
      "Fixed it",
      "fixing the cache",
      "feat: fix the cache key",
      "fix(parser): stop crashing",
      "ABC-123: fix the crash",
      "Change the retry loop to fix the crash",
      "bug in login",
      "bugs everywhere",
      "bugfix: login",
      "hotfix 1.2",
      "Handle the defect in parser",
      "Resolve bug 12 in the cache",
    ]) {
      expect(classifier.classify(subject).kind, subject).toBe("fix");
    }
  });

  test("do not match fix words in the middle of the subject, the word issue, or longer words", () => {
    for (const subject of [
      "Add fixed clock",
      "Add a fixed frame budget",
      "Describe fix commits in the spec",
      "Parse the issue key",
      "address review issue",
      "Add a prefix option",
      "debug logging",
      "Add a suffix",
      "reissue token",
      "Refactor the parser",
    ]) {
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
    expect(classifier.classify("Fix the parser")).toEqual({ kind: "fix", pattern: historyDefaults.fixPatterns[2], matchedIn: "subject" });
    expect(classifier.classify("Change the loop to fix the crash")).toEqual({ kind: "fix", pattern: "\\bto\\s+fix\\b", matchedIn: "subject" });
  });
});

describe("Conventional Commits types", () => {
  const typeRule = historyDefaults.fixExcludePatterns[0];

  test("decide: fix and fix(scope) are fixes, including a fix of tests or CI", () => {
    for (const subject of ["fix: stop crashing", "fix(parser): stop crashing", "fix!: drop the old key", "fix: flaky TestExecuteRepair", "fix(ci): run the benchmarks", "Fix #123 on main: stop the crash"]) {
      expect(classifier.classify(subject).kind, subject).toBe("fix");
    }
  });

  test("decide: chore, ci, test, docs, style, build, refactor and perf are not fixes even when fix appears later, and name the type rule", () => {
    for (const subject of [
      "chore: fix testifylint issues",
      "ci: fix when benchmarks run",
      "test: fix flaky TestExecuteRepair",
      "chore: fix docker-composes",
      "docs(readme): fix the bug report link",
      "style: fix the layout",
      "build: fix the bug in the release script",
      "refactor(parser): fix naming to fix the crash",
      "perf: fix a defect in the cache",
    ]) {
      expect(classifier.classify(subject), subject).toEqual({ kind: "excluded", pattern: typeRule, fixPattern: expect.any(String), matchedIn: "subject" });
    }
  });

  test("leave a typed commit that no fix pattern matched as other", () => {
    expect(classifier.classify("chore: bump the version").kind).toBe("other");
    expect(classifier.classify("test: add a case for the lexer").kind).toBe("other");
  });

  test("count a revert type as a revert, before any fix rule", () => {
    expect(classifier.classify("revert: fix the parser").kind).toBe("revert");
    expect(classifier.classify("revert(parser): fix: stop crashing").kind).toBe("revert");
  });

  test("leave a type the list does not name to the rules for a subject without a type", () => {
    expect(classifier.classify("feat: fix the cache key").kind).toBe("fix");
  });
});

describe("subjects without a type prefix", () => {
  test("match Fix #NNN and Fixes #NNN anywhere in the subject", () => {
    for (const subject of ["Fix #123 on main: handle empty input", "Fixes #45", "Handle empty input, fixes #45", "Fix #7 on main: add GPU tests"]) {
      expect(classifier.classify(subject).kind, subject).toBe("fix");
    }
  });

  test("count a repair of tests or CI as a fix", () => {
    for (const subject of ["Fix three GPU test failures that turn CI red without a code change", "Fix flaky test", "Fix tests", "Fix ci", "Fixed the failing test"]) {
      expect(classifier.classify(subject).kind, subject).toBe("fix");
    }
  });
});

describe("the default fix exclude patterns", () => {
  test("count a fix whose target is typos, spelling, lint or formatting as excluded, with the excluding pattern", () => {
    for (const subject of ["Fix typo in README", "fix: lints", "Fix lint", "Fix spelling of the option", "Fix formatting", "fix: fix typos in the docs"]) {
      expect(classifier.classify(subject), subject).toEqual({
        kind: "excluded",
        pattern: historyDefaults.fixExcludePatterns[1],
        fixPattern: expect.any(String),
        matchedIn: "subject",
      });
    }
  });

  test("count a review-comment follow-up as excluded, with the excluding pattern", () => {
    for (const subject of ["fix: address comments", "fix: comment nits", "fix: review comments", "Fix review feedback", "Review fixes", "Fix: address review comments"]) {
      expect(classifier.classify(subject), subject).toEqual({
        kind: "excluded",
        pattern: historyDefaults.fixExcludePatterns[2],
        fixPattern: expect.any(String),
        matchedIn: "subject",
      });
    }
  });

  test("leave a fix of a defect that merely mentions a typo or lint far from the fix word", () => {
    expect(classifier.classify("Fix crash when two readers open the file while the lint step runs").kind).toBe("fix");
    expect(classifier.classify("Fix the parser").kind).toBe("fix");
  });

  test("findExcludedFix returns the excluded change, and null when another commit of the change is a fix", () => {
    expect(findExcludedFix(classifier, "abc", ["Fix typo"])).toEqual({ id: "abc", subject: "Fix typo", pattern: historyDefaults.fixExcludePatterns[1], matchedIn: "subject" });
    expect(findExcludedFix(classifier, "abc", ["chore: fix docker-composes"])).toEqual({ id: "abc", subject: "chore: fix docker-composes", pattern: historyDefaults.fixExcludePatterns[0], matchedIn: "subject" });
    expect(findFix(classifier, "abc", ["Fix typo"])).toBeNull();
    expect(findExcludedFix(classifier, "abc", ["Fix typo", "Fix the parser"])).toBeNull();
    expect(findExcludedFix(classifier, "abc", ["Add feature"])).toBeNull();
  });

  test("are configurable, and an empty list excludes nothing", () => {
    const none = compileFixClassifier({ ...defaultFixSettings, fixExcludePatterns: [] });
    expect(none.classify("Fix typo").kind).toBe("fix");
    expect(() => compileFixClassifier({ ...defaultFixSettings, fixExcludePatterns: ["("] })).toThrow(InvalidPatternError);
  });
});

describe("bodies", () => {
  const message = "Add retries\n\nFixes #123";

  test("are not matched by default, because a Fixes trailer closes any kind of issue", () => {
    expect(classifier.classify(message).kind).toBe("other");
  });

  test("are matched with fixMatchBody, and the match says it was in the body", () => {
    const withBody = compileFixClassifier({ ...defaultFixSettings, fixMatchBody: true });
    expect(withBody.classify(message)).toEqual({ kind: "fix", pattern: historyDefaults.fixPatterns[2], matchedIn: "body" });
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
    expect(findFix(classifier, "abc", ['Revert "Fix the parser"', "Fix the lexer"])).toEqual({ id: "abc", subject: "Fix the lexer", pattern: historyDefaults.fixPatterns[2], matchedIn: "subject" });
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
    expect(checkFixConvention(100, 1).note).toMatch(/fixes are 1% of logical changes, under 2%/);
    expect(checkFixConvention(100, 61).note).toMatch(/over 60%/);
    expect(checkFixConvention(29, 10).note).toMatch(/fewer than 30/);
    expect(checkFixConvention(0, 0)).toMatchObject({ share: null, followsConvention: false });
    expect(checkFixConvention(100, 1).note).toMatch(/probably do not follow a convention/);
  });

  test("states its provenance", () => {
    expect(checkFixConvention(100, 20).guidelines.provenance).toMatch(/Judgement calls/);
  });
});
