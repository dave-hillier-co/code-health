using System.ComponentModel;

namespace Acme.Events;

public class OrderEvents : INotifyPropertyChanged
{
    public event EventHandler Placed;
    public event PropertyChangedEventHandler PropertyChanged;

    public void Raise()
    {
        Placed?.Invoke(this, EventArgs.Empty);
    }
}
