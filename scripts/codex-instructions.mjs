/** Fail on upstream wording changes rather than silently shipping host-specific instructions. */
function replaceOnce(text, pattern, replacement) {
  const matches = text.match(new RegExp(pattern.source, `${pattern.flags}g`));
  if (matches?.length !== 1) throw new Error(`Expected one match for ${pattern}`);
  return text.replace(pattern, replacement);
}

const transcriptLimit = "Codex session effort and coupled-change completeness are unavailable in this release. The bundled transcript reader understands Claude Code sessions only. Do not supply Codex sessions to it or interpret missing sessions as zero effort. Omit --projects-dir for Git-based outcome commands. Do not run outcome completeness or locality measure baseline, compare or premise to measure Codex effort; locality measure change and report trends remain available as leading indicators.";

const executionScope = `## Execution scope in Codex

Resolve \`<absolute skill directory>\` from the location of this SKILL.md; it is a placeholder, not a shell variable. Quote the absolute script path and run from the repository being analysed, not the skill directory. Requires Node 22.13 or later and git; the installed skill needs no npm install.

Analysis writes local caches under \`.cache/code-health\`; linked worktrees share the main checkout's history cache. Follow the host's sandbox and approval rules if that location is not writable. This skill does not grant execution permissions or authorise edits beyond the user's request. References to commits describe how to group changes when commits are requested; otherwise leave the changes for review, run the project's checks, and defer commit-based verification and outcome comparisons until a commit exists. Do not create a commit merely to run those commands. For authorised locality moves and namespace edits, use \`--apply --no-commit\` unless the user requests a commit. Preserve dry runs and all command refusals.

Sibling skills are optional: use them when installed and relevant; otherwise report the suggested follow-up without assuming they are installed.

${transcriptLimit}
`;

/** Adapt executable paths in entrypoints and supporting references alike. */
export function codexMarkdown(text, tool) {
  text = text.replaceAll(`node \${CLAUDE_PLUGIN_ROOT}/dist/${tool}.mjs`, `node "<absolute skill directory>/scripts/${tool}.mjs"`);
  if (text.includes("CLAUDE_PLUGIN_ROOT")) throw new Error("Unconverted Claude executable path");
  return text;
}

export function codexInstructions(text, skill = "cochange", tool = "cochange") {
  text = replaceOnce(text, /^allowed-tools:.*\n/m, "");
  if (skill === "cochange") {
    text = replaceOnce(text, /`\$\{CLAUDE_PLUGIN_ROOT\}` is replaced[^\n]*?Commands refresh/, "Commands refresh");
    text = replaceOnce(text, /To ask how often agents finish a coupled change,[^\n]*/, transcriptLimit);
    text = replaceOnce(text, /Run this before a non-trivial task, on the files you expect to edit\. Skip it for a typo or a one-line fix\./, "When this skill is selected for a change briefing, run it on the files the user expects to edit. Skip it for a typo or a one-line fix.");
    text = text.replace("If work follows from a finding, its commit message records", "If the user requests a commit for work that follows from a finding, its commit message records");
  }
  if (skill === "structure") {
    text = replaceOnce(text, /Add `--projects-dir ~\/\.claude\/projects`[^\n]*/, "Codex agent effort is unavailable. Run the outcome command without --projects-dir for the Git-based comparison. `leading` gives cycle counts and layer violations; these are leading indicators only. State sample sizes and do not claim that navigation improved without evidence.");
    text = replaceOnce(text, / or, with `--projects-dir ~\/\.claude\/projects`,[^\n]*?dependency\)/, "");
    text = text.replace(", and, with transcripts, agent effort on tasks touching either side", ". Agent effort is unavailable for Codex");
  }
  if (skill === "complexity") {
    text = replaceOnce(text, / and `agentEffort` \(files read and re-read per task\n\s+that edited the files\)\./, ". Codex `agentEffort` is unavailable.");
  }
  if (skill === "locality") {
    text = replaceOnce(text, /Agent effort over later tasks is the outcome\. Take a baseline[^\n]*?Do not claim an improvement the data cannot show\./, "Agent effort over later tasks is the outcome, but Codex session measurement is unavailable. Use `measure change` and `report trends` for structural leading indicators only; see `references/measure.md`. Do not claim these prove that changes became cheaper.");
    text = replaceOnce(text, /Show the operations and rewrites to the user, then apply:/, "Show the operations and rewrites to the user, then apply within the authorised scope, leaving changes staged unless a commit was requested:");
    text = text.replaceAll("move src/shared/utils/money.ts --apply", "move src/shared/utils/money.ts --apply --no-commit");
    text = text.replaceAll("update-namespaces --apply\n", "update-namespaces --apply --no-commit\n");
    text = replaceOnce(text, /`--apply` needs a clean working tree,[^\n]*/, "`--apply --no-commit` needs a clean working tree, makes the moves with `git mv`, rewrites the imports and leaves them staged. Add any mention fixes and run the project's checks. Omit `--no-commit` only when the user requests a commit; the CLI then records the rule, consumer count, red flags and `Code-Health:` trailer in its commit message.");
  }
  text = text.replace(/ \[--projects-dir (?:DIR|~\/\.claude\/projects)\]/g, "");
  text = codexMarkdown(text, tool);
  // Put host-specific scope before the playbooks, so commit instructions are conditional throughout.
  text = replaceOnce(text, /^(# [^\n]+\n)/m, `$1\n${executionScope}\n`);
  if (text.includes("allowed-tools:") || text.includes("~/.claude")) throw new Error("Unconverted Claude instructions");
  return text;
}

export function codexReference(text, skill, file, tool) {
  if (skill === "locality" && file === "measure.md") {
    const heading = "## What one change does to import distance";
    if (!text.includes(heading)) throw new Error("Missing locality change measurement reference");
    text = `# Measuring locality in Codex\n\n${transcriptLimit}\n\n` + text.slice(text.indexOf(heading));
  }
  if (skill === "packaging" && file === "measurement.md") {
    text = replaceOnce(text, /^node .*--projects-dir ~\/\.claude\/projects --json\n/m, "");
    text = text.replace("Note who will do the tasks that touch the packages, because agent effort comes from their session transcripts.", "Codex session effort is unavailable; keep the structural baseline and use Git-based outcomes.");
    text = replaceOnce(text, /^- \*\*`agentEffort`\*\*[^\n]*/m, "- **`agentEffort`** is unavailable for Codex; run without --projects-dir and report it as not measured.");
    text = text.replace("| Agent effort on tasks touching the reshaped packages | Navigation and build context got cheaper | Primary outcome |", "| Agent effort | Unavailable for Codex | Cannot establish navigation or build-context improvement |");
  }
  if (skill === "complexity" && file === "outcome.md") {
    text = text.replace(" [--projects-dir <dir>]", "");
    text = replaceOnce(text, /^\| `agentEffort`[^\n]*/m, "| `agentEffort` | Unavailable for Codex; omit --projects-dir | Report as not measured, never zero |");
  }
  text = codexMarkdown(text, tool);
  if (/transcript|agentEffort|measure baseline|measure compare/.test(text) && !text.includes(transcriptLimit)) {
    text = text.replace(/^(# [^\n]+\n)/m, `$1\n${transcriptLimit}\n`);
  }
  if (skill === "locality" && file === "moving.md") {
    text = text.replace("## Commit\n", "## Commit\n\nUse `--apply --no-commit` for authorised edits unless a commit was requested. The commit description and verification below apply only after a requested commit exists; otherwise leave changes staged and validate with the project's checks.\n");
  }
  return text;
}
