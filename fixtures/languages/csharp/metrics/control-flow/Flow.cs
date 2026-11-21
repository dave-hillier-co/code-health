namespace Fixtures.Metrics;

public class Flow
{
    public int Straight(int a, int b)
    {
        var sum = a + b;
        return sum;
    }

    public string Classify(int n)
    {
        if (n < 0)
        {
            return "negative";
        }
        else if (n == 0)
        {
            return "zero";
        }
        else
        {
            return "positive";
        }
    }

    public int Loops(int[] items)
    {
        var total = 0;
        for (var i = 0; i < items.Length; i++)
        {
            if (items[i] % 2 == 0)
            {
                continue;
            }
            total += items[i];
        }
        foreach (var item in items)
        {
            while (item > total)
            {
                total++;
            }
        }
        do
        {
            total--;
        } while (total > 100);
        return total;
    }

    public int Guarded(int a, bool flag)
    {
        try
        {
            if (flag)
            {
                return a / 2;
            }
        }
        catch (DivideByZeroException)
        {
            return -1;
        }
        finally
        {
            Cleanup();
        }
        return flag ? a : 0;
    }

    private void Cleanup()
    {
    }

    public int Nested(int a, int b, int c)
    {
        if (a > 0)
        {
            if (b > 0)
            {
                if (c > 0)
                {
                    return 3;
                }
                return 2;
            }
            return 1;
        }
        return 0;
    }
}
