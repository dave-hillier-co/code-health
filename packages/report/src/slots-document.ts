import { normalise } from "./json.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import type { Report } from "./report-model.ts";

/**
 * The document `--slots` prints: the report kind, the stamp to copy into the notes, the data the report will
 * show, and the slots to fill. It holds no judgement, and nothing in it depends on the wall clock.
 */
export function slotsDocument(report: Report): Record<string, unknown> {
  return normalise({
    protocol: PROTOCOL_VERSION,
    report: report.kind,
    stamp: report.stamp,
    data: { title: report.title, header: report.header, sections: report.sections, limits: report.limits },
    slots: report.slots,
    instructions: "Write notes.json as { stamp, notes }: copy the stamp unchanged, and give each slot id an entry that follows the slot's shape.",
  });
}
