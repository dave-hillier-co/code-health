namespace Acme.Core;

public readonly struct Money
{
    public decimal Amount { get; }

    public Money(decimal amount) => Amount = amount;

    public static Money Zero => new Money(0);
}
