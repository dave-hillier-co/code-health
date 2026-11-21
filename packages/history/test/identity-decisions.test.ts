import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  emptyDecisions,
  identityFiles,
  mergeDecisions,
  readDecisions,
  resolveLocation,
  writeDecisions,
} from "../src/identity-decisions.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "identity-decisions-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("nothing recorded reads as empty", () => {
  expect(readDecisions(root)).toEqual(emptyDecisions());
});

test("the location is the configured one, else where files already are, else undecided", () => {
  expect(resolveLocation(root, null)).toBeNull();
  expect(resolveLocation(root, "local")).toBe("local");
  writeFileSync(join(root, ".mailmap"), "");
  expect(resolveLocation(root, null)).toBe("committed");
  mkdirSync(identityFiles(root).localDir, { recursive: true });
  writeFileSync(identityFiles(root).localMailmap, "");
  expect(resolveLocation(root, null)).toBe("local");
  expect(resolveLocation(root, "committed")).toBe("committed");
});

test("local decisions go under .code-health/local with a gitignore that excludes the folder", () => {
  writeDecisions(root, "local", mergeDecisions(emptyDecisions(), { rejectedMerges: [], classifications: [{ identity: "Bot <b@x.com>", kind: "bot" }] }));
  const files = identityFiles(root);
  expect(existsSync(files.localDecisions)).toBe(true);
  expect(readFileSync(join(files.localDir, ".gitignore"), "utf8")).toBe("*\n");
  expect(existsSync(files.committedDecisions)).toBe(false);
});

test("committed decisions are stable: sorted, deduplicated, one entry per pair and per address, the later winning", () => {
  const first = mergeDecisions(emptyDecisions(), {
    rejectedMerges: [
      { identities: ["Zed <z@x.com>", "Amy <a@x.com>"], reason: "different people" },
      { identities: ["amy <A@x.com>", "zed <z@x.com>"] },
    ],
    classifications: [
      { identity: "Sync <s@x.com>", kind: "bot" },
      { identity: "Sync Robot <S@x.com>", kind: "service" },
    ],
  });
  writeDecisions(root, "committed", first);
  const read = readDecisions(root, "committed");
  expect(read.rejectedMerges).toHaveLength(1);
  expect(read.rejectedMerges[0]!.identities).toEqual(["amy <A@x.com>", "zed <z@x.com>"]);
  expect(read.classifications).toEqual([{ identity: "Sync Robot <S@x.com>", kind: "service" }]);
  const text = readFileSync(identityFiles(root).committedDecisions, "utf8");
  writeDecisions(root, "committed", read);
  expect(readFileSync(identityFiles(root).committedDecisions, "utf8")).toBe(text);
});

test("reading without a location combines the committed and local files", () => {
  writeDecisions(root, "committed", mergeDecisions(emptyDecisions(), { rejectedMerges: [], classifications: [{ identity: "A <a@x.com>", kind: "bot" }] }));
  writeDecisions(root, "local", mergeDecisions(emptyDecisions(), { rejectedMerges: [], classifications: [{ identity: "B <b@x.com>", kind: "service" }] }));
  expect(readDecisions(root).classifications.map((c) => c.identity)).toEqual(["A <a@x.com>", "B <b@x.com>"]);
});

test("a malformed decisions file is a config error naming the file", () => {
  mkdirSync(join(root, ".code-health"));
  writeFileSync(identityFiles(root).committedDecisions, JSON.stringify({ schemaVersion: 1, classifications: [{ identity: "A <a@x.com>", kind: "robot" }] }));
  expect(() => readDecisions(root)).toThrow(/identity-decisions\.json.*kind/);
});
