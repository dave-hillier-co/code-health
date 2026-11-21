import * as registered from "./registered-languages.ts";

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

export const censusLanguages: readonly CensusLanguage[] = Object.values(registered).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export function censusDetectorsOf(adapterId: string): CensusDetectors {
  const language = censusLanguages.find((candidate) => candidate.id === adapterId);
  if (language === undefined) throw new Error(`structure has no census detectors for the ${adapterId} adapter: add census/languages/${adapterId}.ts and register it`);
  return language.detectors;
}
