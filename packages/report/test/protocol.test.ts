import { expect, test } from "vitest";
import { validateNotes } from "../src/notes.ts";
import { ReportError, type Report } from "../src/protocol.ts";
import { renderReport } from "../src/render.ts";
import { slotsDocument } from "../src/slots-document.ts";
import { makeStamp } from "../src/stamp.ts";
import { sampleNotes, sampleReport } from "./support.ts";

const good = () => ({ stamp: sampleReport().stamp, notes: structuredClone(sampleNotes) });
const reject = (report: Report, document: unknown): string => {
  try {
    validateNotes(report, document);
  } catch (error) {
    expect(error).toBeInstanceOf(ReportError);
    return (error as Error).message;
  }
  throw new Error("expected the notes to be rejected");
};

test("valid notes are returned as they are", () => {
  expect(validateNotes(sampleReport(), good())).toEqual(sampleNotes);
});

test("a stamp read back from json equals the one computed, floats and key order included", () => {
  const inputs = { b: 0.1234567891, a: [1, 2] };
  const stamp = makeStamp("k", "h", "c", inputs);
  expect(JSON.parse(JSON.stringify(stamp))).toEqual(makeStamp("k", "h", "c", { a: [1, 2], b: 0.1234567891 }));
});

test("a stamp for another head is refused and the message names both", () => {
  const document = good();
  document.stamp = { ...document.stamp, head: "f".repeat(40) };
  expect(reject(sampleReport(), document)).toMatch(/HEAD fffffff .* 0123456/);
});

test("a stamp with other inputs is refused and names the input", () => {
  const document = good();
  document.stamp = { ...document.stamp, inputs: { arg: "y" } };
  expect(reject(sampleReport(), document)).toContain("(arg)");
});

test("a missing slot, an empty text and an entry for no slot are each named", () => {
  const document = good();
  delete (document.notes as Record<string, unknown>).look;
  (document.notes as Record<string, unknown>).limits = { text: "   " };
  (document.notes as Record<string, unknown>).extra = { text: "x" };
  const message = reject(sampleReport(), document);
  expect(message).toContain('slot "look" has no entry');
  expect(message).toContain('slot "limits" has empty text');
  expect(message).toContain('an entry "extra"');
  expect(message).toContain("3 problems");
});

test("a verdict outside the enum, a missing verdict and a verdict on a text-only slot are refused", () => {
  const a = good();
  (a.notes.look as { verdict?: string }).verdict = "maybe";
  expect(reject(sampleReport(), a)).toContain('verdict "maybe"');
  const b = good();
  delete (b.notes.look as { verdict?: string }).verdict;
  expect(reject(sampleReport(), b)).toContain("needs a verdict");
  const c = good();
  (c.notes.limits as { verdict?: string }).verdict = "act";
  expect(reject(sampleReport(), c)).toContain("takes text only");
});

test("text over its limit is refused with both numbers", () => {
  const document = good();
  document.notes.limits = { text: "x".repeat(101) };
  expect(reject(sampleReport(), document)).toContain("101 characters of text and the limit is 100");
});

test("a choosing slot takes up to its maximum of distinct candidates", () => {
  const report = sampleReport();
  report.slots = [{ id: "pick", title: "Pick", about: { kind: "report", ref: "r", label: "r" }, task: "t", verdicts: ["a"], maxChars: 50, choose: { max: 2, candidates: [{ ref: "x", label: "X" }, { ref: "y", label: "Y" }, { ref: "z", label: "Z" }] } }];
  const stamp = report.stamp;
  const entry = (...subjects: string[]) => ({ stamp, notes: { pick: { items: subjects.map((subject) => ({ subject, verdict: "a", text: "why" })) } } });
  expect(() => validateNotes(report, entry("x", "y"))).not.toThrow();
  expect(reject(report, entry("x", "y", "z"))).toContain("3 items and the limit is 2");
  expect(reject(report, entry("w"))).toContain('subject "w"');
  expect(reject(report, entry("x", "x"))).toContain('repeats subject "x"');
  expect(reject(report, entry())).toContain("at least one item");
});

test("html without notes is refused and markdown without notes is a draft", () => {
  expect(() => renderReport(sampleReport(), "html", undefined)).toThrow(/needs notes/);
  expect(renderReport(sampleReport(), "md", undefined)).toContain("not yet written");
});

test("the slots document holds the stamp, the data and the slots, and no judgement", () => {
  const document = slotsDocument(sampleReport()) as { stamp: unknown; slots: { id: string }[]; data: { sections: unknown[] } };
  expect(document.stamp).toEqual(sampleReport().stamp);
  expect(document.slots.map((s) => s.id)).toEqual(["look", "limits"]);
  expect(document.data.sections).toHaveLength(2);
});

test("notes text is escaped, so markup in it never reaches the page", () => {
  expect(renderReport(sampleReport(), "html", sampleNotes)).toContain("Split it &lt;now&gt;.");
  expect(renderReport(sampleReport(), "md", sampleNotes)).toContain("Split it \\<now\\>.");
});
