import { analysisCommand } from "../analysis-command.ts";
import { readLevel, type Level } from "../modules.ts";
import { analyseCoupling } from "./coupling.ts";

export const name = "hidden";

const views: readonly Level[] = ["file", "folder", "component"];

export const command = analysisCommand(name, {
  summary: "Pairs with high co-change and low static coupling, often the result of earlier indirection (coupling --quadrant hidden)",
  options: { by: { type: "string" } },
  optionHelp: { by: "what a module is: file, folder or component (default folder)" },
  partial: ({ values }) => values.by !== undefined && values.by !== "folder",
  analyse(input) {
    return analyseCoupling(input, readLevel("by", input.context.values.by, views, "folder"), "hidden");
  },
});
