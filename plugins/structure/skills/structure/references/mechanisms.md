# The mechanism census

`structure census --json` inventories how the codebase already separates one piece of code from another. It describes and does not judge: it never says a mechanism is good, and a count of zero is a finding, because choosing a mechanism the codebase does not use is introducing something new.

There is one row per mechanism, always in this order, including the ones with a count of zero. Each row has `count`, `files`, `variants` (the forms found), `folders` (the folders involved, most first), up to three `examples` with the path, line and what was found, and `lookAlikes`: the calls that matched the mechanism's names and were left out of `count`, one entry per name with the calls left out (`count`), how many types and files define the name (`definitions`) and why (`detail`).

## What each row counts

| Mechanism | What is counted | Variants |
|---|---|---|
| `callbacks` | A function with a function-typed parameter that is called from a different folder. The parameter may be an inline function type, an alias of one in the same file or another, or a generic parameter bounded by one (in Rust, `F: Fn(..)` in the function's or its `impl`'s list or where clause). A method counts when its type is used from a different folder, because the dependency graph does not resolve which method a call reaches. | `function-parameter` |
| `interfaces` | An interface or abstract class that a class in a different folder implements or extends. One entry per interface, naming the folders of its implementers. | `interface` |
| `dependency-injection` | Injection decorators (`@Injectable`, `@Inject`, `@Module`, `@Singleton` and similar), registration calls on something named like a container, injector, kernel or ioc, and a constructor that takes an interface or abstract class declared in another folder. | `decorator`, `container-registration`, `constructor-injection` |
| `events` | `emit`, `on`, `once`, `off`, `subscribe`, `publish`, `dispatch`, `trigger` and listener calls, with the platform's own emitters left out (`process.on`, `window.on`), and classes or `new` expressions of an event-emitter type (`EventEmitter`, `Subject`, `Observable`). A send call (`emit`, `publish`, `notify` and the like) is left out, and listed under `lookAlikes`, when the repository defines that name only on types and files that have no listen method (`on`, `subscribe`, `add_listener`) and no event-emitter base type: the call runs the repository's own code and notifies no listener, as a telemetry or logging `emit` does. | `call`, `base-type` |
| `handlers` | Decorators ending in `Handler`, classes implementing a `...Handler` type, handler registration calls, and `send`, `execute`, `dispatch` or `query` on a mediator, command bus or query bus. | `handler-decorator`, `handler-type`, `handler-registration`, `dispatch` |
| `registries` | A map or object named like a registry, handler table, plugin list or strategy table, and `register...` calls that are not container registrations. | `keyed-map`, `register-call` |
| `ports-and-adapters` | Folders named `ports`, `adapters` or `infrastructure`, plus any named in `structure.census.folderNames`. Folder entries have no line and do not count as files. | `folder` |

## Reading it

- **Zero means not in use here.** The census read every production file in a supported language (`filesRead`). If the mechanism you would choose has a count of zero, it is new to this codebase and the user decides.
- **Count and spread both matter.** One `container.register` call in a single file is not a convention. Many folders using events through one bus is. Look at `folders` before calling something established.
- **The nearest wins.** For one dependency, `nearbyMechanisms` in the evidence pack lists the census entries in the package (crate, workspace member, project) of either side first (`samePackage`), then the rest, each group by distance through the folder tree, with `near` saying which side they are closer to. Repeats of one entry in one folder are listed once, with their `count`. Prefer what is used closest to the boundary you are breaking, inside its own package before another.
- **Detection is by name and shape.** It knows no framework. A look-alike can be counted, such as a method that happens to be called `on`, and a convention with other names is missed. `lookAlikes` lists the send calls left out because nothing in the repository listens to them; when one of them is an event mechanism after all, such as a publisher whose subscribers register through attributes, name it in `structure.census.eventCalls`, which is always counted. Read the `examples` before relying on a row, and use `structure.census.eventCalls`, `handlerCalls` and `registerCalls` in `code-health.json` to teach it the codebase's own names.
- **Type annotations are read where the language has them.** `callbacks` and constructor injection are not found in plain JavaScript or in Python written without type hints, so such a codebase can show zero for them while using them. Search the code before concluding.
- **Other languages are not covered.** For a language with no adapter, search for the equivalents: DI container registration and constructor injection, handlers behind a mediator, events and delegates, interfaces and callbacks, signal and slot libraries. Say you searched by hand.

The census does not count tests, excluded paths or files outside the grammars. A mechanism used only in tests is not a mechanism the code uses.
