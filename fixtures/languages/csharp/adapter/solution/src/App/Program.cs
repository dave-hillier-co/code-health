using Acme.App.Billing;

namespace Acme.App;

public static class Program
{
    public static int Main()
    {
        var invoice = new Invoice(Money.Zero);
        var ledger = new Ledger();
        ledger.Add(invoice.Total);
        return 0;
    }
}
