# Design Red Flags — Shared Reference

Part of the code-health suite. The red flags come from John Ousterhout's *A Philosophy of Software Design*. Every skill ships a copy of this reference, in `skills/<name>/references/red-flags.md`, generated from one source file at build time. Each tool stays self-contained and they all use the same vocabulary.

## Why red flags

The CLIs measure. Red flags give the agent a vocabulary for judgement. A metric says *where* to look. A red flag names *what is wrong* and points at the remedy. Ousterhout's frame is complexity as anything that makes a system hard to understand and change, showing up as change amplification, cognitive load and unknown unknowns. That is the same outcome this suite measures, so the two fit.

The central idea is **deep modules**: a simple interface over a substantial implementation. It reconciles the suite's tools. Locality removes shallow indirection, complexity reduces cognitive load without scattering code into shallow helpers, and co-change exposes the leakage that shallow boundaries cause.

## The red flags

For each flag, the table gives the suite's mechanical signal, if there is one, and the tool that emits it. The skill's review supplies the judgement in every case. A signal raises a flag for review. It never proves one.

| Red flag | Meaning | Mechanical signal | Emitted by |
|---|---|---|---|
| **Shallow module** | Interface nearly as complex as its implementation, so it hides little | Low ratio of implementation size (AST nodes) to interface size (exported symbols plus parameters) | complexity |
| **Information leakage** | One design decision is reflected in several modules | Distant or asymmetric temporal coupling | cochange |
| **Temporal decomposition** | Structure follows the order things happen rather than what each part knows | Coupled files named after phases (`parse`/`validate`/`save`) that always change together | cochange (heuristic) |
| **Overexposure** | Callers must know about rarely used features to use common ones | Exported symbols with no outside consumers; many optional parameters | locality, complexity |
| **Pass-through method** | A method that only forwards its arguments to another with a similar signature | Body is a single call or return of a call, with the parameters forwarded unchanged | complexity, locality |
| **Repetition** | The same nontrivial code appears in several places | Out of scope for detection; noted when seen. The third instance is when to *consider* removing it, judged on whether the copies share a reason to change (co-change). It is not a mandate. | — |
| **Special-general mixture** | Special-purpose code mixed into a general-purpose mechanism | Utility with many callers containing caller-specific branches (flags, mode parameters, type switches on caller types) | locality (heuristic) |
| **Conjoined methods** | Two pieces of code cannot be understood independently | High co-change between two files (cochange), with static references in both directions (structure) | cochange, structure |
| **Comment repeats code** | The comment says what the code already says | None reliable; judgement only | — |
| **Implementation documentation contaminates interface** | Interface docs describe internals callers do not need | None reliable; judgement only | — |
| **Vague name** | A name too generic to convey meaning (`data`, `manager`, `util`, `helper`, `handle`) | Identifiers (complexity), and files and folders (locality), matching the suite-wide `vagueNames` list: `utils`, `helpers`, `common`, `misc` and the like | locality, complexity |
| **Hard to pick name** | Difficulty naming suggests the thing lacks a clean design | None; judgement only | — |
| **Hard to describe** | The documentation has to be long to be complete | Long doc comment relative to function size | complexity (heuristic) |
| **Nonobvious code** | Behaviour or meaning cannot be understood quickly | High cognitive complexity; deep nesting | complexity |

## How skills use the red flags

1. **Name the flag.** Each finding the agent reports or acts on cites the red flag it judges present, or states that none applies. A finding with no red flag and no outcome evidence is a candidate for dismissal.
2. **Prefer deepening to splitting.** When reducing complexity, the preferred moves are those that hide more behind an interface: merging shallow pieces, pulling special cases up to callers, defining errors out of existence, choosing better defaults. Extracting a helper is acceptable only when the result is deep, and it stays local (same file, module-private) unless co-change evidence says otherwise.
3. **Inlining is a legitimate remedy.** Following Carmack and Blow, code read straight down, with its state and order visible, is often clearer than a chain of single-use calls. Removing a shallow layer by inlining it deepens what remains.
4. **Scrutinise what is widely used.** A defect, a leaky interface or a special-general mixture in a utility with many consumers is multiplied by every consumer. High fan-in justifies the utility's location (the locality tool reviews such a unit and does not move it), and it also makes the utility the first place to look for red flags.
5. **Record overrides.** When the agent goes against a mechanical recommendation because of a red flag, or ignores a signal it judges a false positive, the commit message or report records the flag and the reason.

## Limits

- The red flags are heuristics from one book. They are a vocabulary, not a rulebook. The skill must not treat them as a checklist that always produces work.
- Several flags conflict with common lint advice, for example "functions should be short". The suite sides with Ousterhout: length alone is not a problem, and shallow decomposition is.
- Mechanical signals have false positives by design. They are tuned for recall, and the skill supplies the precision.
