# Reports: Writing the Judgement

Part of the code-health suite. Every skill ships a copy of this reference in `references/reports.md`, generated from `shared/reports.md` at build time.

A report is an HTML or Markdown page that the CLI renders and the agent only annotates. The CLI computes every number, table and chart. You write the judgement slots, and nothing else on the page.

## The steps

1. **Run `--slots`.** `report <kind> [args] --slots`, run with the plugin's CLI as SKILL.md writes its path, prints JSON: the report kind, a `stamp`, the `data` the report will show, and the `slots` to fill. Run it from the repository root, with the arguments the report needs (the file for `xray`, the range for `change`).
2. **Read the data.** Read `data.header` (the evidence grade, the history window and what was excluded with counts), the sections, and `data.limits`. A report that has no evidence for a claim has nothing for you to write about it.
3. **Write notes.json.** One JSON object, `{ "stamp": ..., "notes": { "<slot id>": entry } }`. Copy the `stamp` unchanged. Give every slot id exactly one entry that follows the slot's shape:
   - a slot with `verdicts` takes `{ "verdict": one of them, "text": "..." }`; a slot with no verdicts takes `{ "text": "..." }`;
   - a slot with `choose` takes `{ "items": [{ "subject": a candidate ref, "verdict": ..., "text": "..." }] }` with at least one item and at most `choose.max`, each subject used once;
   - `text` is not empty and has at most `maxChars` characters.
4. **Render.** `report <kind> [args] --notes notes.json --format html --out report.html`, or `--format md`. Rendering exits with 2 and names every problem when the stamp does not match (a new commit, another config, other arguments or other stored results since `--slots`: run it again and rewrite the notes), when a slot has no entry or an empty one, when an entry names no slot, or when a verdict, subject or length is not allowed.

`--format md` without `--notes` prints a data-only draft with the slots marked "not yet written". It is for a quick look in a terminal. HTML needs notes.

## What to write

- **Judge only what the data supports.** Cite values that the report shows, and write them as the report shows them. The page prints your text as written and never checks a number in it, so a number you add that the data does not show is an error you introduced.
- **Say how strong the evidence is.** With a `weak` grade, history-based findings are tentative, and your text says so. A short history, one contributor, a shallow clone or a change of merge policy limits what any ranking can mean.
- **Guidelines label, they do not decide.** Write "above guideline" and "worth a look". Do not write "violation", "fails" or "too complex", and do not give the report a score or a rating.
- **Name the next step, not a verdict on people.** Names of people appear only where the plugin already allows them (abandonment and successors with `--names`; the knowledge report follows the same rule). Do not add names the data does not show.
- **Say when the data does not cover it.** A stored result that is missing is a line in the report saying which command to run. Do not guess at what it would have shown.
- **Keep it short.** A slot's `maxChars` is a limit, not a target. One or two sentences usually serve.

## What the page holds

Every report has a header (repository, analysed commit, date, config hash, evidence grade, history window, and what was excluded with counts), its sections, and a Limits section. Guidelines appear as legend values beside the numbers, with a marker and words for a value on the marked side, and never as a single score or a red, yellow and green rating. The page shows distributions and top-N lists, and says how many rows each list leaves out.
