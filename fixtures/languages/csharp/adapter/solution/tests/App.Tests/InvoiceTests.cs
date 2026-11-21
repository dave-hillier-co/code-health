using Acme.App.Billing;
using Acme.Core;

namespace Acme.App.Tests;

public class InvoiceTests
{
    public void Total()
    {
        var invoice = new Invoice(Money.Zero);
    }
}
