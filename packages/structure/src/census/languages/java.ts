import type { CensusLanguage } from "../census-language.ts";

/**
 * Java conventions: Spring, Guava and RxJava events, Spring, Jakarta, Guice and Dagger injection, and
 * mediator-style command and query handlers. A functional interface of the JDK is a callback.
 */
export const language: CensusLanguage = {
  id: "java",
  detectors: {
    eventMethods: new Set(["publishEvent", "fireEvent", "emit", "publish", "dispatch", "subscribe", "unsubscribe", "addListener", "removeListener", "addPropertyChangeListener", "firePropertyChange", "notifyObservers", "addObserver"]),
    eventFunctions: new Set(["publishEvent", "fireEvent", "notifyObservers", "setChanged"]),
    platformReceivers: new Set(["System", "Runtime", "Thread", "Platform", "Math"]),
    eventBaseTypes: new Set(["Observable", "PropertyChangeSupport", "EventBus", "AsyncEventBus", "Subject", "BehaviorSubject", "PublishSubject", "ReplaySubject", "ApplicationEventMulticaster", "SimpleApplicationEventMulticaster"]),
    containerReceiver: /(container|injector|beanfactory|applicationcontext|binder|kernel|ioc)$/i,
    containerRegistrations: /^(register\w*|bind\w*|provide\w*|toInstance|toProvider|toConstructor|addSingleton|define\w*)$/,
    injectionDecorators: new Set(["inject", "autowired", "component", "service", "repository", "controller", "restcontroller", "configuration", "bean", "singleton", "named", "provides", "binds", "module", "resource", "qualifier", "primary"]),
    handlerReceiver: /(mediator|commands?|commandbus|commandgateway|quer(y|ies)|querybus|querygateway|requests?|requestbus)$/i,
    handlerMethods: new Set(["send", "execute", "dispatch", "publish", "query", "command", "request", "handle", "sendAndWait", "ask"]),
    handlerRegistration: /^(register\w*Handlers?|addHandler|setHandler|useHandler|subscribeHandler|onCommand|onQuery)$/,
    handlerType: /(Handler|Listener)$/,
    callbackTypeNames: new Set(["Runnable", "Callable", "Supplier", "Consumer", "BiConsumer", "Function", "BiFunction", "Predicate", "BiPredicate", "UnaryOperator", "BinaryOperator", "Callback"]),
  },
};
