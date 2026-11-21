using Acme.Shapes;
using Acme.Shapes.Extras;

namespace Acme.Client;

[Serializable]
public class Drawing : Shape
{
    private Shape.Builder builder;
    private Acme.Shapes.Extras.Point origin;
    private Box<Unit> boxed;

    public void Resize(Resized callback)
    {
        callback(this);
        var half = 4.0.Half();
    }
}
