import { expect, test } from "vitest";
import { isWithinRepo, toRepoPath } from "../src/repo-path.ts";

const roots = ["/work/repo"];

test("an absolute path under the root becomes repo-relative POSIX", () => {
  expect(toRepoPath("/work/repo/src/a.ts", roots)).toBe("src/a.ts");
  expect(toRepoPath("/work/repo/a.ts", roots)).toBe("a.ts");
});

test("paths outside the repo are dropped", () => {
  expect(toRepoPath("/work/other/a.ts", roots)).toBeNull();
  expect(toRepoPath("/work/repository/a.ts", roots)).toBeNull();
  expect(toRepoPath("/work/repo/../other/a.ts", roots)).toBeNull();
  expect(toRepoPath("/home/me/.claude/plans/x.md", roots)).toBeNull();
});

test("the root itself, null and empty paths are dropped", () => {
  expect(toRepoPath("/work/repo", roots)).toBeNull();
  expect(toRepoPath("/work/repo/", roots)).toBeNull();
  expect(toRepoPath(null, roots)).toBeNull();
  expect(toRepoPath("", roots)).toBeNull();
});

test("dot segments and doubled separators are normalised", () => {
  expect(toRepoPath("/work/repo/src/./x/../a.ts", roots)).toBe("src/a.ts");
  expect(toRepoPath("/work/repo//src/a.ts", roots)).toBe("src/a.ts");
});

test("a relative path is taken as repo-relative unless it escapes the root", () => {
  expect(toRepoPath("src/a.ts", roots)).toBe("src/a.ts");
  expect(toRepoPath("../a.ts", roots)).toBeNull();
});

test("any of several roots, such as worktree checkouts, may match", () => {
  const several = ["/work/repo", "/work/repo/.claude/worktrees/w1"];
  expect(toRepoPath("/work/repo/.claude/worktrees/w1/src/a.ts", several)).toBe("src/a.ts");
  expect(toRepoPath("/work/repo/src/a.ts", several)).toBe("src/a.ts");
});

test("Windows separators are converted to POSIX", () => {
  expect(toRepoPath("C:\\work\\repo\\src\\a.ts", ["C:\\work\\repo"])).toBe("src/a.ts");
});

test("Windows drive letters compare case-insensitively", () => {
  expect(toRepoPath("c:\\repo\\a.ts", ["C:\\repo"])).toBe("a.ts");
  expect(toRepoPath("C:\\Repo\\src\\a.ts", ["c:\\repo"])).toBe("src/a.ts");
});

test("home-relative paths are not repo files", () => {
  expect(toRepoPath("~/x", ["/r"])).toBeNull();
});

test("files under .git and node_modules are not the repo's own code", () => {
  expect(toRepoPath("/r/.git/config", ["/r"])).toBeNull();
  expect(toRepoPath("/r/node_modules/p/index.js", ["/r"])).toBeNull();
  expect(toRepoPath("/r/packages/a/node_modules/p/index.js", ["/r"])).toBeNull();
  expect(toRepoPath("/r/src/node_modules_like.ts", ["/r"])).toBe("src/node_modules_like.ts");
});

test("isWithinRepo accepts the root, repo paths and a missing path, and rejects outside paths", () => {
  expect(isWithinRepo(null, ["/r"])).toBe(true);
  expect(isWithinRepo("/r", ["/r"])).toBe(true);
  expect(isWithinRepo("/r/src", ["/r"])).toBe(true);
  expect(isWithinRepo("/elsewhere", ["/r"])).toBe(false);
  expect(isWithinRepo("~/x", ["/r"])).toBe(false);
});
