package depth;

import java.util.List;

// The interface of a class is its constructor parameters and the members a user can reach.
public class Shapes {
    private final List<String> names;
    public int limit;
    int a, b;

    public Shapes(List<String> names, int limit) {
        this.names = names;
        this.limit = limit;
    }

    public String first() {
        return names.get(0);
    }

    private void secret() {
    }

    protected int size() {
        return names.size();
    }

    public void save(String key, int value) {
        store.save(key, value);
    }
}

interface Store {
    void save(String key, int value);

    int load(String key);
}
