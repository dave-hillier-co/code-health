using Acme.Handlers;
using Acme.Ports;
using MediatR;

namespace Acme.App;

public class OrderService
{
    private readonly IStore store;
    private readonly IMediator mediator;

    public OrderService(IStore store, IMediator mediator)
    {
        this.store = store;
        this.mediator = mediator;
    }

    public void Place(string key)
    {
        store.Save(key);
        mediator.Send(new PlaceOrder(key));
    }
}
