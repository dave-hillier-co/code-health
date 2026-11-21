namespace Fixtures.MetricsWide;

public class Jumps
{
    public int Countdown(int n)
    {
        return this.Countdown(n - 1);
    }

    public int Search(int[][] rows)
    {
        foreach (var row in rows)
        {
            if (row.Length > 1)
            {
                goto done;
            }
        }
    done:
        return 0;
    }
}
