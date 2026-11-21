# Remedies

The questions in SKILL.md pick the remedy. This is the background for each answer. No pattern here is a default: choose one only when the evidence and the codebase's own mechanisms support it.

## Options, in the order to consider them

1. **Move the symbol.** It sits on the wrong side. Adds nothing. A move is its own commit.
2. **Remove the dependency.** The import is dead, or a type is imported only for convenience.
3. **Pass a value or a callback.** The depending side receives what it needs from its caller. Fits when the dependency is one or two symbols. Costs a parameter.
4. **An interface owned by the stable side.** The volatile side implements it. Fits when several implementations exist or are expected from real needs, not anticipated ones. Costs a type and an indirection to follow.
5. **Indirection through events, a mediator, handlers or a registry.** Fits when the sender must not know its receivers at all and the codebase already works that way. Costs discoverability: references disappear, co-change stays, and the coupling becomes hidden. Agents navigate by references, so this costs them most.

## Vocabulary

- **Information leakage**: one design decision written in two modules. The cure is to put the decision in one place.
- **Stable dependencies principle**: depend towards code that changes less. A stable module depending on a volatile one must change with it.
- **Hidden coupling**: co-change between modules with no import between them. It is what a dependency "broken" by indirection often becomes.
- **Mediator, observer, ports and adapters**: background names for options 4 and 5. Each fits when the evidence supports it and the census shows the codebase already uses it. `patterns.md` says when each fits and what it costs.

## When to stop and ask

If the mechanism you would choose has a zero row in `structure census`, or is used only in folders far from this boundary (`nearbyMechanisms`), ask the user before writing it. State the alternatives you weighed, including moving or passing a value, and what the evidence says for each. Do not introduce a mechanism because it is the usual answer. `mechanisms.md` explains how to read the census, including what it cannot see.

## Registration hubs

A central file that every feature must edit (route tables, menus, handler maps, module lists) is a one-to-many dependency from a stable mechanism onto volatile features. The remedy family is inverting the registration: each feature owns its contribution and the hub only collects. How it collects is the judgement call. Prefer what the framework already supports (file-system routing, build-time globbing), then feature-owned declarative contributions, then a registry the codebase already has. Prefer declarative over registration by side effect on import, keep an overview of the whole (a generated or tested view), and keep ordering and permissions as explicit fields, never implicit in discovery order. `structure hubs` finds them, and `registration-hubs.md` has the full guidance.
