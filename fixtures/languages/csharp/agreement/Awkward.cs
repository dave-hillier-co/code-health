using System;
using System.Collections.Generic;
using System.Linq;

namespace Fixtures.Agreement
{
    public class Awkward<T> where T : class
    {
        private readonly Dictionary<string, Func<int, int>> handlers = new()
        {
            ["double"] = x => x * 2,
            ["square"] = x =>
            {
                return x * x;
            },
        };

        [Obsolete("use Run")] public void Legacy() { Run(); }

        public void Run()
        {
            var braces = "{ not a block }";
            var verbatim = @"C:\temp\{0}";
            var raw = """
                { "json": [1, 2, 3] }
                """;
            var interpolated = $"{braces} and {verbatim}";
            var chars = new[] { '{', '}', '"' };
            Console.WriteLine(interpolated + raw + chars.Length);
        }

        public int Compute(IEnumerable<int> items) =>
            items
                .Where(item => item > 0)
                .Select(item => item * 2)
                .Sum();

        public string Describe(int n) => n switch
        {
            0 => "zero",
            _ => "many",
        };

        public class Nested
        {
            public int Value { get; set; }

            public Nested(int value) : this()
            {
                Value = value;
            }

            public Nested() { }

            public override string ToString() => $"Nested({Value})";
        }

        public int Prop
        {
            get
            {
                return Compute(Enumerable.Empty<int>());
            }
            set
            {
                if (value < 0)
                {
                    throw new ArgumentOutOfRangeException(nameof(value));
                }
            }
        }

        public async System.Threading.Tasks.Task<int> Later(int ms)
        {
            await System.Threading.Tasks.Task.Delay(ms);
            return ms;
        }

#if DEBUG
        public void Trace() { Console.WriteLine("debug"); }
#else
        public void Trace() { }
#endif

        public IEnumerable<int> Count(int upTo)
        {
            for (var i = 0; i < upTo; i++)
            {
                yield return i;
            }
        }

        public void Locals()
        {
            int Twice(int x) => x * 2;
            static int Thrice(int x)
            {
                return x * 3;
            }
            Console.WriteLine(Twice(1) + Thrice(2));
        }

        public static bool operator ==(Awkward<T> left, Awkward<T> right) => ReferenceEquals(left, right);

        public static bool operator !=(Awkward<T> left, Awkward<T> right)
        {
            return !(left == right);
        }

        public override bool Equals(object obj) { return base.Equals(obj); }

        public override int GetHashCode() { return 0; }
    }

    public interface IVisitor<TResult>
    {
        TResult Visit(string node);

        TResult Visit(int node) => default;
    }

    public static class Extensions
    {
        public static IEnumerable<T> Twice<T>(this IEnumerable<T> source)
        {
            foreach (var item in source)
            {
                yield return item;
                yield return item;
            }
        }
    }
}
