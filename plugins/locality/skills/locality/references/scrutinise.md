# Scrutinising widely used units

A unit with many consumers has earned its location. It has also earned scrutiny, because every flaw in it is multiplied by its consumers. A `scrutinise` recommendation sends the unit here instead of moving it.

Report findings with the red flag named. A fix is a normal refactoring with its own commit and tests, and any change to the interface is reviewed with every consumer in view.

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
