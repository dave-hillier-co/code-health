import { reportCommand } from "@code-health/cli-kit/report-command";
import { localityReport } from "../reports/locality.ts";
import { trendsReport } from "../reports/trends.ts";

export const name = "report";

/** `locality report <kind>`: each kind prints its slots with `--slots` and renders notes with `--notes`. To add a report, add a kind here. */
export const command = reportCommand({ locality: localityReport, trends: trendsReport });
