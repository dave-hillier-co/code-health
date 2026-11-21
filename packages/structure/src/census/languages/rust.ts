import type { CensusLanguage } from "../language.ts";

/**
 * Rust conventions: events through `emit`, `publish` and `subscribe` and the broadcast channels of tokio and
 * crossbeam, trait objects as the injected interfaces, containers of the shaku and `inject` families, and
 * mediator-style command handlers. Names are snake case, so method names are matched as written.
 */
export const language: CensusLanguage = {
  id: "rust",
  detectors: {
    eventMethods: new Set(["emit", "on", "subscribe", "unsubscribe", "publish", "dispatch", "notify", "trigger", "add_listener", "remove_listener", "add_observer", "remove_observer", "broadcast"]),
    eventFunctions: new Set(["emit", "dispatch", "publish", "subscribe", "notify"]),
    platformReceivers: new Set(["io", "stdin", "stdout", "stderr", "process", "env", "std", "tokio", "signal"]),
    eventBaseTypes: new Set(["EventEmitter", "EventSource", "Observable", "Subject", "Publisher", "Subscriber", "EventListener", "Observer"]),
    containerReceiver: /(container|injector|ioc|provider|services|module)$/i,
    containerRegistrations: /^(register\w*|bind\w*|provide\w*|add_singleton|add_transient|add_scoped|add_service|with_component|with_service)$/,
    injectionDecorators: new Set(["injectable", "inject", "component", "interface", "provider", "service", "shaku", "autowired"]),
    handlerReceiver: /(mediator|commands?|command_bus|commandbus|quer(y|ies)|query_bus|querybus|requests?|request_bus|requestbus|dispatcher)$/i,
    handlerMethods: new Set(["send", "execute", "dispatch", "publish", "query", "command", "request", "handle"]),
    handlerRegistration: /^(register_\w*handlers?|add_handler|set_handler|use_handler|with_handler|on_command|on_query)$/,
    handlerType: /Handler$/,
    callbackTypeNames: new Set(["Fn", "FnMut", "FnOnce"]),
  },
};
