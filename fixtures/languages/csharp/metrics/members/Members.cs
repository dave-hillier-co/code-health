using System;
using System.Collections.Generic;

namespace Fixtures.Metrics
{
    public class Members
    {
        private readonly List<int> values = new List<int>();
        private int cached;

        public Members(int seed, int step = 1)
        {
            if (step > 0)
            {
                values.Add(seed);
            }
        }

        ~Members()
        {
            values.Clear();
        }

        public int Count => values.Count;

        public int Cached
        {
            get
            {
                if (cached == 0)
                {
                    cached = values.Count;
                }
                return cached;
            }
            set => cached = value;
        }

        public int this[int index]
        {
            get { return values[index]; }
        }

        public static Members operator +(Members left, Members right)
        {
            var sum = new Members(0);
            sum.values.AddRange(left.values);
            sum.values.AddRange(right.values);
            return sum;
        }

        public static implicit operator int(Members members) => members.values.Count;

        public int Total(params int[] extra)
        {
            int Plus(int a, int b)
            {
                return a > b ? a : b;
            }

            var best = 0;
            foreach (var value in values)
            {
                best = Plus(best, value);
            }
            return best + extra.Length;
        }

        public IEnumerable<int> Evens()
        {
            return values.FindAll(value =>
            {
                if (value % 2 == 0)
                {
                    return true;
                }
                return false;
            });
        }

        public T First<T>(Func<T, bool> predicate, T fallback) where T : class
        {
            Func<T, T> same = delegate (T item) { return item; };
            return predicate(fallback) ? same(fallback) : fallback;
        }

        public int Twice(int x) => x * 2;
    }
}
