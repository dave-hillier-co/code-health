namespace Acme.Core;

public partial class Ledger
{
    public bool IsBalanced(IClock clock)
    {
        return clock.Now() > DateTime.MinValue;
    }
}
