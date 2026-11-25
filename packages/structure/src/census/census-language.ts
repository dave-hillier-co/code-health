/**
 * What the census judges a language's syntactic facts against: the conventions of its ecosystem for events,
 * dependency injection, handlers and callbacks. Names are matched against what the adapter's census
 * extraction read (`FileCensus`), so they are data. A language is one file in `languages/<id>.ts` and one
 * line in `registered-languages.ts`. The `id` is the adapter's.
 */
export interface CensusDetectors {
  /** Method names that mean an event on a receiver (`bus.emit`). */
  eventMethods: ReadonlySet<string>;
  /** Names that mean an event when called on their own, not only on a receiver. */
  eventFunctions: ReadonlySet<string>;
  /**
   * The event names that register or remove a listener (`on`, `subscribe`). The other event names send. A
   * send name the repository defines only on types and files that have none of these, and no event base
   * type, is a look-alike: a call runs that code and notifies no listener.
   */
  listenMethods: ReadonlySet<string>;
  /** Receivers that are the runtime or the platform, whose `on` is not the codebase's own events. */
  platformReceivers: ReadonlySet<string>;
  /** Base types that make a class an event source. */
  eventBaseTypes: ReadonlySet<string>;
  /** A receiver that looks like a dependency injection container, and the calls on it that register. */
  containerReceiver: RegExp;
  containerRegistrations: RegExp;
  /** Decorators or attributes that mark injection, lower case. */
  injectionDecorators: ReadonlySet<string>;
  /** A receiver that looks like a command or query bus, and the methods that dispatch on it. */
  handlerReceiver: RegExp;
  handlerMethods: ReadonlySet<string>;
  /** Calls that register a handler. */
  handlerRegistration: RegExp;
  /** Type and decorator names that mark a handler. */
  handlerType: RegExp;
  /** Type names that mean any callable, without a declaration to resolve. */
  callbackTypeNames: ReadonlySet<string>;
}

export interface CensusLanguage {
  id: string;
  detectors: CensusDetectors;
}
