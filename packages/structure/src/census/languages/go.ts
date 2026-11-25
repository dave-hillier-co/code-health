import type { CensusLanguage } from "../census-language.ts";

/**
 * Go conventions. Exported methods are capitalised, so both spellings are listed where code in the same
 * package may call an unexported helper. Events are channels and publish/subscribe libraries, injection is
 * done by constructors (the census reads `New...` functions) and by wire, dig, fx and struct-tag injectors, and
 * handlers are registered on routers and muxes (`HandleFunc`) or dispatched through a mediator or bus.
 */
export const language: CensusLanguage = {
  id: "go",
  detectors: {
    eventMethods: new Set(["Emit", "emit", "Publish", "publish", "Subscribe", "subscribe", "Unsubscribe", "unsubscribe", "Dispatch", "dispatch", "Trigger", "trigger", "On", "Once", "Off", "AddListener", "RemoveListener", "Notify", "NotifyAll"]),
    eventFunctions: new Set(["Emit", "Publish", "Subscribe", "Dispatch", "NewEventBus", "NewBroker"]),
    listenMethods: new Set(["Subscribe", "subscribe", "Unsubscribe", "unsubscribe", "On", "Once", "Off", "AddListener", "RemoveListener"]),
    platformReceivers: new Set(["signal", "os", "runtime", "http", "log", "fmt", "testing", "flag", "context", "time", "sync", "atomic"]),
    eventBaseTypes: new Set(["EventBus", "Bus", "Broker", "EventEmitter", "Emitter", "Dispatcher", "PubSub", "Observable", "Subject"]),
    containerReceiver: /^(container|injector|wire|dig|fx|app|kernel|ioc)$/i,
    containerRegistrations: /^(Provide|Supply|Invoke|Bind|Build|NewSet|Annotate|Register\w*|Singleton|Transient|Decorate|Populate)$/,
    injectionDecorators: new Set(["inject", "wire", "autowire", "di", "dig", "name", "optional"]),
    handlerReceiver: /(mediator|commands?|commandbus|quer(y|ies)|querybus|requests?|requestbus)$/i,
    handlerMethods: new Set(["Send", "Execute", "Dispatch", "Publish", "Query", "Command", "Request", "Handle", "Do"]),
    handlerRegistration: /^(HandleFunc|Handle|Register\w*Handlers?|AddHandler|SetHandler|UseHandler|OnCommand|OnQuery|MustRegister\w*Handler)$/,
    handlerType: /(Handler|HandlerFunc)$/,
    callbackTypeNames: new Set(["HandlerFunc", "Func", "Callback"]),
  },
};
