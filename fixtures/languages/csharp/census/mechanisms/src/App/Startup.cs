using Acme.Adapters;
using Acme.Ports;
using Microsoft.Extensions.DependencyInjection;

namespace Acme.App;

public static class Startup
{
    public static void Configure(IServiceCollection services)
    {
        services.AddScoped<IStore, MemoryStore>();
        services.AddMediatR(config => config.RegisterServicesFromAssembly(typeof(Startup).Assembly));
    }
}
