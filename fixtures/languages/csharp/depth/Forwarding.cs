class Forwarding
{
    public void Relay(string key) => store.Save(key);

    public void Fixed(string key) { store.Save(key, 1); }

    public int Computed(int x) => store.Find(x + 1);

    public void Early(string key)
    {
        if (key == null) return;
        store.Save(key);
    }

    public Task Wrapped(string key) => Run(key);

    public void Many(string a, string b, string c) { }
}
