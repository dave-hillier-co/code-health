using System;
using static Acme.Shapes.Geometry;

namespace Acme.Shapes
{
    public interface IShape
    {
        double Area();
    }

    public abstract class Shape : IShape
    {
        public abstract double Area();

        public class Builder
        {
            public Shape Build() => null;
        }
    }

    public enum Unit { Meter, Foot }

    public delegate void Resized(Shape shape);

    internal record Circle(double Radius) : Shape
    {
        public override double Area() => Math.PI * Radius * Radius;
    }

    public static class Geometry
    {
        public static double Half(this double value) => value / 2;
    }

    public class Box { }

    public class Box<T> { }
}

namespace Acme.Shapes.Extras
{
    public struct Point { }
}
