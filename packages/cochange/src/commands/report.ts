import { reportCommand } from "@code-health/cli-kit/report-command";
import { change } from "../reports/change.ts";
import { coupling } from "../reports/coupling.ts";
import { hotspots } from "../reports/hotspots.ts";
import { knowledge } from "../reports/knowledge.ts";
import { overview } from "../reports/overview.ts";

export const name = "report";

/** `cochange report <kind>`: each kind prints its slots with `--slots` and renders notes with `--notes`. To add a report, add a kind here. */
export const command = reportCommand({ change, coupling, hotspots, knowledge, overview });
