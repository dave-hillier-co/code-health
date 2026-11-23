import type { ChoiceEntry, NoteEntry, Slot, SlotEntry } from "../protocol.ts";
import { escapeHtml, escapeMd, oneLine } from "../text.ts";

export interface JudgementData {
  slot: Slot;
  /** The entry written for the slot. Undefined in a data-only draft. */
  entry: SlotEntry | undefined;
}

const isChoice = (entry: SlotEntry): entry is ChoiceEntry => "items" in entry;

/** The label of a subject a choosing slot allows, or the ref itself when it is not one of them. */
function labelOf(slot: Slot, ref: string): string {
  return slot.choose?.candidates.find((c) => c.ref === ref)?.label ?? ref;
}

function parts(slot: Slot, entry: SlotEntry): { subject: string; verdict?: string; text: string }[] {
  if (isChoice(entry)) return entry.items.map((item) => ({ subject: labelOf(slot, item.subject), verdict: item.verdict, text: item.text }));
  const note: NoteEntry = entry;
  return [{ subject: slot.about.label, verdict: note.verdict, text: note.text }];
}

/** A slot's verdict and text with its subject. The text is the agent's and is printed as written, escaped. Numbers never come from it. */
export function judgementHtml(data: JudgementData): string {
  const heading = `<h3>${escapeHtml(data.slot.title)}</h3>`;
  if (data.entry === undefined) return `<section class="judgement unwritten">\n${heading}\n<p class="empty">Judgement not yet written.</p>\n</section>`;
  const items = parts(data.slot, data.entry).map(
    (p) => `<li><strong class="subject">${escapeHtml(p.subject)}</strong>${p.verdict === undefined ? "" : ` <span class="verdict">Verdict: ${escapeHtml(p.verdict)}.</span>`} ${escapeHtml(oneLine(p.text))}</li>`,
  );
  return `<section class="judgement">\n${heading}\n<ol>\n${items.join("\n")}\n</ol>\n</section>`;
}

export function judgementMd(data: JudgementData): string {
  if (data.entry === undefined) return [`**${escapeMd(data.slot.title)}**`, "", `_Judgement not yet written: ${escapeMd(data.slot.task)}_`].join("\n");
  const items = parts(data.slot, data.entry).map((p, i) => `${i + 1}. **${escapeMd(p.subject)}**${p.verdict === undefined ? "" : ` (verdict: ${escapeMd(p.verdict)})`}: ${escapeMd(p.text)}`);
  return [`**${escapeMd(data.slot.title)}**`, "", ...items].join("\n");
}
