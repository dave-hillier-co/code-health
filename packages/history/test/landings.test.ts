import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GitFixture, type Identity } from "@code-health/fixtures/git-fixture";
import { landedText, landingOf, readLandings } from "../src/landings.ts";

describe("landedText", () => {
  test("takes a GitHub merge's title from the body", () => {
    expect(landedText("Merge pull request #12 from owner/branch\n\nFix the crash\n\nDetails")).toEqual({ title: "Fix the crash", text: "Fix the crash\n\nDetails" });
  });

  test("takes the title from the subject in the form Merge pull request #N: title", () => {
    expect(landedText("Merge pull request #681: Fix the crash")).toMatchObject({ title: "Fix the crash" });
    expect(landedText("Merge pull request #681 - Fix the crash")).toMatchObject({ title: "Fix the crash" });
  });

  test("takes a GitLab merge's title from the first line that is not the merge request link", () => {
    expect(landedText("Merge branch 'x' into 'main'\n\nFix the crash\n\nSee merge request g/p!4").title).toBe("Fix the crash");
    expect(landedText("Merge branch 'x' into 'main'\n\nSee merge request g/p!4").title).toBeNull();
  });

  test("reads CRLF messages", () => {
    expect(landedText("Merge pull request #1 from o/b\r\n\r\nFix it\r\n").title).toBe("Fix it");
  });

  test("a merge that names no title, and any other commit, is classified by its own message", () => {
    expect(landedText("Merge branch 'fix/crash'")).toEqual({ title: null, text: "Merge branch 'fix/crash'" });
    expect(landedText("Merge pull request #5 from o/b")).toMatchObject({ title: null });
    expect(landedText("Fix crash (#12)\n\nbody")).toEqual({ title: null, text: "Fix crash (#12)\n\nbody" });
  });
});

describe("readLandings", () => {
  const author: Identity = { name: "A", email: "a@example.com" };
  let repo: GitFixture;
  beforeAll(() => {
    repo = GitFixture.build([
      { type: "commit", message: "Root", date: "2024-01-01T09:00:00Z", author, changes: [{ op: "add", path: "a.txt", content: "0\n" }] },
      { type: "branch", name: "topic", from: "main" },
      { type: "commit", message: "Step one", date: "2024-01-02T09:00:00Z", author, changes: [{ op: "modify", path: "a.txt", content: "1\n" }] },
      { type: "commit", message: "fix: step two", date: "2024-01-03T09:00:00Z", author, changes: [{ op: "modify", path: "a.txt", content: "2\n" }] },
      { type: "checkout", name: "main" },
      { type: "merge", branch: "topic", message: "Merge pull request #1 from o/topic\n\nAdd a thing", date: "2024-01-04T09:00:00Z", author },
      { type: "commit", message: "Fix crash (#2)", date: "2024-01-05T09:00:00Z", author, changes: [{ op: "modify", path: "a.txt", content: "3\n" }] },
    ]);
  });
  afterAll(() => repo.dispose());

  test("a merge and the commits only its later parent reaches are one landed change, and a commit on the line is its own", async () => {
    const landings = await readLandings(repo.path, "HEAD");
    expect(landings.map((l) => [l.how, l.title, l.members.length])).toEqual([["direct", "Root", 1], ["merge", "Add a thing", 2], ["direct", "Fix crash (#2)", 1]]);
    expect(landings[1]!.branch.map((c) => c.message)).toEqual(["Step one", "fix: step two"]);
    const of = landingOf(landings);
    expect(of.get(landings[1]!.members[1]!)).toBe(landings[1]);
  });
});
