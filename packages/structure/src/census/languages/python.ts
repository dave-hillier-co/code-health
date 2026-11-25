import type { CensusLanguage } from "../census-language.ts";

/**
 * Python conventions: pyee, blinker and Django signals, pubsub libraries, `dependency_injector`, `injector` and
 * `punq` containers, mediator and message-bus handlers. `connect` is left out of the event methods because
 * sockets and databases use it too.
 */
export const language: CensusLanguage = {
  id: "python",
  detectors: {
    eventMethods: new Set(["emit", "send", "send_robust", "asend", "on", "once", "off", "subscribe", "unsubscribe", "publish", "dispatch", "trigger", "fire", "add_listener", "remove_listener", "remove_all_listeners"]),
    eventFunctions: new Set(["emit", "dispatch", "publish", "subscribe", "signal"]),
    listenMethods: new Set(["on", "once", "off", "subscribe", "unsubscribe", "add_listener", "remove_listener", "remove_all_listeners", "connect", "disconnect"]),
    platformReceivers: new Set(["sys", "os", "signal", "socket", "sock", "conn", "connection", "ws", "websocket", "asyncio", "loop", "subprocess", "logging", "logger", "stdin", "stdout", "stderr", "process", "proc", "pipe", "queue", "writer", "stream"]),
    eventBaseTypes: new Set(["EventEmitter", "AsyncIOEventEmitter", "ExecutorEventEmitter", "TwistedEventEmitter", "Signal", "NamedSignal", "Subject", "BehaviorSubject", "ReplaySubject", "Observable"]),
    containerReceiver: /(container|injector|binder|kernel|ioc)$/i,
    containerRegistrations: /^(register\w*|bind\w*|provide|provider|override|wire|add_singleton|add_transient|add_scoped|singleton|factory|constant|to_class|to_instance)$/,
    injectionDecorators: new Set(["injectable", "inject", "singleton", "provider", "service", "autowired", "provides", "component"]),
    handlerReceiver: /(mediator|commands?|command_?bus|quer(y|ies)|query_?bus|requests?|request_?bus|message_?bus)$/i,
    handlerMethods: new Set(["send", "execute", "dispatch", "publish", "query", "command", "request", "handle", "ask", "invoke"]),
    handlerRegistration: /^(register_(\w+_)?handlers?|add_handler|set_handler|use_handler|on_command|on_query|subscribe_handler)$/,
    handlerType: /(Handler|_handler|^handler)$/,
    callbackTypeNames: new Set(["Callable"]),
  },
};
