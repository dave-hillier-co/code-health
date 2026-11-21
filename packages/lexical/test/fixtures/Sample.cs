using System;

namespace Shop
{
    public class Cart
    {
        [Obsolete("old")]
        public int Count(int[] xs, bool all)
        {
            var n = 0;
            foreach (var x in xs)
            {
                if (all || x > 0)
                {
                    n += x;
                }
            }
            var s = @"raw { ""q"" }
if (z) {";
            return n;
        }

        public string Name() => "cart";

        public Cart(int seed) : this()
        {
            Seed = seed; // set
        }
    }
}
