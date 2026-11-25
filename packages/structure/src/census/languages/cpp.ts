import type { CensusLanguage } from "../census-language.ts";

/**
 * C++ conventions: virtual interfaces and abstract classes (judged from the declarations, so no names are
 * listed for them), `std::function` and function-pointer callbacks, Qt, Boost.Signals2 and sigslot signals and
 * slots, observer-style `notify` and `subscribe` calls, Boost.DI and similar injection macros and attributes,
 * and mediator-style handlers.
 */
export const language: CensusLanguage = {
  id: "cpp",
  detectors: {
    eventMethods: new Set(["emit", "connect", "disconnect", "notify", "notifyAll", "subscribe", "unsubscribe", "publish", "dispatch", "fire", "trigger", "addListener", "removeListener"]),
    eventFunctions: new Set(["emit", "connect", "dispatch", "publish", "subscribe", "notify"]),
    listenMethods: new Set(["connect", "disconnect", "subscribe", "unsubscribe", "addListener", "removeListener"]),
    platformReceivers: new Set(["std", "boost", "this", "cin", "cout", "cerr", "clog", "stdin", "stdout", "stderr"]),
    eventBaseTypes: new Set(["QObject", "QWidget", "QAbstractItemModel", "has_slots", "trackable", "Observable", "Subject", "EventEmitter"]),
    containerReceiver: /(container|injector|kernel|ioc)$/i,
    containerRegistrations: /^(register\w*|bind\w*|provide|add_singleton|addSingleton|addTransient|add_transient)$/,
    injectionDecorators: new Set(["boost_di_inject", "boost_di_inject_traits", "boost_di_ctor", "inject", "injectable", "q_inject", "provides", "autowired", "singleton"]),
    handlerReceiver: /(mediator|commands?|commandbus|quer(y|ies)|querybus|requests?|requestbus)$/i,
    handlerMethods: new Set(["send", "execute", "dispatch", "publish", "query", "command", "request", "handle"]),
    handlerRegistration: /^(register\w*Handlers?|addHandler|setHandler|useHandler|onCommand|onQuery|add_handler|set_handler)$/,
    handlerType: /Handler$/,
    callbackTypeNames: new Set(["function", "function_ref", "move_only_function"]),
  },
};
