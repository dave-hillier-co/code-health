import { reportCommand } from "@code-health/cli-kit/report-command";
import { structure } from "../reports/structure.ts";

export const name = "report";

/** `structure report <kind>`: each kind prints its slots with `--slots` and renders notes with `--notes`. To add a report, add a kind here. */
export const command = reportCommand({ structure });
