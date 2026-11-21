namespace Acme.Registry;

public class HandlerMap
{
    private readonly Dictionary<string, Func<int>> handlers = new();
}
