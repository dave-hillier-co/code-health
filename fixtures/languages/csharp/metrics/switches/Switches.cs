namespace Fixtures.Metrics;

public class Switches
{
    public string Statement(int n)
    {
        switch (n)
        {
            case 1:
            case 2:
                return "low";
            case 3:
                return "mid";
            default:
                return "high";
        }
    }

    public string Expression(int n)
    {
        return n switch
        {
            1 => "one",
            2 or 3 => "few",
            > 3 and < 10 => "some",
            _ => "many",
        };
    }

    public int Guarded(object o, bool strict)
    {
        var size = o switch
        {
            int i when i > 100 => 2,
            int => 1,
            string s when strict && s.Length > 0 => 3,
            _ when strict => 4,
            _ => 0,
        };
        return size;
    }

    public int NestedInIf(int n, int m)
    {
        if (n > 0)
        {
            switch (m)
            {
                case 0:
                    return 0;
                case 1:
                    return n;
            }
        }
        return m switch { 0 => 1, _ => 2 };
    }

    public bool Patterns(object o)
    {
        return o is int or long or short && o is not null;
    }
}
