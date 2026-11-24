# The basis of the suite

Why the suite measures what it measures, where each idea comes from, and why the tooling is built the way it is. What each command prints is in its `--help`, in `explain <rule>` and in the skills' `references/`. How each language is read is in [languages.md](languages.md).

## The problem

Code is expensive to change when a change needs knowledge the code does not put in front of the person or agent making it: a second file that must change too, a function too tangled to hold in mind, a helper three folders away, a dependency that pulls in code that changes every week, an author who has left.

An agent pays these costs more directly than a person does. It works one file at a time, cannot recall what usually changes alongside, and pays for every hop in files opened, tokens read and chances to miss something. So the suite looks for the places where change is expensive, guides an agent through fixing them, and then measures whether later changes got cheaper.

Three positions shape everything else.

- **History shows cost, structure shows cause.** Static analysis shows how code is built. History shows how it is changed. A complex file that nobody touches costs nothing, and a complex file that changes every week is where the effort goes. Two files in different folders that always change together are a dependency whether or not an import says so.
- **A score is not an outcome.** Any score that is optimised alone gets gamed: complexity limits are met by splitting functions into shallow helpers, and distance scores by burying code. Each plugin therefore names an outcome that is measured from later history or from agent sessions, treats its own static score as a leading indicator, and names the check that shows the score being gamed.
- **Facts are mechanical, remedies are judgement.** Finding a cycle, a hotspot or a distant helper is mechanical, so a deterministic CLI does it. Choosing what to do about it depends on context the tool cannot see, so a skill holds the policy and the agent decides, recording its reasons.

## Where it applies

The suite is built for medium to large codebases in one repository: single applications, modular monoliths and monorepos, where the code that changes together lives in one history and depends through imports, includes or references. Distance, cohesion and co-change carry signal there, and an agent's navigation cost grows with size.

It is a poor fit for a repository per microservice. Each repository is small, so locality is trivially satisfied, and the coupling that matters crosses services through APIs, messages and shared schemas, which no import graph or single history shows. A monorepo of several services sits between: the plugins work inside each service, no move crosses a service boundary, and frequent co-change between services is reported as evidence of a distributed monolith without a remedy being proposed.

