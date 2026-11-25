import type { CensusLanguage } from "../census-language.ts";

/**
 * C# conventions: .NET events (a `Changed?.Invoke(...)` on an event the file declares, `INotifyPropertyChanged`,
 * Rx subjects), the Microsoft, Autofac, Ninject and MEF injection vocabularies, and MediatR-style handlers
 * (`IRequestHandler<,>`, `INotificationHandler<>`, `mediator.Send`, `AddMediatR`).
 */
export const language: CensusLanguage = {
  id: "csharp",
  detectors: {
    eventMethods: new Set(["Invoke", "Raise", "RaiseEvent", "Publish", "Emit", "Notify", "Trigger", "OnNext", "Subscribe", "Unsubscribe", "Dispatch"]),
    eventFunctions: new Set(["RaiseEvent", "OnPropertyChanged", "RaisePropertyChanged", "NotifyPropertyChanged"]),
    listenMethods: new Set(["Subscribe", "Unsubscribe"]),
    platformReceivers: new Set(["Console", "Environment", "AppDomain", "Task", "Thread", "Debug", "Trace"]),
    eventBaseTypes: new Set([
      "INotifyPropertyChanged",
      "INotifyPropertyChanging",
      "INotifyCollectionChanged",
      "INotification",
      "IObservable",
      "ISubject",
      "Subject",
      "BehaviorSubject",
      "ReplaySubject",
      "AsyncSubject",
    ]),
    containerReceiver: /(services|serviceCollection|container|containerBuilder|kernel|injector|ioc)$/i,
    containerRegistrations: /^(Register\w*|Bind\w*|AddSingleton|AddTransient|AddScoped|AddKeyed\w+|TryAdd\w+|AddInstance)$/,
    injectionDecorators: new Set(["inject", "fromservices", "fromkeyedservices", "import", "importmany", "importingconstructor", "export", "dependency", "injectionconstructor", "autowired"]),
    handlerReceiver: /(mediator|sender|publisher|dispatcher|commands?|commandbus|quer(y|ies)|querybus|requests?|requestbus)$/i,
    handlerMethods: new Set(["Send", "SendAsync", "Publish", "PublishAsync", "Execute", "ExecuteAsync", "Dispatch", "DispatchAsync", "Handle", "Query", "QueryAsync", "Command", "Request", "CreateStream"]),
    handlerRegistration: /^(AddMediatR|AddHandler\w*|AddRequestHandler|AddNotificationHandler|MapHandler\w*)$/,
    handlerType: /Handler$/,
    callbackTypeNames: new Set(["Action", "Func", "Predicate", "Comparison", "Converter", "Delegate", "MulticastDelegate"]),
  },
};
