# Remedies

Work from the top and stop when the function is clear. Each remedy names the red flag it answers (see
[red-flags.md](red-flags.md)). Every change is its own commit, with tests passing before and after.

## 1. Simplify by deleting

**Guard clauses.** Nested conditions that exist only to protect the main path become early returns. The main path ends at
the left margin and each guard costs 1 instead of its depth.

```ts
// before: cognitive 6
function ship(order: Order) {
  if (order.paid) {
    if (order.items.length > 0) {
      if (!order.hold) {
        dispatch(order);
      }
    }
  }
}

// after: cognitive 3
function ship(order: Order) {
  if (!order.paid) return;
  if (order.items.length === 0) return;
  if (order.hold) return;
  dispatch(order);
}
```

Red flag: *nonobvious code*.

**Dead and impossible branches.** A branch the types or callers rule out is a decision nobody takes. Delete it. Check the
callers first, and prefer to make the impossible state unrepresentable.

**Flag parameters.** A boolean that selects between two behaviours is a *special-general mixture*: the function does two
things, and its callers each want one. Give the callers two paths (two functions, or the call and the inlined
alternative), and delete the flag. This is the one case where creating a function is right, because it replaces a branch
with a name.

**Define errors out of existence.** If a failure case can be made impossible, or turned into a normal result, remove the
branch that handles it. `slice` past the end returns fewer items instead of throwing. An empty list is not an error.

**Use the standard library.** A hand-written loop that is `filter`, `some`, `find`, `Object.fromEntries`, `Array.from`,
`Map.groupBy` or `Set` arithmetic loses its counters, flags and nesting.

## 2. Flatten in place

- Return early, invert a condition to drop the `else`.
- Merge branches that do the same thing. `if (a) x(); else if (b) x();` is `if (a || b) x();`.
- Replace a loop that builds a result with a conditional inside it by a filter or a map.
- Hoist a condition that is tested in every iteration or every branch to before the loop or the branches.
- Replace a chain of `else if` on one value by a `switch` (flat, and each case costs nothing in cognitive terms) when the
  branches are genuinely a choice among alternatives.
- Remove temporary flags that carry a result out of a loop: return from inside it instead.

A **bumpy road** (several separate chunks of nested logic) is first a candidate for these. Each bump is a responsibility
that has not been named. Most bumps flatten with a guard clause. Only a bump that is a distinct responsibility becomes a
function.

## 3. Deepen rather than split

When a function cannot be simplified further and is still hard to read, a split may be right. The extracted piece must be
deep: it hides a decision, has a small interface, and can be named without "and". It stays in the same file and is
not exported, unless consumers or co-change evidence say otherwise.

A good extraction:

- takes few parameters and returns one thing,
- needs no knowledge of the caller's locals,
- has a name that says what it decides (`isEligibleForRefund`, `pickShippingTier`), not what it does step by step,
- removes more complexity from the caller than it adds anywhere.

A bad extraction, which the review rejects:

- `handleStep1`, `processPart2`, or any name taken from the order of events (*temporal decomposition*),
- a helper called once whose body the reader must read to understand the caller (*shallow module*),
- a function that forwards its arguments to another (*pass-through method*),
- a helper that takes the caller's state as five parameters, or a context object built just to carry them,
- one function per bump with the same nesting inside each.

## 4. Refuse these, they only move the score

- **Lookup tables that encode the same branching.** `const handlers = { a: () => ..., b: () => ... }` replacing a `switch`
  that has the same cases and the same bodies has moved the branches. Table-driven dispatch is a remedy when the table is
  data (a mapping from value to value, or to a name) and the logic is shared. It is not one when each entry is its own code.
- **Named booleans used once.** `const isEligible = a && b && c;` followed by a single `if (isEligible)` splits one
  sequence across two lines. It reads better only when the name says something the expression does not.
- **Splitting to pass a threshold.** A function cut in two at an arbitrary line, with the second half taking all of the
  first half's locals, scores lower and reads worse.
- **Chained helpers.** `a()` calls `b()` calls `c()`, each doing a third of the work, makes a reader hold three functions
  to understand one.
- **Suppressing the label.** An override in `code-health.json` for a function that is simply complicated.

If the branching is still there, so is the complexity. Say so in the review.

## 5. Inline

Carmack and Blow: code read straight down, with its state and order visible, is often clearer than a chain of single-use
calls. Inline a function that is called from one place, that forwards its arguments, or that exists only to give a
threshold a lower number. After inlining, check whether the caller got worse: if it did, the helper was earning its
place.

## When to leave it

- The function is long and linear: a sequence of steps with no branching. Length is not a problem.
- It is a flat `switch` or table of independent guards, with a high cyclomatic score and a low cognitive one. Test it,
  do not rewrite it.
- It has not changed in a year and nothing depends on understanding it.
- The only available remedy is one of the ones above that games the metric.

Record why in your report. Leaving code alone for a stated reason is a result.