History-based signals need history. A codebase with years of commits and many contributors gives strong co-change evidence. In a young one a few shared commits cannot be told from chance, and much of the code has not had time to be reused. Every output that uses history therefore grades its evidence (see [Evidence strength](#evidence-strength)).

## Principles

1. **Outcomes over scores.** Each plugin names an outcome measure and a gaming check, as above.
2. **Determinism where mechanical, judgement where semantic.** The same repository, config and history give byte-identical JSON, so a result can be diffed, cached, tested against a golden file and trusted in CI. The agent's judgement is kept apart from it and is always recorded with a reason.
3. **CLIs report, they do not edit.** Analysis commands never modify code. The commands that do (locality's mover) are separate, plan by default and need `--apply`.
4. **One refactoring per commit.** Each applied change is one revertible step with tests passing before and after, so a reviewer never reads a move and a behaviour change together.
5. **Evidence beats convention.** Folder conventions, anticipated reuse, package diagrams and metric guidelines are hypotheses. History and consumers decide.
6. **Deep over shallow, and inline by default.** Remedies hide decisions behind simple interfaces. Inlining single-use indirection is a first-class remedy, and no plugin creates shared helpers or abstractions. The one stated exception is breaking a dependency, which sometimes needs an interface owned by the stable side.
7. **Scrutinise what is widely used.** High fan-in multiplies the cost of every flaw. A utility with many consumers has earned its location, and it is the first place to look for design problems.
8. **Built for agents, usable by people.** Output is compact, ranked and capped by default, because an agent should never receive a 5,000-row dump by accident. JSON is the contract and a table is the default in a terminal.
9. **Local and private.** No network access and no telemetry. Data about people is off by default, and each exception is stated and bounded (see [People](#people)).
10. **Self-contained plugins, composed by data.** No plugin needs another at run time. They share code at build time and read each other's stored results when those exist.
11. **Patterns emerge from the codebase.** Where a remedy needs a design mechanism (an interface, events, a mediator), the skill prefers what the codebase already uses nearby and asks before introducing anything new.
12. **Guidelines, not hard limits.** A number from CodeScene, a book or a judgement call orders and annotates results. It never hides, drops or fails them (see [Guidelines](#guidelines)).
13. **Language-agnostic first.** As much as possible works from history, indentation and lexical structure, which apply to every language and every past revision. Language adapters add precision where that cannot answer.

## Sources

The suite combines a small number of published ideas. Where it departs from a source, the departure is stated.

### Behavioural code analysis: Tornhill and CodeScene

Adam Tornhill's *Your Code as a Crime Scene* and *Software Design X-Rays*, and CodeScene, the product built on them, supply the history layer: hotspots (change frequency combined with complexity), temporal coupling, code age, the function-level X-Ray of a hotspot, knowledge maps, and the term *code health* for how easy code is to understand and change. Indentation as a language-neutral complexity proxy is Tornhill's too.

The suite departs from CodeScene in these ways:

- **No single score.** CodeScene derives one 1 to 10 code health score per file from 25 or more factors whose weights it does not publish. The suite reports each measure with its evidence and gives no composite, because a number whose weights cannot be seen cannot be argued with or acted on.
- **Guidelines annotate.** CodeScene's published defaults are used as guideline values, never as cut-offs.
- **Coupling is tested against chance.** Structure classifies a pair as high co-change with an exact test against what independence predicts, where code-maat and CodeScene use a minimum number of shared revisions and a minimum degree.
- **Generated and vendored code is detected.** CodeScene excludes by configured patterns. The suite also reads `.gitattributes` (`linguist-generated`, `linguist-vendored`), because it is the repository's own statement, and the header markers that generators write.
- **Fixes are counted per change that landed.** A fix made on a branch before it merged was caught in review and is not a regression, so it is listed apart as a fix during review and never counted as a fix.

### Design vocabulary: Ousterhout

John Ousterhout's *A Philosophy of Software Design* supplies the vocabulary for judgement. Its frame is that complexity is whatever makes a system hard to understand and change, showing up as change amplification, cognitive load and unknown unknowns, which is the same cost the suite measures. Its central idea, the **deep module** (a simple interface over a substantial implementation), reconciles the plugins: locality removes shallow indirection, complexity reduces cognitive load without scattering code into shallow helpers, and co-change shows the information leakage that shallow boundaries cause.

A metric says where to look. A red flag (shallow module, information leakage, pass-through method, temporal decomposition and the rest) names what is wrong and points at a remedy. `shared/red-flags.md` lists them with the mechanical signal each has, and every skill carries a copy. They are a vocabulary from one book, not a checklist that always produces work.

Following Ousterhout, length alone is not a problem. Function length is reported and ranked and has no guideline, because a long linear function is often clearer than five shallow fragments.

### Inlining: Carmack, Blow, Muratori

John Carmack's argument for inlined code (his 2007 email, republished in 2014) and Jonathan Blow's similar position are the basis for treating inlining as a design choice and not only a cleanup. Code read straight down shows what happens and in what order, and a call hides both. A function extracted before its second real use bakes in a guess about its interface, and undoing a wrong guess costs more than extracting late. Casey Muratori's *semantic compression* makes the same point from the other side: write the concrete code first and compress once real repetition shows its shape.

The **rule of three** is used as a prompt for judgement, never as a rule in either direction. Fewer than three uses is not by itself a reason to remove an abstraction, and three is not by itself a reason to create one. At the third instance the question is whether the pieces share a reason to change, and co-change answers it: call sites that change together justify a shared unit, and call sites that change independently are coincidental duplicates that a shared helper would couple.

### Cohesion: Constantine and Yourdon

Locality is cohesion made measurable: folder-tree distance between code and its consumers. The classic cohesion levels name what it finds. *Coincidental* cohesion is `utils/`, `helpers/` and `common/`, grouped by nothing. *Logical* is grouping by kind (`controllers/`, `models/`). *Temporal* is grouping by when code runs, which is Ousterhout's temporal decomposition. *Functional*, grouped by the one thing it does with its consumers nearby, is the target.

### Complexity metrics: McCabe, Campbell, Fowler

Cyclomatic complexity is McCabe's, and bounds the number of test paths, so it measures testability more than readability. Cognitive complexity follows G. Ann Campbell's SonarSource specification exactly, because it is documented, widely adopted and matches how hard code is to read, and following it exactly means results compare with a widely used tool and the definition is not argued over again. A *code smell* is used in Fowler's sense: a surface indication that usually corresponds to a deeper problem, and so a prompt to investigate, not a defect.

The maintainability index is left out, as a composite with opaque weights and no actionable remedy. Halstead metrics are not ranked or gated on.

### Dependencies and packages: Martin

Robert C. Martin's package principles (*Agile Software Development: Principles, Patterns, and Practices*, restated in *Clean Architecture*) supply structure's terms: instability `I = Ce / (Ca + Ce)`, abstractness, the main sequence, and the six principles. Three are about cohesion: release and reuse (REP), common closure (CCP) and common reuse (CRP). Three are about coupling: acyclic dependencies (ADP), stable dependencies (SDP) and stable abstractions (SAP). A package means what Martin means: a unit the build delivers, not a folder.

The principles were stated without the evidence to test them, and the suite has it. Co-change measures common closure directly, and consumer analysis measures common reuse. So each principle becomes a measurement with a cost attached, and a package that breaks one at no observable cost is left alone. Martin's metrics describe the graph. A package in the zone of pain that never changes is not in pain, so change frequency decides.

Cycles are reported with the smallest set of edges whose removal breaks them, a minimum feedback arc set. Small cycles are solved exactly and larger ones with the Eades, Lin and Smyth heuristic.

### Knowledge loss: Rigby and others

The abandonment analysis follows Rigby, Zhu, Donadelli and Mockus, *Quantifying and Mitigating Turnover-Induced Knowledge Loss* (ICSE 2016). A line is abandoned when its last author has left, and a file when at least 90 percent of its lines are. Turnover is simulated many times, which gives a distribution of loss and not one bus factor number, and risk is stated as *knowledge at risk*, a percentile of that distribution by analogy with value at risk. The paper found tail losses several times the expected loss, and found that simple truck-factor estimates overstate the potential loss. Successors are recommended from coordination requirements (Cataldo and others): people who work on related files.

### Change risk: Mockus and Weiss, Kamei, Bird

The factors of a branch's risk come from research on change-level risk, cut down to what git alone shows. Mockus and Weiss, *Predicting Risk of Software Changes* (2000): size, diffusion and the developer's experience. Kamei and others, *A Large-Scale Empirical Study of Just-in-Time Quality Assurance* (2013): the factor families of diffusion, size, purpose, history and experience. Bird and others, *Don't Touch My Code!* (2011): components changed by many low-ownership contributors fail more, which is why a change's author is compared with the code's owners.

These studies report associations in the projects they examined. Whether the factors separate risky changes in a given repository is an empirical question, so a risk level is shown only where a backtest on that repository's own history supports it.

## What each plugin rests on

### cochange

It asks where change effort concentrates and which files change together. Its choices:

- **Coupling over logical changes, not raw commits.** A change split over three commits is one change, and commit granularity varies by person. Grouping commits is opt-in, because the wrong grouping invents coupling.
- **Bulk changes carry no signal.** A change over the maximum changeset size (a formatting sweep, a licence header, a dependency bump) couples everything to everything, so it is left out of coupling and spread, and counted.
- **Percentile hotspot scores.** Absolute scores do not compare across repositories, and a raw product lets one huge file dominate.
- **Indentation as the default complexity.** It needs no parser, so the plugin stays small and a trend over hundreds of past revisions is cheap. When the complexity plugin has stored a result for the same commit, that is used and the output says so.
- **Filters apply at query time.** A config change gives a new answer without rebuilding the history cache.
- **Renames are followed**, so a moved file keeps its history. Locality moves files and its effect is measured through that history.
- **A pre-change briefing.** `cochange brief` names the files that usually change with the ones about to be edited, so an agent opens them deliberately and does not find them after tests fail.

Its skills for abandonment, change risk and identities share the history cache and answer different questions in different situations, which is why they are separate skills in one plugin.

Change risk reports how much of the codebase a branch touches and how well placed its author is in that code, and recommends how to review it. Rules set the level, not fitted weights: a fitted model would predict better and explain worse, and anyone can derive a rule-based level by hand. Bands are relative to the repository's own merged changes, because absolute sizes do not transfer between repositories. A factor that could not be computed is unavailable, never low, so missing data does not make a change look safer. The level is advice for review and never a gate: a level that blocks merges gets gamed, most cheaply by splitting a change into pieces that hide the same risk.

### complexity

It asks which functions are hard to understand. Its choices:

- **One plugin, many metrics.** All metrics share one parse, one definition of a function and one adapter per language, so their results line up. People ask "what is hard to understand here?", not "what is the cyclomatic complexity?".
- **Ranked by cognitive complexity.** A long keyword switch or a constructor with many parameters is an outlier of one metric and should not rank above a function that is hard to follow. A change-weighted order is offered for code that changes.
- **A ratchet, not a gate.** `complexity check` exits with 1 only when a new function is above a guideline or an existing one above a guideline got worse than at a base revision. A hard limit on an existing codebase produces a backlog nobody works through, or a blanket waiver.
- **Against a base revision, not a baseline file.** A committed file of every function's values would conflict on every merge, and the parse cache keyed by blob makes the base cheap to measure.
- **Moved code is followed.** A function renamed or moved is matched by body similarity, and an unmatched function counts as new, so moving code never hides a regression.
- **Interface depth is the gaming check.** A rising function count with falling interface depth after a simplification campaign shows the metric being met by splitting.

The remedy policy is the point of the plugin: prefer simplification that deletes (guard clauses, removing impossible branches, defining errors out of existence), prefer deepening to splitting, keep any extraction local and private, and never restructure only to pass a guideline.

### locality

It asks which code lives far from the code that uses it. Distance mostly arrives through folder conventions and anticipated reuse that never happened, so the plugin tests the reuse claim against consumers and history and removes the distance where the evidence is missing. Its choices:

- **Usage and change are both evidence, and change wins.** Consumers in one place are usage cohesion and co-change is change cohesion. When they disagree, change evidence decides, because the cost the suite measures is the cost of change.
- **Widely used code is reviewed, not moved.** High fan-in earns a unit its distance. It is a fixed guideline of 8 consumers and not a percentile, because a percentile would mark the top few units of every repository whatever their fan-in.
- **Production consumers decide where code goes.** Tests decide whether to inline, since a unit with its own tests may be a deliberate seam, and tests move with their unit.
- **The layout is preserved.** A target is an existing folder, a tie goes to the current folder, and a move with no gain is never proposed.
- **Young code gets a grace period**, because it has had no time to be reused.
- **Moves are deterministic and are only moves.** The mover plans by default, and a move commit changes no behaviour and, in C#, no names: making namespaces follow folders is a separate optional commit, because reflection, serialisation and dependency injection by name can all see a namespace.
- **Moves do not cross package boundaries.** Whether the packages are the right ones is the packaging skill's question.

### structure

It asks which dependencies make change expensive: import cycles, imports that break declared layer rules, and dependencies pointing from stable code towards volatile code. It says which dependency to break and where, and does not say how. Its choices:

- **Evidence, not prescriptions.** The right remedy might be moving a misplaced function, passing a callback, inverting through an interface or introducing an event. Making that choice mechanical would make it wrong by default, so each problem dependency gets an evidence pack for the agent to judge.
- **A census of what the codebase already does.** It inventories the decoupling mechanisms in use (callbacks, interfaces, injection, events, handlers, registries), so a remedy stays consistent with them and anything new needs the user's agreement.
- **Change stability outranks structural stability.** Instability describes the graph and revisions describe what happens.
- **Coupling quadrants.** Static coupling and co-change measure different things, and together they say what a dependency costs: *real* (both high: the sides share a decision, so co-locate them and do not hide it behind indirection), *incidental* (entangled but changing independently: cheap to break), *stable* (healthy) and *hidden* (co-change with no static dependency).
- **Hidden coupling is measured.** A dependency "broken" through events or a string-keyed registry often keeps its co-change. Without that check, indirection looks like success, so a broken cycle with unchanged co-change is reported as hidden, not broken.
- **Layer rules are the user's own.** They are the one place a finding is called a violation and gated on, because the user wrote the rule.

The packaging skill asks the locality question one level up, where a wrong answer costs more: a misplaced file costs a reader a hop, and a misplaced package boundary costs a version, a build step and a change made in two places and released in order. Packages are easy to create and hard to remove, so fewer packages is the default, which is the inline-by-default principle at package level. A boundary is kept for reuse, for independent change or for a declared purpose. Ownership, build time and enforcement are real reasons that no repository evidence shows, so the skill asks what a package is for and records the answer. Published packages are reported and never proposed for change, because their consumers are outside the repository.

## Guidelines

Many measures have a value that practice or the literature treats as worth a look: four levels of nesting, a cognitive complexity of 15, 80 percent confidence. The suite uses such a value as a guideline and never as a cut-off.

- **Annotate, do not decide.** A result carries its measured value and where it sits against the guideline, and results are sorted by how far past it they are.
- **Cap, do not filter.** A result below a guideline is still listed. Output is cut only by an explicit, overridable limit, and says how many rows the limit left out.
- **Evidence floors are the exception.** A statistic that means nothing below some sample size keeps a minimum: coupling from one shared commit, or a significance test on a handful of tasks. Below the floor an item is marked low confidence and still listed where it can be.
- **Gates are explicit.** Exit code 1 belongs to the commands a user runs as a gate (`complexity check`, `structure check`, a move verification). A finding above a guideline never sets it.
- **Every default records its source**: a CodeScene document, a book or a judgement call. Judgement calls are named as such, and all are configurable.
- **Wording.** Findings say "worth a look" or "above guideline", not "violation" or "too complex".

The reason is that a cut-off turns a heuristic into a verdict. It hides the row just under it, fails a build over a number nobody calibrated for this codebase, and invites the cheapest change that moves the number.

## Evidence strength

Every output that uses history carries an evidence block: months of usable history, logical changes in the window, active contributors, and a grade of strong, moderate or weak. Each finding also carries the support behind it. With weak evidence the skills rely on static signals and present history-based findings as tentative. With strong evidence, co-change wins where it disagrees with static structure.

Usable history leaves out an imported beginning (a first commit that adds a large share of the tree) and reports a shallow clone as truncated. A change of merge policy changes what a commit means, so a shift in commit size is reported.

Time is measured back from HEAD's committer date and never from the wall clock, so the same commit gives the same result on any day.

## Measuring whether it worked

Each plugin has an outcome measure, and they share the instruments.

| Plugin | Outcome | Gaming check |
|---|---|---|
| cochange | Change spread on files in acted-on findings | |
| complexity | Change cost and fix rate in acted-on functions | Function count against mean interface depth |
| locality | Agent effort on tasks that touch the moved code | Single-file folders and maximum depth |
| structure | Co-change between the two sides of a broken dependency | Hidden coupling created |

- **Change spread** is the mean pairwise folder-tree distance of the files in one logical change. Each file is placed at its path as of that change, so a later move never rewrites the spread of earlier changes.
- **Agent effort** is files read, folders visited, re-reads and tokens per task, read from Claude Code session transcripts. Only paths and counts are extracted, and every figure is a lower bound, because work done inside scripts and builds is not seen. The same bias applies before and after, which a comparison relies on.
- **A comparison group.** Findings are acted on because they are extreme, and extreme values drift back towards the average when left alone. So each comparison sets the acted-on files beside candidates of similar rank that were left alone, and reports the difference between the groups, not the raw before and after.
- **Matching windows**, with the same filters, and sample sizes stated. A skill does not claim an effect the data cannot show.
- **The suite's own commits are left out.** Refactoring commits made through the skills carry a `Code-Health:` trailer and are excluded from outcome windows, since a move commit is wide by construction.
- **Independence.** A measure that a tool moves by construction is only a leading indicator for that tool. Co-locating files that change together lowers change spread by definition, so for locality the independent outcome is agent effort, and a fall in spread without a fall in effort is reported as unproven.

## Why it is built this way

- **Plugins with a CLI and a skill, and no MCP server.** The work is batch-shaped, a CLI can be tested and run in CI, and nothing costs context until a skill calls it.
- **No hooks.** Nothing is injected into a session that the user did not ask for. Claude runs a CLI when a skill directs it to.
- **One skill per question a user asks**, not per command, with a description in the user's terms. Long explanations sit in `references/` and load on demand, because every line of `SKILL.md` is a recurring token cost.
- **Self-contained bundles.** An installed plugin is a copy of its folder and nothing outside it, with no install step. So each CLI is bundled with its shared packages into one file with no external dependencies, and the bundle is committed. CI rebuilds it and fails when it differs from its source.
- **Three layers, each working without the ones above.** History covers every file in every language. The lexical layer (indentation, plus a lexer profile per language family) covers any text file and any past revision without parsing. The structural layer (a tree-sitter grammar and a language adapter) gives exact units, resolved dependencies and deterministic moves. Every value says which layer produced it. For languages that have both, the structural layer is the ground truth the lexical one is measured against, and per-function lexical values are reported only where the measured agreement is high enough.
- **Grammars as WebAssembly**, so there are no native builds and a plugin runs wherever Node does.
- **One config file for the repository**, `code-health.json`, because exclusions, test patterns and the history window belong to the repository and should be the same for every plugin. An unknown key is an error, so a misspelt setting fails loudly.
- **Caches that can always be deleted.** Commits are stored by SHA and parse results by blob, so neither is ever invalidated, and a stored result is reused only when its commit, config, code and inputs all match. State that cannot be regenerated (measurement baselines, local identity decisions) lives apart from the cache.
- **Reports separate data from judgement.** The CLI computes every number and renders the page. The agent writes only the judgement, into slots the CLI defines, against a stamp that ties the notes to the commit and config they were written for. A report shows guidelines as legend values beside the numbers and never as one score or a red, yellow and green rating.
- **Sociable tests on real repositories.** Tests build real git repositories with fixed dates and run the real CLI, and every JSON output has a golden file and a schema. A language counts as supported only when hand-counted conformance fixtures pass for every plugin.

## People

The suite measures code, not people.

- Default outputs contain no author identities. Counts are per file and per component.
- The knowledge analysis is off until the repository's config turns it on. It models random turnover only: it never predicts who will leave, never ranks people by the loss their departure would cause, and names only active developers, as suggested successors or reviewers, when asked to.
- A change's risk includes its author's placement in the touched code. That describes one change, by default the author's own, and is never aggregated per person.
- Identity resolution necessarily shows names and emails. It shows only what `git log` shows, uses git history alone, and its output is never stored where another plugin could read it.
- The skills decline to use any of this to assess individuals, and say why.
