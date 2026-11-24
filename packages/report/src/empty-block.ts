import type { Block } from "./block.ts";
import { rankedTableEmpty } from "./components/ranked-table.ts";
import { stabilityChartEmpty } from "./components/stability-chart.ts";
import type { ReportBuild, Section } from "./report-model.ts";

/**
 * The one line a block prints in place of itself when it has nothing to show, or undefined when it has content.
 * A ranked table with no rows and a stability chart with fewer than 3 points are empty. The line says what is
 * empty, and why when the block's `emptyText` gives a reason.
 */
export function emptyNotice(block: Block): string | undefined {
  switch (block.type) {
    case "ranked-table": return rankedTableEmpty(block);
    case "stability-chart": return stabilityChartEmpty(block);
    default: return undefined;
  }
}

/**
 * The one line a section prints in place of its heading and blocks, or undefined when it has content. A section
 * is empty when at least one block is empty and every other block is a notice. The line is the empty blocks'
 * lines and the notices' texts, in order, without a leading copy of the section's heading (the page prints the heading before the line), so a notice that explains why nothing is shown stays. A judgement
 * block counts as content, so a section asking for judgement is never collapsed.
 */
export function emptySection(section: Section): string | undefined {
  const lines = section.blocks.map((b) => (b.type === "notice" ? b.text : emptyNotice(b)));
  if (lines.some((l) => l === undefined) || !section.blocks.some((b) => b.type !== "notice")) return undefined;
  const line = lines.join(" ");
  const own = `${section.heading}: `;
  return line.startsWith(own) ? line.slice(own.length) : line;
}

/**
 * Removes the judgement slots that only comment on empty content, so the agent is not asked to write about
 * nothing. A judgement block is attached to the blocks before it in its section, back to the previous judgement
 * block or the section start (notices do not count). When there is at least one such block and all of them are
 * empty, the judgement block and its slot are removed. A judgement with no block before it, such as a summary
 * at the top of a section, is kept. Call it on the finished build: `return dropEmptySlots({ title, ... })`.
 */
export function dropEmptySlots(build: ReportBuild): ReportBuild {
  const dropped = new Set<string>();
  const sections = build.sections.map((section): Section => {
    const blocks: Block[] = [];
    let group: Block[] = [];
    for (const block of section.blocks) {
      if (block.type === "judgement") {
        const content = group.filter((b) => b.type !== "notice");
        if (content.length > 0 && content.every((b) => emptyNotice(b) !== undefined)) dropped.add(block.slot);
        else blocks.push(block);
        group = [];
      } else {
        blocks.push(block);
        group.push(block);
      }
    }
    return { ...section, blocks };
  });
  return { ...build, sections, slots: build.slots.filter((slot) => !dropped.has(slot.id)) };
}
