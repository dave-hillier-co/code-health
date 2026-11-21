namespace Acme.Core;

public partial class Ledger
{
    private readonly List<Money> entries = new();

    public void Add(Money money)
    {
        entries.Add(money);
    }
}
