namespace Fixtures.Metrics;

public class Operators
{
    public bool Access(bool a, bool b, bool c, bool d, bool e)
    {
        if (a && b && c || d || e)
        {
            return !(a && b) || (c && d);
        }
        return (a ? b : c) ? d : e;
    }

    public string Pick(Person person)
    {
        return person?.Address?.City ?? "unknown";
    }

    public string Assign(string name, string fallback)
    {
        name ??= fallback;
        name ??= "none";
        return name;
    }

    public bool Mixed(object o, int limit)
    {
        return o is string { Length: > 0 } text && (text.Length < limit || text.StartsWith("x"));
    }

    public bool Negated(object o)
    {
        return o is not null and not int;
    }
}

public class Person
{
    public Address Address { get; set; }
}

public class Address
{
    public string City { get; set; }
}
