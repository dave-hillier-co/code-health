using MediatR;

namespace Acme.Handlers;

public record PlaceOrder(string Key) : IRequest<int>;

public class PlaceOrderHandler : IRequestHandler<PlaceOrder, int>
{
    public Task<int> Handle(PlaceOrder request, CancellationToken cancellationToken)
    {
        return Task.FromResult(1);
    }
}
