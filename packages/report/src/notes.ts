import { stampProblems } from "./stamp.ts";
import { ReportError, type Notes, type Slot, type SlotEntry } from "./protocol.ts";
import type { Report } from "./report-model.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** What is wrong with one `{ verdict?, text }` piece of an entry, each as a sentence naming where. */
function pieceProblems(where: string, slot: Slot, piece: unknown, allowed: readonly string[]): string[] {
  if (!isRecord(piece)) return [`${where} must be an object with ${slot.verdicts.length > 0 ? "a verdict and " : ""}text`];
  const problems: string[] = [];
  const extra = Object.keys(piece).filter((key) => key !== "verdict" && key !== "text" && !allowed.includes(key));
  if (extra.length > 0) problems.push(`${where} has fields the slot does not take: ${extra.join(", ")}`);
  const { verdict, text } = piece;
  if (slot.verdicts.length > 0) {
    if (typeof verdict !== "string" || verdict === "") problems.push(`${where} needs a verdict, one of: ${slot.verdicts.join(", ")}`);
    else if (!slot.verdicts.includes(verdict)) problems.push(`${where} has verdict "${verdict}", which is not one of: ${slot.verdicts.join(", ")}`);
  } else if (verdict !== undefined) {
    problems.push(`${where} has a verdict, and this slot takes text only`);
  }
  if (typeof text !== "string") problems.push(`${where} needs text, a string`);
  else if (text.trim() === "") problems.push(`${where} has empty text`);
  else if (text.length > slot.maxChars) problems.push(`${where} has ${text.length} characters of text and the limit is ${slot.maxChars}`);
  return problems;
}

function entryProblems(slot: Slot, entry: unknown): string[] {
  const where = `slot "${slot.id}"`;
  if (slot.choose === undefined) return pieceProblems(where, slot, entry, []);
  if (!isRecord(entry) || !Array.isArray(entry.items)) return [`${where} must be an object with an "items" list of at most ${slot.choose.max} subjects chosen from its candidates`];
  const problems: string[] = [];
  const extra = Object.keys(entry).filter((key) => key !== "items");
  if (extra.length > 0) problems.push(`${where} has fields the slot does not take: ${extra.join(", ")}`);
  const { items } = entry;
  if (items.length === 0) problems.push(`${where} needs at least one item`);
  if (items.length > slot.choose.max) problems.push(`${where} has ${items.length} items and the limit is ${slot.choose.max}`);
  const refs = slot.choose.candidates.map((c) => c.ref);
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const at = `${where} item ${i + 1}`;
    problems.push(...pieceProblems(at, slot, item, ["subject"]));
    const subject = isRecord(item) ? item.subject : undefined;
    if (typeof subject !== "string") problems.push(`${at} needs a subject, one of the slot's candidates`);
    else if (!refs.includes(subject)) problems.push(`${at} names subject "${subject}", which is not one of the candidates: ${refs.join(", ")}`);
    else if (seen.has(subject)) problems.push(`${at} repeats subject "${subject}"`);
    else seen.add(subject);
  });
  return problems;
}

/**
 * Checks a notes document against a report and returns its entries. Throws one `ReportError` listing every
 * problem: a stamp that does not match, a slot with no entry or an empty one, an entry for a slot that does not
 * exist, a verdict outside the allowed ones, text over its limit.
 */
export function validateNotes(report: Report, document: unknown): Notes {
  if (!isRecord(document)) throw new ReportError("the notes file must be a JSON object with a stamp and a notes object");
  const problems = stampProblems(report.stamp, document.stamp);
  const given = document.notes;
  if (!isRecord(given)) {
    problems.push('the notes file has no "notes" object with one entry per slot id');
  } else {
    const ids = report.slots.map((slot) => slot.id);
    for (const slot of report.slots) {
      if (!(slot.id in given)) problems.push(`slot "${slot.id}" has no entry in the notes`);
      else problems.push(...entryProblems(slot, given[slot.id]));
    }
    for (const id of Object.keys(given)) if (!ids.includes(id)) problems.push(`the notes have an entry "${id}", and the report has no such slot; slots: ${ids.join(", ")}`);
  }
  if (problems.length > 0) throw new ReportError(`the notes were rejected, ${problems.length} ${problems.length === 1 ? "problem" : "problems"}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return given as Record<string, SlotEntry>;
}
