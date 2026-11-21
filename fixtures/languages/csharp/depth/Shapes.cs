using System;

public class Shapes
{
    private int secret;
    public int Width;
    internal int Height, Depth;
    protected string Label { get; set; }

    public Shapes(int width, int height) { }

    private Shapes(string label) { }

    public string Describe() => Label;

    private void Hidden() { }
}

public interface ISized
{
    int Size { get; }

    void Resize(int delta);
}

public enum Level { Low, Mid, High }

public record Pair(int Left, int Right)
{
    public int Sum => Left + Right;
}
