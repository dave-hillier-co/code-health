using Acme.Ports;

namespace Acme.App;

public class Audit
{
    [Inject]
    public IStore Store { get; set; }
}
