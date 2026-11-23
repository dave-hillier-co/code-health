import { reportCommand } from "@code-health/cli-kit/report-command";
import { hotspots } from "../reports/hotspots.ts";
import { overview } from "../reports/overview.ts";

export const name = "report";

/** `cochange report <kind>`: each kind prints its slots with `--slots` and renders notes with `--notes`. To add a report, add a kind here. */
export const command = reportCommand({ hotspots, overview });
