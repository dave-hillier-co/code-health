# Contributing

The specs in `docs/specs/` are the source of truth, starting with `docs/specs/suite.md`. This file says how to work in the repository: how to add a plugin, a command or a skill, and which checks gate a change. `README.md` describes the layout.

## Working rules

- TypeScript ESM, no `index.ts` barrel files. Import modules by their real path.
- Classic TDD with sociable tests: real fixture git repositories (`fixtures/git-fixture.ts`) and the real CLI, mocks only at process boundaries.
- JSON is the CLI contract. Every command's `--json` output has a golden file and a JSON Schema.
- Output is deterministic: no wall clock, no listing order, no absolute paths in results.
- Install packages with the npm CLI (`npm install <pkg> -w <workspace>`), never by editing `package.json`.
- One logical change per commit. Run `npm run check` before committing.
- A change under `plugins/<plugin>/` needs a version bump in that plugin's `plugin.json` and a rebuilt, committed `dist/` (`npm run build`). The version lives in `plugin.json` only, never in the marketplace entry.
- Evergreen content only in `README.md`, `CONTRIBUTING.md` and the specs: no status updates.

## Adding a plugin

```
npm run new-plugin -- <name> --description "<one sentence>" [--parses]
npm install
npm run build
npm test
```

`<name>` is kebab-case and must not start with `claude-`, `anthropic-` or `cc-plugin-`. Pass `--parses` when the plugin needs syntax trees. `npm install` links the new workspace and updates the lock file, so commit `package-lock.json` with the plugin.

The scaffold (`scripts/new-plugin.mjs`, templates in `scripts/templates/plugin/`) creates:

| Path | Purpose |
|---|---|
| `plugins/<p>/.claude-plugin/plugin.json` | Manifest, version `0.1.0`. Author, license, repository and engines are copied from an existing plugin. |
| `.claude-plugin/marketplace.json` | A new entry with `name`, `source` and `description`, and no version. |
| `plugins/<p>/schemas/common.schema.json` | The envelope shared by every command schema, with `tool` fixed to `<p>`. |
| `plugins/<p>/schemas/<command>.schema.json` | Schema of the placeholder command. |
| `packages/<p>/package.json`, `tsconfig.json` | A private workspace named `@code-health/<p>`. |
| `packages/<p>/src/main.ts` | The CLI entry. `scripts/bundle.mjs` bundles every plugin whose `packages/<p>/src/main.ts` exists, to `plugins/<p>/dist/<p>.mjs`. |
| `packages/<p>/src/{cli,tool,config,commands}.ts` | CLI definition, tool name and schema version, config section, command list. |
| `packages/<p>/src/commands/<command>.ts` | One placeholder command (`describe`, or `parse` with `--parses`). Replace it with the plugin's first real command. |
| `packages/<p>/test/` | A runner (`support/run.ts`) and a test of the placeholder command. |

### Commands

A command is a module in `packages/<p>/src/commands/` exporting `name`, `command` and optionally `rules`. Add it to `commandModules` in `commands.ts`, one import and one list entry in alphabetical order. Commands that read history use `analysisCommand` as `packages/cochange/src/analysis-command.ts` does. Reuse the shared packages (`cli-kit`, `history`, `lexical`, `parse`, `graph`) before writing a capability: if a package already does it, import it.

Every command gets:

1. a schema `plugins/<p>/schemas/<command>.schema.json` composing `common.schema.json`,
2. golden outputs at `packages/<p>/test/golden/<scenario>/<command>[.<variant>].json`, written through `expectGoldenIn` from `@code-health/fixtures/cli-testing` (wrap it as `packages/cochange/test/support/golden.ts` does) and refreshed with `UPDATE_GOLDEN=1`, with the diff reviewed,
3. a test that runs the CLI in-process with `runInProcess` from the same module.

`npm run check:schemas` compiles every schema and validates every golden against the schema named by its file name. Scenario folders starting with an underscore are exempt.

### Plugins that parse

A plugin parses when its bundle includes `packages/parse/src/grammars.ts`, directly or through another package. The build detects this and copies the tree-sitter `.wasm` files into `plugins/<p>/dist/grammars/` with `copyGrammars` from `packages/parse/src/copy-grammars.ts`. Nothing else is needed in the plugin:

- Load grammars with `loadGrammar` from `@code-health/parse/grammars`. It resolves `grammars/` relative to `import.meta.url`, so the installed bundle finds them beside itself, and falls back to the npm packages when running from source.
- The `dist/grammars/` files are committed, and `npm run check:dist` fails when they differ from a fresh build or exist for a plugin that does not parse.
- `scripts/test/new-plugin.test.ts` shows the check to copy for a new parsing plugin: build, copy `dist/` to a directory with no `node_modules`, run the bundled CLI there to parse a file.

### Bundles

Bundles import only Node builtins and install without `npm install`. Do not add runtime dependencies that cannot be bundled, and do not read files by repository-relative path at run time: anything a bundle needs ships in `dist/` and is found through `import.meta.url`.

## Skills

A skill lives at `plugins/<p>/skills/<skill>/`. `npm run check:skills` enforces these conventions:

