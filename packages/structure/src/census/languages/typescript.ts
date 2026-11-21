import type { CensusLanguage } from "../census-language.ts";

/** TypeScript and JavaScript conventions: Node and RxJS events, Nest, Angular and Inversify injection, mediator-style handlers. */
export const language: CensusLanguage = {
  id: "typescript",
  detectors: {
    eventMethods: new Set(["emit", "on", "once", "off", "subscribe", "unsubscribe", "publish", "dispatch", "addListener", "removeListener", "removeAllListeners", "trigger"]),
    eventFunctions: new Set(["emit", "dispatch", "publish", "subscribe", "mitt", "createNanoEvents"]),
    platformReceivers: new Set(["process", "window", "document", "globalThis", "self", "stdin", "stdout", "stderr"]),
    eventBaseTypes: new Set(["EventEmitter", "EventEmitter2", "Emittery", "Subject", "BehaviorSubject", "ReplaySubject", "Observable", "TypedEmitter"]),
    containerReceiver: /(container|injector|kernel|ioc)$/i,
    containerRegistrations: /^(register\w*|bind\w*|provide|addSingleton|addTransient|addScoped|toClass|toConstantValue)$/,
    injectionDecorators: new Set(["injectable", "inject", "module", "ngmodule", "singleton", "autoinjectable", "service", "autowired", "provides"]),
    handlerReceiver: /(mediator|commands?|commandbus|quer(y|ies)|querybus|requests?|requestbus)$/i,
    handlerMethods: new Set(["send", "execute", "dispatch", "publish", "query", "command", "request", "handle"]),
    handlerRegistration: /^(register\w*Handlers?|addHandler|setHandler|useHandler|onCommand|onQuery)$/,
    handlerType: /Handler$/,
    callbackTypeNames: new Set(["Function"]),
  },
};
