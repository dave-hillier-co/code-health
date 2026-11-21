# The mechanism census

`structure census --json` inventories how the codebase already separates one piece of code from another. It describes and does not judge: it never says a mechanism is good, and a count of zero is a finding, because choosing a mechanism the codebase does not use is introducing something new.

There is one row per mechanism, always in this order, including the ones with a count of zero. Each row has `count`, `files`, `variants` (the forms found), `folders` (the folders involved, most first) and up to three `examples` with the path, line and what was found.

## What each row counts

| Mechanism | What is counted | Variants |
|---|---|---|
| `callbacks` | A function with a function-typed parameter that is called from a different folder. The parameter may be an inline function type or an alias of one, in the same file or another. | `function-parameter` |
| `interfaces` | An interface or abstract class that a class in a different folder implements or extends. One entry per interface, naming the folders of its implementers. | `interface` |
| `dependency-injection` | Injection decorators (`@Injectable`, `@Inject`, `@Module`, `@Singleton` and similar), registration calls on something named like a container, injector, kernel or ioc, and a constructor that takes an interface or abstract class declared in another folder. | `decorator`, `container-registration`, `constructor-injection` |
| `events` | `emit`, `on`, `once`, `off`, `subscribe`, `publish`, `dispatch`, `trigger` and listener calls, with the platform's own emitters left out (`process.on`, `window.on`), and classes or `new` expressions of an event-emitter type (`EventEmitter`, `Subject`, `Observable`). | `call`, `base-type` |
| `handlers` | Decorators ending in `Handler`, classes implementing a `...Handler` type, handler registration calls, and `send`, `execute`, `dispatch` or `query` on a mediator, command bus or query bus. | `handler-decorator`, `handler-type`, `handler-registration`, `dispatch` |
| `registries` | A map or object named like a registry, handler table, plugin list or strategy table, and `register...` calls that are not container registrations. | `keyed-map`, `register-call` |
| `ports-and-adapters` | Folders named in `structure.census.folderNames` (by default `ports`, `adapters`, `infrastructure`). Folder entries have no line and do not count as files. | `folder` |

## Reading it

- **Zero means not in use here.** The census read every production TypeScript and JavaScript file (`filesRead`). If the mechanism you would choose has a count of zero, it is new to this codebase and the user decides.
- **Count and spread both matter.** One `container.register` call in a single file is not a convention. Many folders using events through one bus is. Look at `folders` before calling something established.
- **The nearest wins.** For one dependency, `nearbyMechanisms` in the evidence pack lists census entries by distance through the folder tree, with `near` saying which side they are closer to. Prefer what is used closest to the boundary you are breaking.
- **Detection is by name and shape.** It knows no framework. A look-alike can be counted, such as a method that happens to be called `on`, and a convention with other names is missed. Read the `examples` before relying on a row, and use `structure.census.eventCalls`, `handlerCalls` and `registerCalls` in `code-health.json` to teach it the codebase's own names.
- **Type annotations are read in TypeScript only.** `callbacks` and constructor injection are not found in plain JavaScript, so a JavaScript codebase can show zero for them while using them. Search the code before concluding.
- **Other languages are not covered yet.** For C# or C++, search for the equivalents: DI container registration and constructor injection, MediatR-style handlers, events and delegates, virtual interfaces and callbacks, signal and slot libraries. Say you searched by hand.

The census does not count tests, excluded paths or files outside the grammars. A mechanism used only in tests is not a mechanism the code uses.
