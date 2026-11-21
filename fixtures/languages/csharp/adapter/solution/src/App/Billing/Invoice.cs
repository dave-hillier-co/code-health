using Money = Acme.Core.Money;

namespace Acme.App.Billing
{
    internal sealed class Invoice
    {
        public Invoice(Money total)
        {
            Total = total;
        }

        public Money Total { get; }
    }
}