- `SKILL.md` has YAML frontmatter and at most 500 lines. Workflow, decision policy and commit discipline go in `SKILL.md`; thresholds and long explanations go in `references/`.
- `name` equals the folder name.
- `description` is required, at most 1024 characters, and says when to use the skill in the user's terms ("before refactoring", "code that is hard to change"), not what the CLI does. Trigger evals cover it.
- `allowed-tools` is exactly one entry, the plugin's own CLI: `Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/<p>.mjs *)`. Never anything broader.
- `${CLAUDE_PLUGIN_ROOT}` is substituted in skill text but is not set in the environment of the commands the skill runs, so write the CLI path out in full in the skill text.
- `references/` holds Markdown only. Link from `SKILL.md` with relative paths (`references/<file>.md`); the check fails on a link that does not resolve.
- `references/red-flags.md` is generated. See below.

```
---
name: <skill>
description: <When the user ...>
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/<p>.mjs *)
---
```

### Shared red flags

`shared/red-flags.md` is the single source of the design vocabulary. `npm run build` copies it byte for byte to `plugins/*/skills/*/references/red-flags.md`, and `npm run check:red-flags` (part of `npm run check` and CI) fails when a copy differs or is missing. Edit only the shared file, then build and commit the copies together with a version bump for every plugin whose skill changed. Specs link to `shared/red-flags.md`.

## Evals

Skill evals run with `claude plugin eval`, which bills tokens, so they run on demand and before a release and never in CI. Cases live at `plugins/<p>/evals/<case>/case.yaml`, one folder per case, and ship with the plugin.

- Format: `schema_version: "1.0"`, `name` (equal to the folder name), `execution.prompt`, `execution.model`, optional `runs`, `max_turns`, `timeout_seconds`, `tags`, and at least one grader (`regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, `baseline`) with unique names. `scripts/eval-case.schema.json` is the schema `claude plugin eval` loads against. `plugins/cochange/evals/trigger-hotspots/case.yaml` is a minimal example, and `briefing-before-change` one with a scaffolded repository.
- Use `case.yaml`, not the `prompt.md` form, because only `case.yaml` can pin the model.
- A case that needs a repository sets `context.scaffold_script`, which runs only when `--scaffold` is passed. List the tools a case needs in `execution.allowed_tools`, and grant them with `--allow-tools`: `npm run evals -- <plugin> -- --scaffold --allow-tools Bash,Read,Edit,Write,Grep,Glob`.
- `shared/evals.json` pins `model`, `judgeModel` and `maxCostUsd`. Every case sets `execution.model` to the pinned model, and `npm run check:evals` (part of `npm run check` and CI) validates every case without running it.
- Cover triggering (the skill loads on relevant prompts and not on unrelated ones) and behaviour (it runs the CLI, respects commit discipline, cites red flags).
- A behaviour case that needs a repository sets `context.scaffold_script` to a script in its own folder that builds one in the working directory. Claude Code runs it only with `--scaffold`. Give the script a fixed history (explicit dates), and test it: `scripts/test/cochange-evals.test.ts` runs the scripts and checks the CLI's answers against what the graders look for.
- A grader on `Bash`, `Edit` or `Write` cannot pass unless the case lists the tool in `execution.allowed_tools` and the operator grants it with `--allow-tools`. List `Edit` and `Write` in a case that asserts the agent made no edits, or the assertion proves nothing.

Run them with:

```
npm run evals -- <plugin>               # billed; model, judge model and cost ceiling from shared/evals.json
npm run evals -- <plugin> --validate    # cost ceiling 0: Claude Code loads and validates every case, nothing is billed
npm run evals -- <plugin> -- --case <glob> --runs 1   # options after the second -- go to claude plugin eval
npm run evals -- <plugin> -- --scaffold --allow-tools Bash Edit Write   # behaviour cases: build their repositories and grant their tools
```

A case that needs a repository sets `context.scaffold_script` (a script that builds it in the working directory), and a case that edits files or runs commands lists those tools in `execution.allowed_tools`. Claude Code runs neither unless the operator opts in: `npm run evals -- <plugin> -- --scaffold --allow-tools Bash Write Edit`.

Results and the HTML report are written to `.cache/evals/<plugin>/`, outside the plugin folder. The runner refuses to run when `CI` is set.

## Checks

`npm run check` runs typecheck, tests, and these gates, which CI also runs:

| Command | Fails when |
|---|---|
| `npm run check:dist` | a committed bundle or `dist/grammars` differs from a fresh build |
| `npm run check:red-flags` | a skill's `references/red-flags.md` differs from `shared/red-flags.md` |
| `npm run check:skills` | a skill breaks the conventions above |
| `npm run check:evals` | an eval case is invalid or does not use the pinned model |
| `npm run check:schemas` | a schema does not compile or a golden does not match it |
| `npm run check:plugins` | `claude plugin validate --strict` reports a problem (skipped locally without the `claude` CLI, required in CI) |
| `npm run check:version-bump -- --base <ref>` | a change under `plugins/<p>/` since the merge base does not bump that plugin's version (CI) |
