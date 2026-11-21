# Patterns as vocabulary

These are names for things a codebase may already do. They are background for describing an option fairly, and for recognising what the census found. None is a default, none is a goal, and a named pattern is chosen only when the evidence and the census support it. When the user asks "which pattern?", answer with the evidence and the options, never with a name.

Each entry says when it fits, what it costs, and which census row shows it. Indirection removes a static dependency at the price of discoverability, and agents navigate by references, so every entry from the third on costs navigability. The coupling it hides becomes hidden coupling: the imports go and the co-change stays.

## Adds nothing

**Move the symbol.** Fits when the symbol's consumers mostly sit on the other side (`misplacement`). Costs nothing. Census row: none, and none is needed.

**Accept the dependency and fix its direction.** Fits when co-change is high: the two sides share a design decision and should depend towards the more stable one, or be put together. Hiding a real dependency keeps its cost. Census row: none.

## Passing something in

**Callback or function parameter.** The depending side receives what it needs from its caller. Fits when the dependency is one or two operations. Costs a parameter, and the call site must supply it. Census row: `callbacks`.

**Interface owned by the stable side** (dependency inversion, the core of ports and adapters). The stable side declares what it needs and the volatile side implements it. Fits when a second implementation exists or is needed from a real requirement, not an anticipated one. Costs a type and an indirection to follow from the call to the implementation. Census rows: `interfaces`, and `ports-and-adapters` when the codebase names its folders that way.

## Indirection that hides the sender from the receiver

**Constructor or container injection.** An object is handed its collaborators and does not look them up. Fits when many objects need the same collaborators and the codebase already has a composition root or container. Costs a registration to keep in step and wiring that is no longer visible at the call. A container introduced for one dependency is machinery without a payoff. Census row: `dependency-injection`.

**Events (observer, publish and subscribe).** The sender announces and does not know its receivers. Fits when several receivers react independently, or the sender truly must not know them. Costs discoverability: from the `emit` there is no reference to the code that runs. An event that carries a command in disguise is a call that has lost its type checking. Census row: `events`.

**Mediator, command and query handlers.** Requests are sent by type or key to a handler that is registered elsewhere. Fits when there is one handler per request and the codebase already routes work through a bus. Costs the same discoverability, plus a registration for each handler. Census row: `handlers`.

**Registry or plugin map.** Implementations register under a key and are looked up by it. Fits when the set of implementations is open and chosen at runtime. Costs a string-keyed lookup that no tool can follow, and an order of registration that can matter. Registration by importing a module depends on import order and hides what is registered, so prefer an explicit contribution that is collected. Census row: `registries`.

## Choosing among them

1. Start with the first two. Most cycles come down to one or two symbols used in the wrong direction.
2. Prefer a mechanism the census shows near the boundary, even when another would be the textbook answer.
3. If the chosen mechanism has a zero census row, or appears only far from this boundary, it is new. Stop and ask, with the alternatives weighed and what each costs here (SKILL.md, Ask before introducing a mechanism).
