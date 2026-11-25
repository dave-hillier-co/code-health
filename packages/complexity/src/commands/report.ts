import { reportCommand } from "@code-health/cli-kit/report-command";
import { trendsReport } from "../reports/trends.ts";
import { xray } from "../reports/xray.ts";

export const name = "report";

/** `complexity report <kind>`: each kind prints its slots with `--slots` and renders notes with `--notes`. To add a report, add a kind here. */
export const command = reportCommand({ xray, trends: trendsReport });
