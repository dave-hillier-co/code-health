# Scrutinising widely used units

A unit with many consumers has earned its location. It has also earned scrutiny, because every flaw in it is multiplied by its consumers. A `scrutinise` recommendation sends the unit here instead of moving it.

Report findings with the red flag named. A fix is a normal refactoring with its own commit and tests, and any change to the interface is reviewed with every consumer in view.

## Start from the evidence pack

```
node ${CLAUDE_PLUGIN_ROOT}/dist/locality.mjs scrutinise --json
```

It covers every unit the analyser sent here. Name paths to limit it (`scrutinise src/shared/text.ts`); naming a unit the analyser did not send here reviews it anyway, with `reason: requested`. For each unit it finds the references to every exported function and reports:

- `findings`: red flags with the counts they rest on, each with the consumer files it comes from.
  - `special-general-mixture`: a boolean or string-literal-union parameter, with what call sites pass for it. When every call site passes the same literal, the other branch serves no caller.
  - `overexposure`: a parameter that fewer than half of the call sites pass.
  - `divergent-use`: call sites in two or more files that call a method on the result, fall back with `??` or `||`, cast it, or wrap the unit in a function that fixes some arguments. The unit may be doing the wrong thing for them.
  - `shallow-module`: two or more parameters in front of a one-statement body.
  - `pass-through-method` and `vague-name`: what the analyser's signals saw in the file.
- `hints`: lines to read against every caller's assumptions, by kind and line: `locale`, `time-zone`, `nondeterministic`, `mutates-argument`, `throws`, `swallows-errors`. They are pattern matches. A hint is a place to look, not a defect.
- `exports`: per exported function, its parameters with what call sites pass, its call sites, consumers and `postProcessed` calls with file and line, and `testCallSites` (tests are never counted as consumers).
- `notes`: `consumers-in-one-folder` says the unit may be misplaced rather than shared.

Every finding is a claim to confirm. Open the call sites it names and read them before reporting it, and drop the ones the code does not bear out. Calls through a value (`items.map(fn)`) show up as `valueReferences`, and calls the analysis cannot see (dynamic access, other languages) are not counted, so a count is a floor.

## Checklist

1. **Red flags** (see `red-flags.md`). Look first for:
   - *shallow module*: the interface is nearly as complex as the implementation.
   - *special-general mixture*: caller-specific flags or branches. The CLI's `special-general-mixture` signal names boolean parameters, but read the body for mode switches and type checks on the caller too.
   - *overexposure*: options most callers never pass. The `overexposure` signal names exports nobody uses.
   - *pass-through method* and *vague name*.
2. **Correctness under all callers.** Find the edge cases one caller relies on and another violates: null and empty inputs, time zones, locale, error handling, mutation of arguments.
3. **Divergent use.** Consumers that wrap, post-process or partly re-implement the unit suggest it does the wrong thing for them. List them.
4. **Standard-library overlap.** Note it for later. Replacing wrappers with idioms is out of scope here.

## What the output is

A short list: each finding, the red flag it shows, the consumers affected, and the smallest change that would deepen the module. Prefer changes that hide more behind the interface (merge shallow pieces, pull special cases up to callers, choose better defaults) over extracting new helpers. Do not create new shared abstractions.

If the consumers all sit in one folder, the unit may be misplaced rather than shared: say so, and treat it as a move candidate once the interface is settled.
