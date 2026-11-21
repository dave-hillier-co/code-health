import { expect, test } from "vitest";
import { addMailmapMappings, formatMapping } from "../src/identity-mailmap.ts";

const jo = { name: "Jo Kim", email: "jo@corp.com" };

test("a mapping is written in full so it matches on name and email", () => {
  expect(formatMapping({ canonical: jo, alias: { name: "jo", email: "jo@home.net" } })).toBe("Jo Kim <jo@corp.com> jo <jo@home.net>");
});

test("existing lines, comments and blank lines are kept exactly, and new lines are sorted at the end", () => {
  const existing = "# Team mailmap\n\nAnn Lee <ann@corp.com>   <ann@old.com>\n  # indented comment\n";
  const update = addMailmapMappings(existing, [
    { canonical: jo, alias: { name: "zed", email: "zed@x.com" } },
    { canonical: jo, alias: { name: "jo", email: "jo@home.net" } },
  ]);
  expect(update.text).toBe(`${existing}Jo Kim <jo@corp.com> jo <jo@home.net>\nJo Kim <jo@corp.com> zed <zed@x.com>\n`);
  expect(update.added).toEqual(["Jo Kim <jo@corp.com> jo <jo@home.net>", "Jo Kim <jo@corp.com> zed <zed@x.com>"]);
});

test("applying nothing, or what is already there, returns the file byte for byte", () => {
  const existing = "# c\nJo Kim <jo@corp.com> jo <jo@home.net>\nno newline at end <x@y.z> <w@y.z>";
  expect(addMailmapMappings(existing, []).text).toBe(existing);
  const again = addMailmapMappings(existing, [{ canonical: jo, alias: { name: "JO", email: "Jo@Home.net" } }]);
  expect(again.text).toBe(existing);
  expect(again.present).toHaveLength(1);
});

test("a file without a final newline gets one before the new lines", () => {
  const update = addMailmapMappings("# only comment", [{ canonical: jo, alias: { name: "j", email: "j@x.com" } }]);
  expect(update.text).toBe("# only comment\nJo Kim <jo@corp.com> j <j@x.com>\n");
});

test("an alias already mapped to someone else is refused, never replaced", () => {
  const existing = "Ann Lee <ann@corp.com> <jo@home.net>\n";
  expect(() => addMailmapMappings(existing, [{ canonical: jo, alias: { name: "jo", email: "jo@home.net" } }])).toThrow(/already mapped/);
});

test("an alias identical to its canonical identity adds nothing", () => {
  expect(addMailmapMappings("", [{ canonical: jo, alias: jo }]).text).toBe("");
});

test("an empty file gets just the new lines", () => {
  expect(addMailmapMappings("", [{ canonical: jo, alias: { name: "j", email: "j@x.com" } }]).text).toBe("Jo Kim <jo@corp.com> j <j@x.com>\n");
});
