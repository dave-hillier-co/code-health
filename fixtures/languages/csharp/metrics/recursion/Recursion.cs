namespace Fixtures.Metrics;

public class Recursion
{
    public int Factorial(int n)
    {
        if (n <= 1)
        {
            return 1;
        }
        return n * Factorial(n - 1);
    }

    public int Overloaded(int n)
    {
        return Overloaded(n, 0);
    }

    public int Overloaded(int n, int offset)
    {
        return n + offset;
    }

    public int Walk(int depth)
    {
        return depth == 0 ? 0 : this.Walk(depth - 1) + Recursion.Helper(depth) + Walk(depth - 2);
    }

    public static int Helper(int depth)
    {
        int Countdown(int steps)
        {
            return steps == 0 ? 0 : Countdown(steps - 1);
        }
        return Countdown(depth);
    }
}
