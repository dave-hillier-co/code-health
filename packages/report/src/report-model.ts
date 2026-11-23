import type { Block } from "./block.ts";
import type { ReportHeader, Slot, Stamp } from "./protocol.ts";

export interface Section {
  /** Becomes the anchor of the section and its entry in the nav. */
  id: string;
  heading: string;
  blocks: Block[];
}

/** What a report kind provides. The kit adds the repository facts to make a `Report`. */
export interface ReportBuild {
  title: string;
  /** What else the data depends on, for the stamp. */
  inputs: Record<string, unknown>;
  header: Pick<ReportHeader, "evidenceGrade" | "historyWindow" | "excluded">;
  sections: Section[];
  /** Fixed statements of what the data cannot say. Rendered in the Limits section. */
  limits: string[];
  slots: Slot[];
}

export interface Report extends Omit<ReportBuild, "header"> {
  kind: string;
  header: ReportHeader;
  stamp: Stamp;
}
