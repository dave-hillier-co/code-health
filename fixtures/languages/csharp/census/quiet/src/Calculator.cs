namespace Quiet;

public static class Calculator
{
    public static int Add(int a, int b) => a + b;

    public static int Twice(int value)
    {
        return Add(value, value);
    }
}
