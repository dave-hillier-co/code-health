import type { ChoiceEntry, NoteEntry, Slot, SlotEntry } from "../protocol.ts";
import { escapeHtml, escapeMd, oneLine, targetId } from "../text.ts";

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

/** The subject to print before a note: none when the slot is about the whole report or its title already names it. */
function leadOf(slot: Slot): string | undefined {
  if (slot.about.kind === "report" || slot.title.includes(slot.about.label)) return undefined;
  return slot.about.label;
}

function parts(slot: Slot, entry: SlotEntry): { subject: string; verdict?: string; text: string }[] {
  if (isChoice(entry)) return entry.items.map((item) => ({ subject: labelOf(slot, item.subject), verdict: item.verdict, text: item.text }));
  const note: NoteEntry = entry;
  return [{ subject: slot.about.label, verdict: note.verdict, text: note.text }];
}

/** The id of the section a slot prints, so a link on the page can point at its judgement. */
export const judgementId = (slotId: string): string => targetId("judgement", slotId);

/**
 * A slot's verdict and text. A note prints as a paragraph under the slot title, led by its subject only when the title
 * does not name it and the slot is not about the whole report; a choosing slot prints a numbered list, each item led by its subject. The text is the
 * agent's and is printed as written, escaped. Numbers never come from it.
 */
export function judgementHtml(data: JudgementData): string {
  const heading = `<h3>${escapeHtml(data.slot.title)}</h3>`;
  const id = ` id="${judgementId(data.slot.id)}"`;
  if (data.entry === undefined) return `<section class="judgement unwritten"${id}>\n${heading}\n<p class="empty">Judgement not yet written.</p>\n</section>`;
  if (!isChoice(data.entry)) {
    const verdict = data.entry.verdict === undefined ? "" : `<span class="verdict">Verdict: ${escapeHtml(data.entry.verdict)}.</span> `;
    const lead = leadOf(data.slot);
    return `<section class="judgement"${id}>\n${heading}\n<p>${lead === undefined ? "" : `<strong class="subject">${escapeHtml(lead)}</strong>: `}${verdict}${escapeHtml(oneLine(data.entry.text))}</p>\n</section>`;
  }
  const items = parts(data.slot, data.entry).map(
    (p) => `<li><strong class="subject">${escapeHtml(p.subject)}</strong>${p.verdict === undefined ? "" : ` <span class="verdict">Verdict: ${escapeHtml(p.verdict)}.</span>`} ${escapeHtml(oneLine(p.text))}</li>`,
  );
  return `<section class="judgement"${id}>\n${heading}\n<ol>\n${items.join("\n")}\n</ol>\n</section>`;
}

export function judgementMd(data: JudgementData): string {
  if (data.entry === undefined) return [`**${escapeMd(data.slot.title)}**`, "", `_Judgement not yet written: ${escapeMd(data.slot.task)}_`].join("\n");
  if (!isChoice(data.entry)) {
    const verdict = data.entry.verdict === undefined ? "" : `Verdict: ${escapeMd(data.entry.verdict)}. `;
    const lead = leadOf(data.slot);
    return [`**${escapeMd(data.slot.title)}**`, "", `${lead === undefined ? "" : `**${escapeMd(lead)}**: `}${verdict}${escapeMd(data.entry.text)}`].join("\n");
  }
  const items = parts(data.slot, data.entry).map((p, i) => `${i + 1}. **${escapeMd(p.subject)}**${p.verdict === undefined ? "" : ` (verdict: ${escapeMd(p.verdict)})`}: ${escapeMd(p.text)}`);
  return [`**${escapeMd(data.slot.title)}**`, "", ...items].join("\n");
}

/**
 * A judgement as one list item with no heading of its own: the subject in bold, the verdict and the text. For
 * lists whose items are already named by the subject.
 */
export function judgedLineMd(slot: Slot, entry: SlotEntry): string {
  return parts(slot, entry).map((p) => `- **${escapeMd(p.subject)}**${p.verdict === undefined ? "" : ` (verdict: ${escapeMd(p.verdict)})`}: ${escapeMd(p.text)}`).join("\n");
}
