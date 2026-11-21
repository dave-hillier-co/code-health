namespace Acme.Core;

public partial class Ledger
{
    public bool IsBalanced() => total == 0;
}
