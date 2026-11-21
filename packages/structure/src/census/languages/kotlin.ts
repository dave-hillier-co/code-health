import type { CensusLanguage } from "../census-language.ts";

/**
 * Kotlin conventions: Spring, Hilt, Dagger and Koin injection, Kotlin and RxJava event streams, and
 * mediator-style handlers. Function types are callbacks on their own, and the JDK's functional interfaces are
 * named here.
 */
export const language: CensusLanguage = {
  id: "kotlin",
  detectors: {
    eventMethods: new Set(["publishEvent", "emit", "tryEmit", "publish", "dispatch", "subscribe", "unsubscribe", "addListener", "removeListener"]),
    eventFunctions: new Set(["publishEvent", "emit", "tryEmit"]),
    platformReceivers: new Set(["System", "Runtime", "Thread", "Platform", "Math"]),
    eventBaseTypes: new Set(["Observable", "PropertyChangeSupport", "EventBus", "Subject", "BehaviorSubject", "PublishSubject", "ReplaySubject", "MutableSharedFlow", "MutableStateFlow", "Channel", "BroadcastChannel"]),
    containerReceiver: /(container|injector|beanfactory|applicationcontext|binder|kernel|koin|ioc)$/i,
    containerRegistrations: /^(register\w*|bind\w*|provide\w*|single|factory|define\w*|loadModules)$/,
    injectionDecorators: new Set(["inject", "autowired", "component", "service", "repository", "controller", "restcontroller", "configuration", "bean", "singleton", "named", "provides", "binds", "module", "resource", "qualifier", "primary", "hiltandroidapp", "androidentrypoint", "hiltviewmodel"]),
    handlerReceiver: /(mediator|commands?|commandbus|commandgateway|quer(y|ies)|querybus|querygateway|requests?|requestbus)$/i,
    handlerMethods: new Set(["send", "execute", "dispatch", "publish", "query", "command", "request", "handle", "sendAndWait", "ask"]),
    handlerRegistration: /^(register\w*Handlers?|addHandler|setHandler|useHandler|subscribeHandler|onCommand|onQuery)$/,
    handlerType: /(Handler|Listener)$/,
    callbackTypeNames: new Set(["Runnable", "Callable", "Supplier", "Consumer", "BiConsumer", "Function", "BiFunction", "Predicate", "BiPredicate", "UnaryOperator", "BinaryOperator", "Callback"]),
  },
};
